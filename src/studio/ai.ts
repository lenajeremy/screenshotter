/**
 * AI Edit: turn a plain-language instruction ("tilt the phone and make the title bigger") into a
 * small, validated change to the scene.
 *
 * Claude returns a list of JSON-pointer operations instead of a whole new scene, so everything it
 * wasn't asked to touch stays byte-for-byte the same. Local file paths never leave the machine:
 * they're swapped for `asset:N` tokens before the request and swapped back afterwards, and an
 * operation can only point at a token it was given.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEVICE_MODELS, GENERIC_COLORS } from "../devices/catalog.js";
import { CANVAS_PRESETS } from "../render/layouts.js";
import { LOOKS } from "../render/looks.js";
import { createMockup, layoutScene } from "../render/mockup.js";
import { storyboard } from "../render/video.js";
import { sequenceStoryboard, TRANSITIONS, type SequenceInput } from "../render/sequence.js";
import { timelineEnd } from "../render/animate.js";
import { cacheDir } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { DESIGN_GUIDE } from "../design/guide.js";
import { screenshotPalette } from "../render/analyze.js";
import { pendingBackdrop } from "../render/background.js";
import { availableImageProvider } from "../render/photos.js";
import { listBezels } from "../render/bezels.js";
import { recognizeText } from "../native/ocr.js";
import { houseStyle, updateHouseStyle } from "../util/style.js";
import { GRADES, LAYOUTS, MockupInputSchema, type MockupInput } from "../render/schema.js";

export const DEFAULT_EDIT_MODEL = "claude-opus-5-5";

export const AIEditSchema = z.object({
  request: MockupInputSchema,
  instruction: z.string().trim().min(1, "Describe the change you want").max(4000),
  /** Entity the user has selected on the canvas ("device-1", "caption", "text-2"), for "make this bigger". */
  selection: z.string().max(40).optional(),
  model: z.string().max(100).optional(),
  /** Which AI does the work: Claude (an API key, else Claude Code) or Codex. Default Claude. */
  engine: z.enum(["claude", "codex"]).optional(),
  /** Show Claude a quick render of the current design along with its settings. Default true. */
  preview: z.boolean().optional(),
  /** Earlier turns of this chat: what the user said and what Claude replied. */
  history: z
    .array(z.object({ user: z.string().max(4000), assistant: z.string().max(4000).optional() }))
    .max(40)
    .optional(),
  /**
   * A video of several shots: every shot (each a scene, its length and how it comes in), and which
   * one is on the canvas (whose scene is `request`, as it is now). Claude sees and edits them all.
   */
  shots: z.array(z.object({ scene: MockupInputSchema, length: z.number().min(0.5).max(60).optional(), transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0).max(3).optional() }).optional(), name: z.string().max(80).optional(), video: z.boolean().optional() })).min(2).max(20).optional(),
  shot: z.number().int().min(0).max(19).optional(),
});
export type AIEditInput = z.infer<typeof AIEditSchema>;

export const OperationSchema = z.object({
  op: z
    .enum(["set", "remove", "append", "insert", "copy", "move"])
    .describe("set: create or replace the value at path. remove: delete it. append: push value onto the array at path. insert: put value into the list at path's index, moving the rest along. copy / move: copy or move what's at `from` to path (at a list index it's inserted there); value is ignored."),
  path: z.string().describe('JSON pointer into the scene, e.g. "/devices/0/x", "/background", "/texts" (in a video of several shots, "/shots/1/headline").'),
  value: z.string().describe('The new value encoded as JSON, e.g. "0.42", "\\"#ff5500\\"", "{\\"look\\":\\"dusk\\"}". Use "null" for remove, copy and move.'),
  from: z.string().optional().describe('copy and move only: where it comes from, e.g. "/shots/0" (a whole shot) or "/shots/2/devices/0".'),
});
export const EditReplySchema = z.object({
  summary: z
    .string()
    .describe("Your chat reply, shown to the user. After an edit: one short sentence, past tense, describing what changed. For a question: a short, direct answer (a few sentences at most)."),
  operations: z.array(OperationSchema).describe("The edits, applied in order. Empty if the request can't be done."),
  check: z
    .boolean()
    .optional()
    .describe("True only when you can't tell from the settings how your edit will look: a redesign or a new composition, several things moved at once, new or re-timed animations. You'll see the render (for a timeline, the video's frames) before the person does and can fix anything. False for exact edits (text, a colour, a size, a named look, one shape) and answers."),
  remember: z
    .array(z.string())
    .optional()
    .describe("Lasting preferences the person just stated (\"I prefer…\", \"always…\", \"never…\", \"I love this font\"), each as one short note for the house style. Empty otherwise."),
  see: z
    .boolean()
    .optional()
    .describe(
      "True only when no image came with the request and you can't do it well without seeing the design (judging how it looks, spacing, balance, contrast, what stands out, an open redesign). You'll get the render and answer again; operations in the same reply are ignored. Leave it out for questions the settings answer and for exact edits.",
    ),
  look: z
    .array(z.number().min(0))
    .max(12)
    .optional()
    .describe(
      "Animated designs only: moments of the video you want to see before you answer, in seconds to the millisecond (e.g. [2.35, 4.1]). You'll get exactly those frames and answer again; operations in the same reply are ignored. Leave it out once you've seen enough.",
    ),
  imageReason: z
    .string()
    .optional()
    .describe(
      "Only when you add or change background.generate (a new AI image): why it's needed, in one short sentence, e.g. \"You asked for an AI-generated backdrop\" or \"No look or photo shows a rainy neon street at night\". Leave it out otherwise.",
    ),
});
export type EditReply = z.infer<typeof EditReplySchema>;
export type Operation = z.infer<typeof OperationSchema>;

export interface EditResult {
  /** The design to show: in a video of several shots, the shot to put on the canvas. */
  request: MockupInput;
  /** A video of several shots: all of them as edited, which to show, and which changed. */
  video?: {
    shots: Array<{ scene: MockupInput; length?: number; transition?: { type: (typeof TRANSITIONS)[number]; duration?: number } }>;
    show: number;
    changed: number[];
    /** Shots were added, removed or reordered (so their numbers moved). */
    structural: boolean;
  };
  summary: string;
  operations: Operation[];
  /** Entity ids whose placement or look changed, for highlighting on the canvas. */
  changed: string[];
  provider: Engine["kind"];
  model?: string;
  /** Whether Claude looked at its own render and how many fixes it made then. */
  checked?: { fixes: number };
  /** Preferences added to the house style. */
  remembered?: string[];
}

// ---------------------------------------------------------------------------------------------
// Assets: local paths → opaque tokens and back

const REMOTE = /^(https?:|unsplash:)/;

export function sceneAssets(request: MockupInput, shared?: { assets: Map<string, string>; byPath: Map<string, string> }) {
  // Several shots share one set of tokens, so the same screenshot is the same token in each.
  const assets = shared?.assets ?? new Map<string, string>();
  const byPath = shared?.byPath ?? new Map<string, string>();
  const token = (file: string) => {
    const known = byPath.get(file);
    if (known) return known;
    const ref = `asset:${assets.size + 1}`;
    assets.set(ref, file);
    byPath.set(file, ref);
    return ref;
  };
  const safe = structuredClone(request);
  for (const d of safe.devices) {
    if (d.screenshot) d.screenshot = token(d.screenshot);
    if (d.video) d.video = token(d.video);
  }
  for (const f of safe.fonts ?? []) f.path = token(f.path);
  if (typeof safe.background === "object") {
    if (safe.background.screenshot) safe.background.screenshot = token(safe.background.screenshot);
    if (safe.background.photo && !REMOTE.test(safe.background.photo)) safe.background.photo = token(safe.background.photo);
  }
  // Destination and delivery settings aren't part of the design.
  delete safe.output;
  delete safe.preview;
  return { safe, assets };
}

function restoreAssets(scene: MockupInput, assets: Map<string, string>): MockupInput {
  const restore = (ref: string, what: string) => {
    const file = assets.get(ref);
    if (!file) throw new Error(`AI Edit referred to a ${what} that isn't in this scene. Nothing was changed.`);
    return file;
  };
  for (const d of scene.devices) {
    if (d.screenshot) d.screenshot = restore(d.screenshot, "screenshot");
    if (d.video) d.video = restore(d.video, "recording");
  }
  for (const f of scene.fonts ?? []) f.path = restore(f.path, "font file");
  const bg = scene.background;
  if (typeof bg === "object") {
    if (bg.screenshot) bg.screenshot = restore(bg.screenshot, "screenshot");
    if (bg.photo && !REMOTE.test(bg.photo)) bg.photo = restore(bg.photo, "background photo");
  }
  return scene;
}

// ---------------------------------------------------------------------------------------------
// Operations

const decodePointer = (pointer: string): string[] => {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) pointer = "/" + pointer.replace(/\./g, "/");
  return pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
};

type JSONValue = unknown;
const isIndex = (k: string) => /^(0|[1-9]\d*)$/.test(k);

const SAFE_KEY = (k: string) => k !== "__proto__" && k !== "constructor" && k !== "prototype";

/** The value at a path, or undefined. */
function getAt(root: unknown, keys: string[]): unknown {
  let node: any = root;
  for (const k of keys) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[k];
  }
  return node;
}

/** Walk to a path's parent, making objects and lists on the way when `create`. */
function parentOf(root: any, keys: string[], create: boolean): any {
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (node[k] === undefined || node[k] === null || typeof node[k] !== "object") {
      if (!create) return undefined;
      node[k] = isIndex(keys[i + 1]) || keys[i + 1] === "-" ? [] : {};
    }
    node = node[k];
  }
  return node;
}

/** Apply operations to a copy of `scene`. Throws with a readable message on a bad path. */
export function applyOperations(scene: unknown, operations: Operation[]): unknown {
  const root = structuredClone(scene) as Record<string, JSONValue>;
  for (const { op, path: pointer, value, from } of operations) {
    const keys = decodePointer(pointer);
    if (!keys.length) throw new Error("AI Edit tried to replace the whole scene.");
    if (!keys.every(SAFE_KEY)) throw new Error(`Invalid path ${pointer}`);
    const last = keys[keys.length - 1];
    // Copy and move: take what's at `from` (moving takes it out first), then put it at path.
    if (op === "copy" || op === "move") {
      const fromKeys = decodePointer(from ?? "");
      if (!fromKeys.length || !fromKeys.every(SAFE_KEY)) throw new Error(`${op} needs a "from" path.`);
      const found = getAt(root, fromKeys);
      if (found === undefined) throw new Error(`There's nothing at ${from} to ${op}.`);
      const moving = structuredClone(found);
      if (op === "move") {
        const src = parentOf(root, fromKeys, false);
        const k = fromKeys[fromKeys.length - 1];
        if (Array.isArray(src) && isIndex(k)) src.splice(Number(k), 1);
        else delete src[k];
      }
      const node = parentOf(root, keys, true);
      if (Array.isArray(node) && (isIndex(last) || last === "-")) {
        if (last !== "-" && Number(last) > node.length) throw new Error(`${pointer} is past the end of the list.`);
        node.splice(last === "-" ? node.length : Number(last), 0, moving);
      } else node[last] = moving;
      continue;
    }
    let parsed: JSONValue = null;
    if (op !== "remove") {
      try {
        parsed = JSON.parse(value);
      } catch {
        // A bare string the model forgot to quote is fine; broken JSON goes back to be fixed.
        if (/^\s*["[{]/.test(value)) throw new Error(`The value for ${pointer} isn't valid JSON: ${value.slice(0, 60)}`);
        parsed = value;
      }
    }
    const node = parentOf(root, keys, op !== "remove");
    if (node === undefined) continue;
    if (op === "remove") {
      if (Array.isArray(node) && isIndex(last)) node.splice(Number(last), 1);
      else delete node[last];
    } else if (op === "insert") {
      if (!Array.isArray(node) || !(isIndex(last) || last === "-")) throw new Error(`insert needs a list index: ${pointer}.`);
      if (last !== "-" && Number(last) > node.length) throw new Error(`${pointer} is past the end of the list.`);
      node.splice(last === "-" ? node.length : Number(last), 0, parsed);
    } else if (op === "append" || last === "-") {
      const target = last === "-" ? node : (node[last] ??= []);
      if (!Array.isArray(target)) throw new Error(`${pointer} is not a list.`);
      target.push(parsed);
    } else if (Array.isArray(node) && isIndex(last) && Number(last) > node.length) {
      throw new Error(`${pointer} is past the end of the list.`);
    } else {
      node[last] = parsed;
    }
  }
  return root;
}

function changedEntities(before: MockupInput, after: MockupInput): string[] {
  const out = new Set<string>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  after.devices.forEach((d, i) => {
    if (!same(d, before.devices[i])) out.add(`device-${i + 1}`);
  });
  if (!same([after.headline, after.subheadline, after.textStyle], [before.headline, before.subheadline, before.textStyle])) out.add("caption");
  (after.texts ?? []).forEach((t, i) => {
    if (!same(t, before.texts?.[i])) out.add(`text-${i + 1}`);
  });
  (after.shapes ?? []).forEach((sh, i) => {
    if (!same(sh, before.shapes?.[i])) out.add(`shape-${i + 1}`);
  });
  if (!same([after.background, after.effects], [before.background, before.effects])) out.add("background");
  if (!same([after.canvas, after.layout, after.landscape], [before.canvas, before.layout, before.landscape])) out.add("canvas");
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Prompt

let systemPrompt: string | undefined;
function system(): string {
  if (systemPrompt) return systemPrompt;
  const schema = JSON.stringify(z.toJSONSchema(MockupInputSchema.omit({ output: true, preview: true, quality: true, format: true, jpegQuality: true, deliveryWidth: true, fonts: true })));
  systemPrompt = `You are the designer inside Screenshotter Studio, an editor for App Store screenshots and marketing mockups. The person describes what they want; you change their scene with JSON-pointer operations, and you design with the taste of a great art director. The design guide below is how you work.

How scenes work:
- The scene is JSON matching the schema at the end. Devices show screenshots in hardware frames; the caption is headline + subheadline styled by textStyle; texts are extra free-positioned labels (badges, ratings, eyebrows); shapes are drawn marks and decoration (arrows, lines, ellipses, rects, triangles, stars, number badges), each with a fill and a stroke.
- Positions and sizes are fractions of the canvas: x 0 = left edge, 1 = right edge; y 0 = top, 1 = bottom. Values outside 0–1 bleed off the canvas.
- A device's x/y is its centre. Set "anchor": "center" whenever you set a device's y. Size devices with "height" (fraction of canvas height). rotate is 2D degrees clockwise; rotateX/rotateY are 3D tilt/turn.
- The caption can follow the layout (no textStyle.x/y) or be placed with textStyle.x/y/anchor/align. headlineSize is a fraction of canvas height when < 1.
- "entities" is where everything is now (after automatic layout), even when the scene has no x/y. A shape's entity carries "shape": everything about it as drawn, with an \`around\` target already found.
- "animations" is the design's timeline, for videos: when each item enters, changes and leaves. Targets are entity ids ("device-1", "caption", "text-1", "shape-2"); several in one animation move as a group; "camera" is a target too (to: { zoom, x, y } pushes in on a point; zoom 1 pulls back), and text can arrive with by: "word" or "letter". A device's call-outs (its highlights, counting from 1) are targets as "device-1/callout-2": enter or exit sets when each appears. Anything's blur animates (to: { blur }; texts, shapes, devices and textStyle also have a blur of their own), and enter/exit "blur" brings something into focus. "backdrop" is a target: to: { zoom, x, y, rotate, blur, hue } moves only the backdrop (a slow push, a drift, a colour shift). A Change can travel along a curve (path: { shape: "circle" | "oval" | "figure-8", size } loops, or path: { points } a route of your own) and repeat (repeat: a count, or true for the whole video; yoyo: true goes back and forth), for floats, pulses, spins and orbits. Add one with op "append" at "/animations" (the list is created if it's missing). Requests like "make the phone slide in after the headline" or "draw the arrow at 3 seconds" are timeline edits. When you add or re-time animations, ask to check (check: true): you'll get the video's frames at its key moments and can fix what's off.
- To mark something on a screen, add a shape with "around": { "device": N, "text": "…" } rather than working out coordinates. Add one with op "append" at "/shapes" (the list is created if it's missing).
- If "selected" is given, "this", "it" and "the selection" mean that entity (device-N → /devices/N-1, text-N → /texts/N-1, shape-N → /shapes/N-1, caption → headline/subheadline/textStyle).
- "image" in the request says whether a picture of the design came with it. When the request is about how the design looks, one does: a quick render of the design as it is now (for an animated design, a contact sheet of its video: frames at the moments labelled on them, in order, so you can judge timing and framing). Look at it before deciding anything. The JSON is the source of truth for exact values. Otherwise there's none, to keep things quick: answer questions and make exact edits from the settings, entities and screens. If you truly need to see the design to do the request well, set see: true and leave operations empty.
- A video of several shots: when the request has "video", the design is several shots played one after another, and your operations go into that whole document, so every path starts with /shots/N (N counts from 0; the person counts from 1, so shot 1 is /shots/0 and "the last shot" is the highest). Each shot is a scene as described above, plus "length" (seconds on screen, its way in included; leave it out and it runs as long as its animations need, at least 6 s) and "transition" (how it comes in from the shot before: { type: cut, fade, fade-black, fade-white, push-left, push-right, push-up, push-down, wipe-left, wipe-right, iris, zoom, blur or dissolve, duration } in seconds; ignored on the first). "video.onCanvas" is the shot the person is looking at: "this", "it", "the headline" mean that shot unless they name another ("shot 2", "the first shot", "every shot", "all of them"). Change only the shots they mean. Add a shot with op "insert" at /shots/N and a whole shot as the value, or "copy" from /shots/K to /shots/N and then change the copy; remove one with "remove" at /shots/N; reorder with "move" from /shots/K to /shots/N; "copy" or "move" also carries an item from one shot to another (from /shots/0/devices/0 to /shots/2/devices/-). "shots" lists each at a glance: its number, its name, when it starts, its length, how it comes in and its entities. The shots are also the screens of an App Store set, in store order: "name" is what a screen is called ("Introduction"), and a shot with "video": false is a screen left out of the video (still one of the set's screenshots; it takes no time, so it has no "starts"). Leave a shot out or put it back only when asked: "leave shot 3 out of the video" sets "video": false, "put it back in" removes it. "look" times are across the whole video. Your summary names the shots you changed ("Shot 2: …").
- "screens" describes each device's screenshot: its palette (dominant colours with their share, the accent colour, dark or light UI) and the text visible on it, top to bottom, with where it sits (fractions of the screenshot). Build colour decisions on the palette, and aim callouts at text copied exactly from this list.
- "available" says what can be used right now: "aiImages" names the image generator, or is null (then never use background.generate). "appleArt" lists the devices that have Apple's product art installed.
- "houseStyle" is what this person likes, remembered from before. Follow it unless they ask otherwise.

How to respond:
- A specific request ("tilt it 10°", "make the title blue") changes exactly that and keeps everything else.
- An open request ("make it better", "make it pop", "more premium", "redesign it", "make it look amazing") is licence to redesign: follow the guide, commit to one idea, and change as much as the design needs. Keep the person's screenshots, and their words unless the copy breaks the guide's rules (then say you rewrote it).
- Screenshot, video and font values are asset tokens like "asset:1". Never invent a token or a file path. To add another device you may reuse an existing token.
- Use device names, finishes, looks, grades, layouts and canvases from the lists below.
- If the request can't be expressed in the scene, return no operations and say why.
- summary is your chat reply: after an edit, one or two plain sentences on what you changed and the idea behind it ("Made the phone huge and let it rise from the bottom over a deep green that matches the app, and lifted the Today card so the headline has something to point at."). For a question, a short direct answer and no operations.
- look: for an animated design, when you need to see particular moments before answering (a camera move half way, a word mid-reveal, what's on screen at 3.2 s), list their times and leave operations empty; you'll get exactly those frames and answer again. At most twice, so ask for what matters.
- see: true only when no image came and you can't do the request well without looking (a judgement about how it looks, an open redesign). Never for questions the settings answer or exact edits.
- check: true only when you can't tell from the settings how your edit will look (a redesign or new composition, several things moved at once, new or re-timed animations), so you see the render (for a timeline, the video's frames) before the person does and can fix what's off. false for exact edits (text, a colour, a size, a named look, one shape) and answers. Every look costs the person time, so look only when it matters.
- New AI images: add or change background.generate only when the person asks for a generated or AI image, or when nothing built in can meet the request (no look, painting, Unsplash photo, gradient or colour fits it). Then say why in imageReason. A new image takes half a minute or more and costs money; built-in backdrops are instant, so "better", "premium" or "a new backdrop" means a built-in one. Keep an existing generated backdrop exactly as it is unless the person asks to change it: any change to its prompt or seed makes a new image.
- remember: when the person states a lasting preference ("I prefer…", "always…", "never…", "love this font"), add one short note for each; they're saved to the house style. Otherwise leave it empty.
- This is a chat. "history" lists earlier turns; the scene already includes every edit made so far. Use it for follow-ups like "bigger", "the other one", "go back to the blue" or "try again".

${DESIGN_GUIDE}

Devices and finishes: ${DEVICE_MODELS.map((d) => `${d.name} (${d.colors.map((c) => c.name).join(", ")})`).join("; ")}. Generic finishes for any device: ${GENERIC_COLORS.map((c) => c.name).join(", ")}, or any hex.
Looks: ${LOOKS.map((l) => `${l.name} (${l.tone}${l.painting ? ", painting" : ""}): ${l.description}`).join("; ")}.
Layouts: ${LAYOUTS.join(", ")}. Grades: ${GRADES.join(", ")}.
Canvases: ${Object.entries(CANVAS_PRESETS)
    .map(([k, v]) => `${k} ${v.width}×${v.height}`)
    .join(", ")}, or "WIDTHxHEIGHT".

Scene schema:
${schema}`;
  return systemPrompt;
}

/** What each device's screenshot looks like and says: palette, accent, dark or light, visible text. */
async function screenFacts(request: MockupInput): Promise<unknown[]> {
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  return Promise.all(
    request.devices.map(async (d, i) => {
      if (!d.screenshot) return { device: i + 1 };
      const [palette, text, size] = await Promise.all([
        withTimeout(screenshotPalette(d.screenshot).catch(() => undefined), 6000),
        withTimeout(recognizeText(d.screenshot).catch(() => undefined), 8000),
        imageSize(d.screenshot).catch(() => undefined),
      ]);
      const round = (v: number) => Math.round(v * 1000) / 1000;
      const lines = (text ?? [])
        .filter((t) => t.text.trim())
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .slice(0, 45)
        .map((t) => (size ? { text: t.text.slice(0, 70), x: round(t.x / size.width), y: round(t.y / size.height) } : { text: t.text.slice(0, 70) }));
      return { device: i + 1, palette, text: lines };
    }),
  );
}

async function userMessage(input: AIEditInput, safe: MockupInput, shown: boolean): Promise<string> {
  const layout = await layoutScene(input.request);
  const entities = layout.entities.map(({ screenshot, screen, ...e }) => e);
  const art = [...new Set(listBezels().map((b) => DEVICE_MODELS.find((m) => m.id === b.model)?.name).filter(Boolean))];
  const style = houseStyle().map((n) => n.text);
  return JSON.stringify({
    history: input.history?.length ? input.history.slice(-12) : undefined,
    instruction: input.instruction,
    image: !shown
      ? input.preview === false
        ? "None: the person turned previews off. Work from the settings."
        : "None: work from the settings. Set see: true only if you can't do this well without looking."
      : input.request.animations?.length
        ? "A contact sheet of this design's video: frames at the moments labelled on them (seconds), in order. The last frame is the design once it settles."
        : "A quick render of the design as it is now.",
    selected: input.selection || undefined,
    houseStyle: style.length ? style : undefined,
    available: { aiImages: availableImageProvider() ?? null, appleArt: art },
    screens: await screenFacts(input.request),
    scene: safe,
    canvas: layout.canvas,
    entities,
  });
}

/** The follow-up that shows Claude its own render, to fix what's off before the person sees it. */
async function reviewMessage(input: AIEditInput, edited: MockupInput, restored: MockupInput, first: EditReply, frames = false): Promise<string> {
  const layout = await layoutScene(restored);
  const entities = layout.entities.map(({ screenshot, screen, ...e }) => e);
  return JSON.stringify({
    review: true,
    instruction: input.instruction,
    note: frames
      ? "The image is a contact sheet of the video your edit makes: frames at the moments labelled on them (seconds), in order; the last is the design once it settles. Check each beat against the guide's pacing: is everything that should be on screen there when it should be, with nothing left alone on an empty frame and nothing arriving before the viewer has read what came before; does each camera close-up frame what it's about without cutting through it; does anything overlap or sit half out of frame; does it end settled on the whole design. Check the last frame against 'Check your work' too. If something is off, return operations that fix it; they apply on top of this scene. Don't add or change a generated image here. If it's right, return no operations. Your summary replaces your earlier reply, so describe the finished video."
      : "The image is how your edit renders. Check it against 'Check your work' in the guide. If something is off (text touching the device, weak contrast, a device too small, empty space, a callout on the wrong thing, clashing colours), return operations that fix it; they apply on top of this scene. Don't add or change a generated image here. If it's right, return no operations. Your summary replaces your earlier reply, so describe the finished design.",
    yourEarlierReply: first.summary,
    scene: edited,
    canvas: layout.canvas,
    entities,
  });
}

// ---------------------------------------------------------------------------------------------
// Providers

/** Credentials the Anthropic SDK can pick up on its own (env vars or an `ant auth login` profile). */
export function hasApiCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const config = process.env.ANTHROPIC_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "anthropic");
  return existsSync(path.join(config, "credentials")) || existsSync(path.join(config, "profiles"));
}

function claudeCandidates(): string[] {
  if (process.env.SCREENSHOTTER_CLAUDE_PATH) return [process.env.SCREENSHOTTER_CLAUDE_PATH];
  const home = homedir();
  const fromPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => path.join(d, "claude"));
  return [...fromPath, path.join(home, ".local/bin/claude"), path.join(home, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}
export function findClaudeCli(): string | undefined {
  return claudeCandidates().find((p) => existsSync(p));
}

function codexCandidates(): string[] {
  if (process.env.SCREENSHOTTER_CODEX_PATH) return [process.env.SCREENSHOTTER_CODEX_PATH];
  const home = homedir();
  const fromPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => path.join(d, "codex"));
  return [...fromPath, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(home, ".local/bin/codex"), path.join(home, ".npm-global/bin/codex")];
}
export function findCodexCli(): string | undefined {
  return codexCandidates().find((p) => existsSync(p));
}
/** The model Codex uses: SCREENSHOTTER_CODEX_MODEL, else the one in its own config.toml. */
export function codexModel(): string | undefined {
  if (process.env.SCREENSHOTTER_CODEX_MODEL) return process.env.SCREENSHOTTER_CODEX_MODEL;
  try {
    const home = process.env.CODEX_HOME || path.join(homedir(), ".codex");
    const toml = readFileSync(path.join(home, "config.toml"), "utf8");
    // Only a top-level `model = "…"`, before the first [table].
    const top = toml.split(/^\s*\[/m)[0];
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

/** What does the work: the Anthropic API, Claude Code, or Codex, each a command-line program but the first. */
export type Engine = { kind: "api" } | { kind: "claude-code"; cli: string } | { kind: "codex"; cli: string };

/**
 * The engine for a request: Codex when the person chose it, else Claude (an API key if one is set,
 * else Claude Code), else Codex if that's all there is. Throws with what to do when none is ready.
 */
export function pickEngine(choice: "claude" | "codex" | undefined, what = "Ask AI"): Engine {
  const codex = findCodexCli();
  if (choice === "codex") {
    if (codex) return { kind: "codex", cli: codex };
    throw new Error(`${what} is set to use Codex, but Codex wasn't found. Install it (\`brew install codex\`) and run \`codex\` once to sign in, or switch to Claude in Settings.`);
  }
  if (hasApiCredentials()) return { kind: "api" };
  const claude = findClaudeCli();
  if (claude) return { kind: "claude-code", cli: claude };
  if (codex) return { kind: "codex", cli: codex };
  throw new Error(`${what} needs Claude or Codex. Sign in to Claude Code (run \`claude\` once in Terminal), add an Anthropic API key in Settings, or install Codex and run \`codex\` once.`);
}

export function aiStatus() {
  const cli = findClaudeCli();
  const api = hasApiCredentials();
  const codex = Boolean(findCodexCli());
  return {
    available: api || Boolean(cli) || codex,
    /** Claude's route when Claude is chosen (or null when there's no Claude). */
    provider: api ? ("api" as const) : cli ? ("claude-code" as const) : null,
    model: process.env.SCREENSHOTTER_EDIT_MODEL || DEFAULT_EDIT_MODEL,
    claudeCode: Boolean(cli),
    apiKey: api,
    codex,
    codexModel: codex ? codexModel() : undefined,
  };
}

/**
 * A quick render of the design as it is, for Claude to look at: preview quality, JPEG, at most
 * ~1400 px on the long side. Undefined if it can't be rendered (the edit goes ahead without it).
 */
const FRAME_NAMES: Record<string, string> = { browser: "Browser", window: "Window", card: "Card", none: "Screenshot" };

/** What the Studio is told while an edit runs, so it can show the agent at work. */
export type AIProgress =
  /** `moments`: the image is a contact sheet of the design's video, with this many frames. */
  | { step: "look"; image?: string; moments?: number }
  | { step: "read"; items: string[] }
  | { step: "think" }
  | { step: "retry"; reason: string }
  /** The edit as it stands before Claude checks it: the Studio can apply it right away. */
  | { step: "draft"; result: EditResult }
  /** A render is waiting for an AI image generator to make a new backdrop. */
  | { step: "generate"; provider: string; prompt: string; reason?: string }
  /** Rendering the edit, for Claude to check. */
  | { step: "render" }
  | { step: "check"; image: string; moments?: number }
  /** Claude asked to see the video at these moments; `image` is them once rendered. */
  | { step: "frames"; times: number[]; image?: string };

/** The person pressed Stop. */
export class StoppedError extends Error {
  constructor() {
    super("Stopped");
    this.name = "StoppedError";
  }
}

/** Settle with `p`, or reject with StoppedError as soon as the signal fires. */
function until<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new StoppedError());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new StoppedError());
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** A generated backdrop's identity (prompt, seed, model), if the scene has one. */
function generatedBackdrop(scene: MockupInput): string | undefined {
  const bg = scene.background;
  if (!bg || typeof bg !== "object" || !bg.generate) return undefined;
  const g = typeof bg.generate === "string" ? { prompt: bg.generate } : bg.generate;
  return JSON.stringify([g.prompt, bg.seed ?? 0, "model" in g ? (g.model ?? "") : "", "provider" in g ? (g.provider ?? "") : ""]);
}
/** Whether `after` asks for an AI image that `before` didn't have: a new generation. */
const makesNewImage = (before: MockupInput, after: MockupInput) => {
  const a = generatedBackdrop(after);
  return a !== undefined && a !== generatedBackdrop(before);
};
const NO_IMAGE_REASON =
  "background.generate makes a new AI image, which takes half a minute or more. Make one only when the person asked for a generated image, or when no look, painting, Unsplash photo, gradient or colour can meet the request, and then say why in imageReason. Otherwise use a built-in backdrop and leave imageReason out.";

/** The video's frames at chosen moments: a storyboard of exactly those times. */
async function framesAt(request: MockupInput, times: number[]): Promise<string | undefined> {
  const file = path.join(cacheDir("ai"), `frames-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
  try {
    const { output: _o, format: _f, quality: _q, jpegQuality: _j, deliveryWidth: _d, preview: _p, ...scene } = structuredClone(request);
    await storyboard(scene, { output: file, times });
    return (await readFile(file)).toString("base64");
  } catch {
    return undefined;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * Claude asked to see the video at some moments (`look`): render exactly those frames and ask
 * again, with them, up to twice. The second time it's told to answer.
 */
/** What Claude can be shown: frames at moments, or the whole thing (a render, or a contact sheet). */
interface View {
  animated: boolean;
  frames(times: number[]): Promise<string | undefined>;
  whole(): Promise<Seen | undefined>;
}
const sceneView = (request: MockupInput, onProgress: (p: AIProgress) => void, signal?: AbortSignal): View => ({
  animated: Boolean(request.animations?.length),
  frames: (times) => framesAt(request, times),
  whole: () => renderFor(request, onProgress, signal),
});

async function lookAgain<T extends { look?: number[]; see?: boolean }>(
  view: View,
  reply: T,
  model: string | undefined,
  text: string,
  ask: (text: string, image: string | undefined) => Promise<{ reply: T; model?: string }>,
  onProgress: (p: AIProgress) => void,
  signal?: AbortSignal,
  mayShow = false,
): Promise<{ reply: T; model?: string }> {
  for (let round = 1; round <= 2; round++) {
    const times = reply.look?.length && view.animated ? [...new Set(reply.look.map((t) => Math.round(t * 1000) / 1000))].slice(0, 12) : undefined;
    // It asked to see the design, which it wasn't shown: the render (or the video's key moments).
    const show = !times && mayShow && reply.see;
    if (!times && !show) break;
    let image: string | undefined;
    let note: string;
    const next = round === 2 ? "Now answer: no more looking." : "Answer now, or look once more if you really need to.";
    if (times) {
      onProgress({ step: "frames", times });
      image = await until(view.frames(times), signal);
      if (!image) break;
      onProgress({ step: "frames", times, image });
      note = `You asked to see the video at ${times.map((t) => `${t} s`).join(", ")}: the image shows those frames, labelled. ${next}`;
    } else {
      mayShow = false;
      onProgress({ step: "look" });
      const seen = await view.whole();
      if (!seen) break;
      onProgress({ step: "look", ...seen });
      image = seen.image;
      note = `You asked to see the design: the image is ${seen.moments ? "a contact sheet of its video, frames at the moments labelled on them (seconds), in order; the last is the design once it settles" : "a quick render of it as it is now"}. ${next}`;
    }
    let base: Record<string, unknown>;
    try {
      base = JSON.parse(text) as Record<string, unknown>;
    } catch {
      base = { request: text };
    }
    ({ reply, model } = await ask(JSON.stringify({ ...base, image: note, looked: times }), image));
  }
  return { reply, model };
}

/**
 * Requests about how the design looks, worth a render up front so Claude sees it on its first
 * try. Anything else (a question, an exact edit) goes without, and Claude can ask to see it.
 */
const LOOK_WORDS =
  /\b(looks?|looking|see|visual\w*|spacing|spaced|balance\w*|contrast|readab\w*|legib\w*|overlap\w*|cramped|crowded|clutter\w*|busy|pop|better|improve\w*|nicer|prettier|premium|polish\w*|redesign\w*|amazing|beautiful|stunning|ugly|messy|off|wrong|fix\w*|critique|feedback|opinion|think|review|tidy|awkward|weird|stand ?out|hierarchy|composition|empty|feel|vibe|style|timing|pacing|pace|flow|smooth\w*|jerky|choppy)\b/i;
export const aboutTheLook = (instruction: string) => LOOK_WORDS.test(instruction);

/**
 * Render the scene for Claude. Says first when that means waiting for an AI image generator to
 * make a new backdrop (`generate`), or with `announce`, that it's rendering.
 */
async function renderFor(request: MockupInput, onProgress: (p: AIProgress) => void, signal?: AbortSignal, announce = false, reason?: string): Promise<Seen | undefined> {
  const canvas = (await layoutScene(request).catch(() => undefined))?.canvas;
  const pending = canvas && pendingBackdrop(request.background, canvas.width, canvas.height);
  if (pending) onProgress({ step: "generate", ...pending, reason: reason?.trim() || undefined });
  else if (announce) onProgress({ step: "render" });
  return until(previewImage(request), signal);
}

/** What Claude is shown: the design as a still, or for an animated design, its video's key moments. */
interface Seen {
  image: string;
  moments?: number;
}

/**
 * The design for Claude to look at. An animated design comes as a contact sheet of its video
 * (frames at the moments labelled on them), so timing and framing can be judged; `frames: false`
 * asks for the still regardless.
 */
async function previewImage(request: MockupInput, o: { frames?: boolean } = {}): Promise<Seen | undefined> {
  const file = path.join(cacheDir("ai"), `preview-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
  try {
    if (o.frames !== false && request.animations?.length) {
      const { output: _o, format: _f, quality: _q, jpegQuality: _j, deliveryWidth: _d, preview: _p, ...scene } = structuredClone(request);
      const board = await storyboard(scene, { output: file });
      return { image: (await readFile(file)).toString("base64"), moments: board.times.length };
    }
    const layout = await layoutScene(request);
    const { width: W, height: H } = layout.canvas;
    const deliveryWidth = Math.max(200, Math.round(W >= H ? Math.min(1400, W / 2) : Math.min(W / 2, (1400 * W) / H)));
    await createMockup({ ...structuredClone(request), quality: "preview", format: "jpeg", jpegQuality: 80, deliveryWidth, preview: false, output: file });
    return { image: (await readFile(file)).toString("base64") };
  } catch {
    return undefined;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
    await rm(`${file}.mockup.json`, { force: true }).catch(() => undefined);
  }
}

async function viaApi<T = EditReply>(
  input: AIEditInput,
  prompt: string,
  image: string | undefined,
  retry?: { previous: string; error: string },
  schema: z.ZodType<T> = EditReplySchema as unknown as z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ reply: T; model: string }> {
  const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const model = input.model || process.env.SCREENSHOTTER_EDIT_MODEL || DEFAULT_EDIT_MODEL;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: image
        ? [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: prompt },
          ]
        : prompt,
    },
  ];
  if (retry) {
    messages.push({ role: "assistant", content: retry.previous });
    messages.push({ role: "user", content: `Those operations didn't produce a valid scene: ${retry.error}\nReturn corrected operations for the original instruction.` });
  }
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system: [{ type: "text", text: system(), cache_control: { type: "ephemeral" } }],
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(schema as unknown as typeof EditReplySchema) },
      // Route a declined request to a fallback model instead of failing the edit.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    }, { signal });
    if (response.stop_reason === "refusal") throw new Error("Claude declined this edit. Try describing it differently.");
    if (response.stop_reason === "max_tokens") throw new Error("The edit was too large to finish. Try a smaller change.");
    if (!response.parsed_output) throw new Error("Claude's reply couldn't be read. Try again.");
    return { reply: response.parsed_output as T, model: response.model };
  } catch (e) {
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) throw new StoppedError();
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Your Anthropic API key was rejected. Update it in Settings, or remove it to use Claude Code instead.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error(`This API key can't use ${model}. Choose another model in Settings.`);
    if (e instanceof Anthropic.NotFoundError) throw new Error(`Model ${model} wasn't found. Choose another model in Settings.`);
    if (e instanceof Anthropic.RateLimitError) throw new Error("Anthropic rate limit reached. Wait a moment and try again.");
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach the Anthropic API. Check your connection.");
    if (e instanceof Anthropic.APIError) throw new Error(`AI Edit failed (${e.status ?? "error"}): ${e.message}`);
    throw e;
  }
}

/** Claude Code validates --json-schema as draft-07 and rejects zod's 2020-12 `$schema` tag. */
export function cliSchema(of: z.ZodType = EditReplySchema): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(of, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

async function viaClaudeCode<T = EditReply>(
  input: AIEditInput,
  prompt: string,
  image: string | undefined,
  cli: string,
  retry?: { previous: string; error: string },
  schema: z.ZodType<T> = EditReplySchema as unknown as z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ reply: T; model?: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-ai-"));
  try {
    const env = { ...process.env };
    // Don't let a parent Claude Code session's settings leak in.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // stream-json in and out, so the message can carry the preview image.
    const args = [
      "--safe-mode",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(cliSchema(schema)),
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--effort",
      "medium",
      "--system-prompt",
      system(),
    ];
    const model = input.model || process.env.SCREENSHOTTER_EDIT_MODEL;
    if (model) args.push("--model", model);
    const text = retry ? `${prompt}\n\nYour previous operations were:\n${retry.previous}\nThey didn't produce a valid scene: ${retry.error}\nReturn corrected operations.` : prompt;
    const content = [...(image ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }] : []), { type: "text", text }];
    const line = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    const stdout = await new Promise<string>((resolve, reject) => {
      // Stop ends Claude Code at once (the signal kills the process).
      const child = execFile(cli, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", signal }, (error, out, err) => {
        if (!error) return resolve(out);
        if (signal?.aborted) return reject(new StoppedError());
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new Error("Claude Code wasn't found. Install it, or add an Anthropic API key in Settings."));
        if (error.killed) return reject(new Error("Claude Code took too long to answer. Try again."));
        let detail = `${err}\n${out}`.trim();
        const final = resultLine(out);
        if (final) detail = [final.result, ...(final.errors ?? [])].filter(Boolean).join(" ") || detail;
        if (/not logged in|log ?in|authenticat|credential/i.test(detail)) return reject(new Error("Claude Code isn't signed in. Run `claude` in Terminal once to sign in, or add an API key in Settings."));
        if (/rate limit|quota|usage limit/i.test(detail)) return reject(new Error("Claude Code usage limit reached. Try again later or add an API key in Settings."));
        const last = detail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 240);
        reject(new Error(`Claude Code couldn't complete the edit${last ? `: ${last}` : ""}. Run \`claude\` in Terminal to check it works, then retry.`));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(line);
    });
    const result = resultLine(stdout);
    if (!result) throw new Error("Claude Code returned something unexpected. Update it with `claude update` and retry.");
    if (result.is_error) throw new Error("Claude Code couldn't complete the edit. Check its login and usage, then retry.");
    const raw = result.structured_output ?? (result.result ? JSON.parse(result.result) : undefined);
    return { reply: schema.parse(raw), model: result.model };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The final `result` message of a stream-json run. */
function resultLine(out: string): { is_error?: boolean; structured_output?: unknown; result?: string; model?: string; errors?: string[] } | undefined {
  let last;
  for (const l of out.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    try {
      const m = JSON.parse(l);
      if (m.type === "result") last = m;
    } catch {
      // Partial or non-JSON line.
    }
  }
  return last;
}

/**
 * OpenAI's strict structured output: every property listed as required, no others allowed. An
 * optional field becomes "this, or null" (`dropNulls` turns the nulls back into absences).
 */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "default" || k === "$schema") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, strictSchema(s)])) : strictSchema(v);
  }
  if (out.type === "object" && out.properties) {
    const props = out.properties as Record<string, Record<string, unknown>>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) if (!required.has(key)) props[key] = orNull(props[key]);
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}
function orNull(s: Record<string, unknown>): Record<string, unknown> {
  if (typeof s.type === "string" && !s.enum) return { ...s, type: [s.type, "null"] };
  const { description, ...rest } = s;
  return { ...(description ? { description } : {}), anyOf: [rest, { type: "null" }] };
}
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
}

/**
 * Codex trips over JSON written inside a string, so its operations take a value as it is: a number,
 * true or false, text, or (for an object or a list) JSON. `fromCodexValues` puts the usual form back.
 */
const CODEX_VALUE = {
  description: 'The new value as it is: a number (0.42), true or false, text without extra quotes (Dinner, **solved.** or #ff5500), or an object or list written as JSON ({"look":"dusk"}). null for remove, copy and move.',
  anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
};
function codexValues(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(codexValues);
  if (!node || typeof node !== "object") return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, codexValues(v)]));
  const props = out.properties as Record<string, unknown> | undefined;
  if (props && "op" in props && "path" in props && "value" in props) out.properties = { ...props, value: CODEX_VALUE };
  return out;
}
function fromCodexValues(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromCodexValues);
  if (!v || typeof v !== "object") return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromCodexValues(x)]));
  if ("op" in out && "path" in out && "value" in out) {
    const x = out.value;
    if (typeof x !== "string") out.value = JSON.stringify(x ?? null);
    else if (/^\s*[[{]/.test(x)) out.value = x; // an object or a list, as JSON
    else {
      // Text as it is; or, out of habit, text already written as JSON.
      let quoted: unknown;
      try {
        quoted = /^\s*"/.test(x) ? JSON.parse(x) : undefined;
      } catch {
        quoted = undefined;
      }
      out.value = typeof quoted === "string" ? x : JSON.stringify(x);
    }
  }
  return out;
}

/** Codex works like an agent in a folder; here it only reads the message and answers. */
const CODEX_PREAMBLE =
  "You are answering inside Screenshotter's Ask AI, not working in a code repository. Don't run commands or read files: everything you need is in the message and any attached image. Reply only with the JSON the output schema describes.\n\n";

async function viaCodex<T = EditReply>(
  input: AIEditInput,
  prompt: string,
  image: string | undefined,
  cli: string,
  retry?: { previous: string; error: string },
  schema: z.ZodType<T> = EditReplySchema as unknown as z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ reply: T; model?: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-codex-"));
  try {
    const schemaFile = path.join(dir, "schema.json");
    const replyFile = path.join(dir, "reply.json");
    await writeFile(schemaFile, JSON.stringify(codexValues(strictSchema(cliSchema(schema)))));
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--json",
      // Its own MCP servers would only slow it down; the system prompt goes in as developer
      // instructions (a JSON string is a valid TOML string).
      "-c",
      "mcp_servers={}",
      "-c",
      `developer_instructions=${JSON.stringify(CODEX_PREAMBLE + system())}`,
      "-c",
      `model_reasoning_effort="${process.env.SCREENSHOTTER_CODEX_EFFORT || "medium"}"`,
      "--output-schema",
      schemaFile,
      "-o",
      replyFile,
    ];
    const model = process.env.SCREENSHOTTER_CODEX_MODEL;
    if (model) args.push("-m", model);
    if (image) {
      const file = path.join(dir, "design.jpg");
      await writeFile(file, Buffer.from(image, "base64"));
      args.push(`--image=${file}`);
    }
    const text = retry ? `${prompt}\n\nYour previous operations were:\n${retry.previous}\nThey didn't produce a valid scene: ${retry.error}\nReturn corrected operations.` : prompt;
    await new Promise<void>((resolve, reject) => {
      // Stop ends Codex at once (the signal kills the process). The message goes in on stdin.
      const child = execFile(cli, args, { cwd: dir, env: process.env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal }, (error, out, err) => {
        if (!error) return resolve();
        if (signal?.aborted) return reject(new StoppedError());
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new Error("Codex wasn't found. Install it (`brew install codex`), or switch Ask AI to Claude in Settings."));
        if (error.killed) return reject(new Error("Codex took too long to answer. Try again."));
        const detail = codexError(out) ?? `${err}`.trim();
        if (/not logged in|log ?in|unauthori[sz]ed|401|authenticat|credential/i.test(detail)) return reject(new Error("Codex isn't signed in. Run `codex` in Terminal once to sign in, or switch Ask AI to Claude in Settings."));
        if (/rate limit|quota|usage limit|429/i.test(detail)) return reject(new Error("Codex usage limit reached. Try again later, or switch Ask AI to Claude in Settings."));
        const last = detail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 240);
        reject(new Error(`Codex couldn't complete the edit${last ? `: ${last}` : ""}. Run \`codex\` in Terminal to check it works, then retry.`));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(replyFile, "utf8"));
    } catch {
      throw new Error("Codex's reply couldn't be read. Update it with `brew upgrade codex` and retry.");
    }
    // Values first: a remove's value is null, and dropping nulls before would lose it altogether.
    const parsed = schema.safeParse(dropNulls(fromCodexValues(raw)));
    if (!parsed.success) {
      const what = [...new Set(parsed.error.issues.map((i) => i.path.filter((p) => typeof p === "string").join(".") || "reply"))].slice(0, 3).join(", ");
      throw new Error(`Codex's reply was missing something Ask AI needs (${what}). Try again.`);
    }
    return { reply: parsed.data, model: model ?? codexModel() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The message of the last error event in Codex's JSONL output. */
function codexError(out: string): string | undefined {
  let last: string | undefined;
  for (const l of out.split("\n")) {
    if (!l.trim().startsWith("{")) continue;
    try {
      const m = JSON.parse(l);
      const msg = m.type === "error" ? m.message : m.type === "turn.failed" ? m.error?.message : undefined;
      if (typeof msg !== "string") continue;
      // The message is often an API error as JSON; its inner message says what went wrong.
      try {
        last = JSON.parse(msg)?.error?.message ?? msg;
      } catch {
        last = msg;
      }
    } catch {
      // Partial or non-JSON line.
    }
  }
  return last;
}

/** Ask the chosen engine: the same message, image and reply schema whichever it is. */
function viaEngine<T = EditReply>(
  engine: Engine,
  input: AIEditInput,
  prompt: string,
  image: string | undefined,
  retry?: { previous: string; error: string },
  schema?: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ reply: T; model?: string }> {
  if (engine.kind === "codex") return viaCodex(input, prompt, image, engine.cli, retry, schema, signal);
  if (engine.kind === "claude-code") return viaClaudeCode(input, prompt, image, engine.cli, retry, schema, signal);
  return viaApi(input, prompt, image, retry, schema, signal);
}

// ---------------------------------------------------------------------------------------------

export async function editScene(raw: AIEditInput, onProgress: (p: AIProgress) => void = () => undefined, signal?: AbortSignal): Promise<EditResult> {
  const input = AIEditSchema.parse(raw);
  const { safe, assets } = sceneAssets(input.request);
  const engine = pickEngine(input.engine);
  // A video of several shots: Claude sees and edits all of them.
  if (input.shots && input.shots.length > 1) return editVideo(input, engine, onProgress, signal);
  // Claude sees the design up front only when the request is about how it looks; questions and
  // exact edits go straight from the settings (it can still ask to see it). Reading each
  // screenshot's colours and words (on-device) runs alongside any render.
  const eyes = input.preview !== false && aboutTheLook(input.instruction);
  if (eyes) onProgress({ step: "look" });
  const reading = userMessage(input, safe, eyes);
  reading.catch(() => undefined);
  const seen = eyes ? await renderFor(input.request, onProgress, signal) : undefined;
  const image = seen?.image;
  if (seen) onProgress({ step: "look", ...seen });
  // Reading what's in the scene and on each screen is usually instant (it's remembered); it only
  // shows as a step when it takes a moment, the first time a screenshot is read.
  const quick = await Promise.race([reading.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 500))]);
  if (!quick) {
    const layout = await layoutScene(input.request).catch(() => undefined);
    onProgress({
      step: "read",
      items: [
        ...(layout?.entities ?? []).map((e) => (e.kind === "device" ? (e.device ?? (FRAME_NAMES[e.frame ?? "none"] ?? "Device")) : e.kind === "caption" ? "Headline" : `“${String(e.text ?? "Text").replace(/\*\*/g, "").slice(0, 18)}”`)),
        "Backdrop",
      ],
    });
  }
  const prompt = await until(reading, signal);
  onProgress({ step: "think" });
  const askWith = (text: string, img: string | undefined, retry?: { previous: string; error: string }) => viaEngine(engine, input, text, img, retry, undefined, signal);
  const ask = (retry?: { previous: string; error: string }) => askWith(prompt, image, retry);

  // Operations on a scene (in token space), checked the way a render would check them.
  const apply = async (base: MockupInput, ops: Operation[]) => {
    const edited = MockupInputSchema.parse(applyOperations(base, ops));
    const restored = restoreAssets(structuredClone(edited), assets);
    await layoutScene(restored); // checks device names, finishes, looks and canvas
    return { edited, restored };
  };

  let { reply, model } = await ask();
  // Claude may ask to see the design, or the video at particular moments, first (twice at most).
  ({ reply, model } = await lookAgain(sceneView(input.request, onProgress, signal), reply, model, prompt, (text, img) => askWith(text, img), onProgress, signal, input.preview !== false && !image));
  let result: { edited: MockupInput; restored: MockupInput };
  try {
    result = await apply(safe, reply.operations);
  } catch (e) {
    const error = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    if (/isn't in this scene/.test(error)) throw e;
    onProgress({ step: "retry", reason: error.slice(0, 160) });
    ({ reply, model } = await ask({ previous: JSON.stringify(reply), error }));
    result = await apply(safe, reply.operations);
  }
  // A new AI image only when the person asked for one or nothing built in will do, and Claude
  // says which. Without a reason it's asked again, and usually picks a built-in backdrop. (If it
  // still makes one, or its second try doesn't apply, the first answer stands.)
  if (makesNewImage(input.request, result.restored) && !reply.imageReason?.trim()) {
    onProgress({ step: "retry", reason: "Checking a new AI image is really needed" });
    try {
      const again = await ask({ previous: JSON.stringify(reply), error: NO_IMAGE_REASON });
      const applied = await apply(safe, again.reply.operations);
      ({ reply, model } = again);
      result = applied;
    } catch (e) {
      if (e instanceof StoppedError) throw e;
    }
  }
  let scene = result.restored;
  let summary = reply.summary;
  let operations = reply.operations;
  let checked: EditResult["checked"];

  // Preferences the person stated go to the house style, whatever happens next.
  const remembered = (reply.remember ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  if (remembered.length) updateHouseStyle({ add: remembered });

  // What the Studio gets back: the edited scene with the delivery settings the edit never sees.
  const finish = (): EditResult => {
    const out = structuredClone(scene) as Record<string, unknown>;
    for (const key of ["output", "preview", "quality", "format", "jpegQuality", "deliveryWidth"] as const) {
      if (input.request[key] !== undefined) out[key] = input.request[key];
      else delete out[key];
    }
    const request = out as MockupInput;
    return {
      request,
      summary,
      operations,
      changed: changedEntities(input.request, request),
      provider: engine.kind,
      model,
      checked,
      remembered: remembered.length ? remembered : undefined,
    };
  };

  // Look at the result before the person does, and fix what's off. A review that fails to apply
  // is dropped: the first edit stands. The draft goes out first, so the person can take it as it
  // is rather than wait for the check.
  if (reply.check && reply.operations.length && input.preview !== false) {
    onProgress({ step: "draft", result: finish() });
    const shot = await renderFor(scene, onProgress, signal, true, reply.imageReason);
    if (shot) {
      onProgress({ step: "check", ...shot });
      try {
        const note = await reviewMessage(input, result.edited, scene, reply, Boolean(shot.moments));
        const first = await askWith(note, shot.image);
        const review = await lookAgain(sceneView(scene, onProgress, signal), first.reply, first.model, note, (text, img) => askWith(text, img), onProgress, signal);
        if (review.reply.operations.length) {
          const fixed = await apply(result.edited, review.reply.operations);
          // Fixes never start a new AI image; a review that would is dropped.
          if (!makesNewImage(scene, fixed.restored)) {
            scene = fixed.restored;
            operations = [...operations, ...review.reply.operations];
          }
        }
        if (review.reply.summary.trim()) summary = review.reply.summary;
        checked = { fixes: review.reply.operations.length };
      } catch (e) {
        if (e instanceof StoppedError) throw e;
        checked = { fixes: 0 };
      }
    }
  }
  return finish();
}

// ---------------------------------------------------------------------------------------------
// A video of several shots: one document with every shot, edited with /shots/N paths

type Shot = NonNullable<AIEditInput["shots"]>[number];
const ShotMetaSchema = z.object({
  /** The screen's name in the set ("Introduction"). */
  name: z.string().max(80).optional(),
  /** false: a screen of the set left out of the video (still one of its screenshots). */
  video: z.boolean().optional(),
  length: z.number().min(0.5).max(60).optional(),
  transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0).max(3).optional() }).optional(),
});
/** A shot's own settings beside its scene, as Claude reads and writes them. */
const meta = (s: z.infer<typeof ShotMetaSchema>) => ({
  ...(s.name ? { name: s.name } : {}),
  ...(s.video === false ? { video: false } : {}),
  ...(s.length !== undefined ? { length: s.length } : {}),
  ...(s.transition ? { transition: s.transition } : {}),
});
/** A scene without its destination and delivery settings (they aren't part of the design). */
const designOf = (scene: MockupInput): MockupInput => {
  const { output: _o, format: _f, quality: _q, jpegQuality: _j, deliveryWidth: _d, preview: _p, ...rest } = structuredClone(scene);
  return rest as MockupInput;
};
/** How long a shot runs when it doesn't say: as the video engine works it out (6 s, or longer for its animations). */
const shotLength = (s: Shot) => s.length ?? Math.max(6, s.scene.animations?.length ? timelineEnd(s.scene.animations) + 1.2 : 0);

/** The whole video as one contact sheet: each shot's key moments (or `times`), labelled with the time and shot. */
async function videoSheet(shots: Shot[], times?: number[]): Promise<Seen | undefined> {
  const file = path.join(cacheDir("ai"), `video-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
  try {
    // The video plays the screens not left out of it (all of them, if every one is), numbered as in the set.
    const numbers = shots.map((_, i) => i + 1).filter((n) => shots[n - 1].video !== false);
    const playing = numbers.length ? numbers : shots.map((_, i) => i + 1);
    const input = { shots: playing.map((n) => shots[n - 1]).map((s) => ({ ...designOf(s.scene), ...(s.length ? { length: s.length } : {}), ...(s.transition ? { transition: s.transition } : {}) })) } as SequenceInput;
    const board = await sequenceStoryboard(input, { output: file, times, max: 12, numbers: playing });
    return { image: (await readFile(file)).toString("base64"), moments: board.times.length };
  } catch {
    return undefined;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** What Claude is told about a video: the whole document, and each shot at a glance. */
async function videoMessage(input: AIEditInput, shots: Shot[], safeShots: unknown[], onCanvas: number, shown: boolean): Promise<string> {
  const layouts = await Promise.all(shots.map((s) => layoutScene(s.scene).catch(() => undefined)));
  const art = [...new Set(listBezels().map((b) => DEVICE_MODELS.find((m) => m.id === b.model)?.name).filter(Boolean))];
  const style = houseStyle().map((n) => n.text);
  // What's on each screen, once per screenshot (the same one in several shots is said once).
  const facts = await Promise.all(shots.map((s) => screenFacts(s.scene)));
  const described = new Map<string, string>();
  const screens: unknown[] = [];
  facts.forEach((list, i) =>
    (list as Array<Record<string, unknown>>).forEach((f, d) => {
      const file = shots[i].scene.devices[d]?.screenshot;
      const where = `shot ${i + 1}, device ${d + 1}`;
      if (file && described.has(file)) screens.push({ shot: i + 1, device: d + 1, sameAs: described.get(file) });
      else {
        if (file) described.set(file, where);
        screens.push({ shot: i + 1, ...f });
      }
    }),
  );
  let start = 0;
  let first = true;
  const left = shots.every((s) => s.video === false) ? new Set<number>() : new Set(shots.flatMap((s, i) => (s.video === false ? [i] : [])));
  const overview = shots.map((s, i) => {
    const out = left.has(i);
    const t = first || out ? undefined : (s.transition ?? { type: "fade" as const, duration: 0.5 });
    if (t) start -= t.type === "cut" ? 0 : (t.duration ?? 0.5);
    const row = {
      shot: i + 1,
      path: `/shots/${i}`,
      name: s.name,
      onCanvas: i === onCanvas || undefined,
      headline: s.scene.headline?.replace(/\*\*/g, ""),
      ...(out
        ? { inVideo: false }
        : { starts: Math.round(Math.max(0, start) * 100) / 100, length: Math.round(shotLength(s) * 100) / 100, lengthSet: s.length !== undefined || undefined, comesIn: t }),
      canvas: layouts[i]?.canvas,
      entities: layouts[i]?.entities.map(({ screenshot: _s, screen: _sc, ...e }) => e),
    };
    if (!out) {
      start += shotLength(s);
      first = false;
    }
    return row;
  });
  return JSON.stringify({
    history: input.history?.length ? input.history.slice(-12) : undefined,
    instruction: input.instruction,
    image: shown
      ? "A contact sheet of the whole video: each shot's key moments, in order, each labelled with its time in the video and its shot number."
      : input.preview === false
        ? "None: the person turned previews off. Work from the settings."
        : "None: work from the settings. Set see: true only if you can't do this well without looking.",
    selected: input.selection ? `${input.selection}, in shot ${onCanvas + 1}` : undefined,
    houseStyle: style.length ? style : undefined,
    available: { aiImages: availableImageProvider() ?? null, appleArt: art },
    video: { onCanvas, shots: safeShots },
    shots: overview,
    screens,
  });
}

async function editVideo(input: AIEditInput, engine: Engine, onProgress: (p: AIProgress) => void, signal?: AbortSignal): Promise<EditResult> {
  const onCanvas = Math.min(input.shots!.length - 1, input.shot ?? 0);
  // Every shot as it is now (the one on the canvas as the person has it), without delivery settings.
  const before: Shot[] = input.shots!.map((s, i) => ({ ...s, scene: designOf(i === onCanvas ? input.request : s.scene) }));
  const shared = { assets: new Map<string, string>(), byPath: new Map<string, string>() };
  const safeShots = before.map((s) => ({ ...sceneAssets(s.scene, shared).safe, ...meta(s) }));
  const assets = shared.assets;
  const view = (shots: Shot[]): View => ({ animated: true, frames: async (times) => (await videoSheet(shots, times))?.image, whole: () => videoSheet(shots) });

  const eyes = input.preview !== false && aboutTheLook(input.instruction);
  if (eyes) onProgress({ step: "look" });
  const reading = videoMessage(input, before, safeShots, onCanvas, eyes);
  reading.catch(() => undefined);
  const seen = eyes ? await until(videoSheet(before), signal) : undefined;
  const image = seen?.image;
  if (seen) onProgress({ step: "look", ...seen });
  const quick = await Promise.race([reading.then(() => true, () => true), new Promise<boolean>((res) => setTimeout(() => res(false), 500))]);
  if (!quick) onProgress({ step: "read", items: before.map((s, i) => `Shot ${i + 1}${s.scene.headline ? ` · “${s.scene.headline.replace(/\*\*/g, "").slice(0, 16)}”` : ""}`) });
  const prompt = await until(reading, signal);
  onProgress({ step: "think" });
  const askWith = (text: string, img: string | undefined, retry?: { previous: string; error: string }) => viaEngine(engine, input, text, img, retry, undefined, signal);
  const ask = (retry?: { previous: string; error: string }) => askWith(prompt, image, retry);

  // Operations on the whole video (in token space), each shot checked the way a render would be.
  const apply = async (base: unknown, ops: Operation[]) => {
    const edited = applyOperations(base, ops) as { shots?: unknown };
    if (!Array.isArray(edited.shots) || !edited.shots.length) throw new Error("A video needs at least one shot.");
    if (edited.shots.length > 20) throw new Error("A video can have 20 shots at most.");
    const shots = edited.shots.map((raw, i) => {
      if (!raw || typeof raw !== "object") throw new Error(`Shot ${i + 1} isn't a scene.`);
      const { length, transition, name, video, ...scene } = raw as Record<string, unknown>;
      return { scene: MockupInputSchema.parse(scene), ...ShotMetaSchema.parse({ length, transition, name, video }) };
    });
    const restored: Shot[] = shots.map((sh) => ({ ...sh, scene: restoreAssets(structuredClone(sh.scene), assets) }));
    await Promise.all(restored.map((sh) => layoutScene(sh.scene)));
    // The document for a follow-up (the review): shots in token space, as Claude wrote them.
    return { doc: { shots: shots.map((sh) => ({ ...sh.scene, ...meta(sh) })) }, restored };
  };

  let { reply, model } = await ask();
  // Claude may ask to see the video, or moments of it, first (twice at most).
  ({ reply, model } = await lookAgain(view(before), reply, model, prompt, (text, img) => askWith(text, img), onProgress, signal, input.preview !== false && !image));
  const base = { shots: safeShots };
  let result: Awaited<ReturnType<typeof apply>>;
  try {
    result = await apply(base, reply.operations);
  } catch (e) {
    const error = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    if (/isn't in this scene/.test(error)) throw e;
    onProgress({ step: "retry", reason: error.slice(0, 160) });
    ({ reply, model } = await ask({ previous: JSON.stringify(reply), error }));
    result = await apply(base, reply.operations);
  }
  // A new AI image only when asked for or needed, with its reason (as for one design).
  const newImage = (shots: Shot[]) =>
    shots.some((s) => {
      const g = generatedBackdrop(s.scene);
      return g !== undefined && !before.some((b) => generatedBackdrop(b.scene) === g);
    });
  if (newImage(result.restored) && !reply.imageReason?.trim()) {
    onProgress({ step: "retry", reason: "Checking a new AI image is really needed" });
    try {
      const again = await ask({ previous: JSON.stringify(reply), error: NO_IMAGE_REASON });
      const applied = await apply(base, again.reply.operations);
      ({ reply, model } = again);
      result = applied;
    } catch (e) {
      if (e instanceof StoppedError) throw e;
    }
  }
  let shots = result.restored;
  let summary = reply.summary;
  let operations = reply.operations;
  let checked: EditResult["checked"];
  const remembered = (reply.remember ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  if (remembered.length) updateHouseStyle({ add: remembered });

  // Which shots changed, and which to show: the one on the canvas if it changed (or nothing did),
  // else the first that changed. Added, removed or reordered shots renumber the rest.
  const finish = (): EditResult => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const structural = shots.length !== before.length || operations.some((o) => /^\/shots\/(\d+|-)$/.test(o.path) || /^\/shots\/\d+$/.test(o.from ?? ""));
    const changed = shots.map((s, i) => ((structural ? !before.some((b) => same(b, s)) : !same(s, before[i])) ? i : -1)).filter((i) => i >= 0);
    const show = structural ? (changed[0] ?? Math.min(onCanvas, shots.length - 1)) : changed.length && !changed.includes(onCanvas) ? changed[0] : onCanvas;
    return {
      request: shots[show].scene,
      summary,
      operations,
      changed: !structural && before[show] ? changedEntities(before[show].scene, shots[show].scene) : [],
      provider: engine.kind,
      model,
      checked,
      remembered: remembered.length ? remembered : undefined,
      video: { shots, show, changed, structural },
    };
  };

  // Look at the edited video before the person does, and fix what's off (the draft goes out first).
  if (reply.check && operations.length && input.preview !== false) {
    onProgress({ step: "draft", result: finish() });
    onProgress({ step: "render" });
    const sheet = await until(videoSheet(shots), signal);
    if (sheet) {
      onProgress({ step: "check", ...sheet });
      try {
        const note = JSON.stringify({
          review: true,
          instruction: input.instruction,
          note: "The image is a contact sheet of the whole video your edit makes: each shot's key moments, labelled with the time in the video and the shot number. Check each shot against 'Check your work' in the guide, and the video as a whole: does each shot land its point, do the shots follow on, is anything cut off, overlapping or alone on an empty frame. If something is off, return operations that fix it; they apply on top of this video (the same /shots/N paths). Don't add or change a generated image here. If it's right, return no operations. Your summary replaces your earlier reply, so describe the finished video, naming the shots you changed.",
          yourEarlierReply: reply.summary,
          video: result.doc,
        });
        const first = await askWith(note, sheet.image);
        const review = await lookAgain(view(shots), first.reply, first.model, note, (text, img) => askWith(text, img), onProgress, signal);
        if (review.reply.operations.length) {
          const fixed = await apply(result.doc, review.reply.operations);
          // Fixes never start a new AI image; a review that would is dropped.
          if (!newImage(fixed.restored)) {
            shots = fixed.restored;
            operations = [...operations, ...review.reply.operations];
          }
        }
        if (review.reply.summary.trim()) summary = review.reply.summary;
        checked = { fixes: review.reply.operations.length };
      } catch (e) {
        if (e instanceof StoppedError) throw e;
        checked = { fixes: 0 };
      }
    }
  }
  return finish();
}

// ---------------------------------------------------------------------------------------------
// Design it for me: three directions in one go, each checked and rendered, to pick from.

export const DirectionsSchema = z.object({
  directions: z
    .array(
      z.object({
        name: z.string().describe("The direction in two to four words, e.g. \"Candlelit editorial\"."),
        summary: z.string().describe("One sentence: the idea and what it does for this app."),
        operations: z.array(OperationSchema).describe("The edits that turn the current scene into this direction."),
      }),
    )
    .describe("Exactly three directions that differ in backdrop world, composition and type."),
});

export interface Direction {
  name: string;
  summary: string;
  request: MockupInput;
  /** A small render of it, base64 JPEG. */
  image?: string;
}

export async function designDirections(raw: AIEditInput, onProgress: (p: AIProgress) => void = () => undefined, signal?: AbortSignal): Promise<{ directions: Direction[]; provider: Engine["kind"]; model?: string }> {
  const input = AIEditSchema.parse(raw);
  const { safe, assets } = sceneAssets(input.request);
  const engine = pickEngine(input.engine, "Design it for me");
  onProgress({ step: "look" });
  const reading = userMessage(
    {
      ...input,
      instruction:
        "Design it for me. Propose three distinct directions for this design, each a complete redesign following the guide: different backdrop worlds (for example a tonal colour glow, a painting or photograph from the looks or Unsplash, a warm or dark studio), different compositions and different type. Use built-in backdrops only: don't use background.generate, and keep an existing generated backdrop only as it is. Keep the screenshots and any words the person wrote. Each direction is its own set of operations on the current scene.",
    },
    safe,
    input.preview !== false,
  );
  reading.catch(() => undefined);
  const seen = input.preview === false ? undefined : await renderFor(input.request, onProgress, signal);
  const image = seen?.image;
  if (seen) onProgress({ step: "look", ...seen });
  const layout = await layoutScene(input.request).catch(() => undefined);
  onProgress({ step: "read", items: [...(layout?.entities ?? []).map((e) => (e.kind === "device" ? (e.device ?? "Device") : e.kind === "caption" ? "Headline" : "Text")), "Backdrop"] });
  const prompt = await until(reading, signal);
  onProgress({ step: "think" });
  const { reply, model } = await viaEngine(engine, input, prompt, image, undefined, DirectionsSchema, signal);
  const directions: Direction[] = [];
  for (const d of reply.directions.slice(0, 3)) {
    try {
      const edited = MockupInputSchema.parse(applyOperations(safe, d.operations));
      const restored = restoreAssets(edited, assets);
      await layoutScene(restored);
      for (const key of ["output", "preview", "quality", "format", "jpegQuality", "deliveryWidth"] as const) delete (restored as Record<string, unknown>)[key];
      // Nobody asked for AI images here: a direction that would make one is left out.
      if (makesNewImage(input.request, restored)) continue;
      directions.push({ name: d.name, summary: d.summary, request: restored });
    } catch {
      // A direction that doesn't make a valid scene is left out.
    }
  }
  if (!directions.length) throw new Error("None of the directions came out right. Try again.");
  // Render each so they can be compared side by side (AI backdrops are made first).
  const pending = directions.map((d) => ({ d, canvas: undefined as { width: number; height: number } | undefined }));
  for (const p of pending) p.canvas = (await layoutScene(p.d.request).catch(() => undefined))?.canvas;
  const painting = pending.map((p) => p.canvas && pendingBackdrop(p.d.request.background, p.canvas.width, p.canvas.height)).find(Boolean);
  onProgress(painting ? { step: "generate", ...painting } : { step: "render" });
  const shots = await until(Promise.all(directions.map((d) => previewImage(d.request, { frames: false }))), signal);
  directions.forEach((d, i) => (d.image = shots[i]?.image));
  if (shots[0]) onProgress({ step: "check", image: shots[0].image });
  return { directions, provider: engine.kind, model };
}

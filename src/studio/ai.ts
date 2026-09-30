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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEVICE_MODELS, GENERIC_COLORS } from "../devices/catalog.js";
import { CANVAS_PRESETS } from "../render/layouts.js";
import { LOOKS } from "../render/looks.js";
import { createMockup, layoutScene } from "../render/mockup.js";
import { cacheDir } from "../util/files.js";
import { imageSize } from "../util/image.js";
import { DESIGN_GUIDE } from "../design/guide.js";
import { screenshotPalette } from "../render/analyze.js";
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
  /** Show Claude a quick render of the current design along with its settings. Default true. */
  preview: z.boolean().optional(),
  /** Earlier turns of this chat: what the user said and what Claude replied. */
  history: z
    .array(z.object({ user: z.string().max(4000), assistant: z.string().max(4000).optional() }))
    .max(40)
    .optional(),
});
export type AIEditInput = z.infer<typeof AIEditSchema>;

export const OperationSchema = z.object({
  op: z.enum(["set", "remove", "append"]).describe("set: create or replace the value at path. remove: delete it. append: push value onto the array at path."),
  path: z.string().describe('JSON pointer into the scene, e.g. "/devices/0/x", "/background", "/texts".'),
  value: z.string().describe('The new value encoded as JSON, e.g. "0.42", "\\"#ff5500\\"", "{\\"look\\":\\"dusk\\"}". Use "null" for remove.'),
});
export const EditReplySchema = z.object({
  summary: z
    .string()
    .describe("Your chat reply, shown to the user. After an edit: one short sentence, past tense, describing what changed. For a question: a short, direct answer (a few sentences at most)."),
  operations: z.array(OperationSchema).describe("The edits, applied in order. Empty if the request can't be done."),
  check: z
    .boolean()
    .optional()
    .describe("True when you changed the look or composition and want to see the render before the person does (you'll get it and can fix anything). False for small exact edits and answers."),
  remember: z
    .array(z.string())
    .optional()
    .describe("Lasting preferences the person just stated (\"I prefer…\", \"always…\", \"never…\", \"I love this font\"), each as one short note for the house style. Empty otherwise."),
});
export type EditReply = z.infer<typeof EditReplySchema>;
export type Operation = z.infer<typeof OperationSchema>;

export interface EditResult {
  request: MockupInput;
  summary: string;
  operations: Operation[];
  /** Entity ids whose placement or look changed, for highlighting on the canvas. */
  changed: string[];
  provider: "api" | "claude-code";
  model?: string;
  /** Whether Claude looked at its own render and how many fixes it made then. */
  checked?: { fixes: number };
  /** Preferences added to the house style. */
  remembered?: string[];
}

// ---------------------------------------------------------------------------------------------
// Assets: local paths → opaque tokens and back

const REMOTE = /^(https?:|unsplash:)/;

export function sceneAssets(request: MockupInput) {
  const assets = new Map<string, string>();
  const byPath = new Map<string, string>();
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

/** Apply operations to a copy of `scene`. Throws with a readable message on a bad path. */
export function applyOperations(scene: unknown, operations: Operation[]): unknown {
  const root = structuredClone(scene) as Record<string, JSONValue>;
  for (const { op, path: pointer, value } of operations) {
    const keys = decodePointer(pointer);
    if (!keys.length) throw new Error("AI Edit tried to replace the whole scene.");
    if (keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) throw new Error(`Invalid path ${pointer}`);
    let parsed: JSONValue = null;
    if (op !== "remove") {
      try {
        parsed = JSON.parse(value);
      } catch {
        // A bare string the model forgot to quote.
        parsed = value;
      }
    }
    let node: any = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (node[k] === undefined || node[k] === null || typeof node[k] !== "object") {
        if (op === "remove") {
          node = undefined;
          break;
        }
        node[k] = isIndex(keys[i + 1]) || keys[i + 1] === "-" ? [] : {};
      }
      node = node[k];
    }
    if (node === undefined) continue;
    const last = keys[keys.length - 1];
    if (op === "remove") {
      if (Array.isArray(node) && isIndex(last)) node.splice(Number(last), 1);
      else delete node[last];
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
- The scene is JSON matching the schema at the end. Devices show screenshots in hardware frames; the caption is headline + subheadline styled by textStyle; texts are extra free-positioned labels (badges, ratings, eyebrows).
- Positions and sizes are fractions of the canvas: x 0 = left edge, 1 = right edge; y 0 = top, 1 = bottom. Values outside 0–1 bleed off the canvas.
- A device's x/y is its centre. Set "anchor": "center" whenever you set a device's y. Size devices with "height" (fraction of canvas height). rotate is 2D degrees clockwise; rotateX/rotateY are 3D tilt/turn.
- The caption can follow the layout (no textStyle.x/y) or be placed with textStyle.x/y/anchor/align. headlineSize is a fraction of canvas height when < 1.
- "entities" is where everything is now (after automatic layout), even when the scene has no x/y.
- If "selected" is given, "this", "it" and "the selection" mean that entity (device-N → /devices/N-1, text-N → /texts/N-1, caption → headline/subheadline/textStyle).
- An image usually comes with the request: a quick render of the design as it is now. Look at it before deciding anything. The JSON is the source of truth for exact values.
- "screens" describes each device's screenshot: its palette (dominant colours with their share, the accent colour, dark or light UI) and the text visible on it, top to bottom, with where it sits (fractions of the screenshot). Build colour decisions on the palette, and aim callouts at text copied exactly from this list.
- "available" says what can be used right now: "aiImages" names the image generator, or is null (then don't use background.generate; use looks, Unsplash or colours). "appleArt" lists the devices that have Apple's product art installed.
- "houseStyle" is what this person likes, remembered from before. Follow it unless they ask otherwise.

How to respond:
- A specific request ("tilt it 10°", "make the title blue") changes exactly that and keeps everything else.
- An open request ("make it better", "make it pop", "more premium", "redesign it", "make it look amazing") is licence to redesign: follow the guide, commit to one idea, and change as much as the design needs. Keep the person's screenshots, and their words unless the copy breaks the guide's rules (then say you rewrote it).
- Screenshot, video and font values are asset tokens like "asset:1". Never invent a token or a file path. To add another device you may reuse an existing token.
- Use device names, finishes, looks, grades, layouts and canvases from the lists below.
- If the request can't be expressed in the scene, return no operations and say why.
- summary is your chat reply: after an edit, one or two plain sentences on what you changed and the idea behind it ("Made the phone huge and let it rise from the bottom over a deep green that matches the app, and lifted the Today card so the headline has something to point at."). For a question, a short direct answer and no operations.
- check: true when you changed the look or composition, so you see the render before the person does and can fix what's off. false for small exact edits and answers.
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

async function userMessage(input: AIEditInput, safe: MockupInput): Promise<string> {
  const layout = await layoutScene(input.request);
  const entities = layout.entities.map(({ screenshot, screen, ...e }) => e);
  const art = [...new Set(listBezels().map((b) => DEVICE_MODELS.find((m) => m.id === b.model)?.name).filter(Boolean))];
  const style = houseStyle().map((n) => n.text);
  return JSON.stringify({
    history: input.history?.length ? input.history.slice(-12) : undefined,
    instruction: input.instruction,
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
async function reviewMessage(input: AIEditInput, edited: MockupInput, restored: MockupInput, first: EditReply): Promise<string> {
  const layout = await layoutScene(restored);
  const entities = layout.entities.map(({ screenshot, screen, ...e }) => e);
  return JSON.stringify({
    review: true,
    instruction: input.instruction,
    note:
      "The image is how your edit renders. Check it against 'Check your work' in the guide. If something is off (text touching the device, weak contrast, a device too small, empty space, a callout on the wrong thing, clashing colours), return operations that fix it; they apply on top of this scene. If it's right, return no operations. Your summary replaces your earlier reply, so describe the finished design.",
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

export function aiStatus() {
  const cli = findClaudeCli();
  const api = hasApiCredentials();
  return {
    available: api || Boolean(cli),
    provider: api ? ("api" as const) : cli ? ("claude-code" as const) : null,
    model: process.env.SCREENSHOTTER_EDIT_MODEL || DEFAULT_EDIT_MODEL,
    claudeCode: Boolean(cli),
    apiKey: api,
  };
}

/**
 * A quick render of the design as it is, for Claude to look at: preview quality, JPEG, at most
 * ~1400 px on the long side. Undefined if it can't be rendered (the edit goes ahead without it).
 */
const FRAME_NAMES: Record<string, string> = { browser: "Browser", window: "Window", card: "Card", none: "Screenshot" };

/** What the Studio is told while an edit runs, so it can show the agent at work. */
export type AIProgress =
  | { step: "look"; image?: string }
  | { step: "read"; items: string[] }
  | { step: "think" }
  | { step: "check"; image: string }
  | { step: "retry"; reason: string };

async function previewImage(request: MockupInput): Promise<string | undefined> {
  const file = path.join(cacheDir("ai"), `preview-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`);
  try {
    const layout = await layoutScene(request);
    const { width: W, height: H } = layout.canvas;
    const deliveryWidth = Math.max(200, Math.round(W >= H ? Math.min(1400, W / 2) : Math.min(W / 2, (1400 * W) / H)));
    await createMockup({ ...structuredClone(request), quality: "preview", format: "jpeg", jpegQuality: 80, deliveryWidth, preview: false, output: file });
    return (await readFile(file)).toString("base64");
  } catch {
    return undefined;
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
    await rm(`${file}.mockup.json`, { force: true }).catch(() => undefined);
  }
}

async function viaApi(input: AIEditInput, prompt: string, image: string | undefined, retry?: { previous: string; error: string }): Promise<{ reply: EditReply; model: string }> {
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
      output_config: { effort: "medium", format: zodOutputFormat(EditReplySchema) },
      // Route a declined request to a fallback model instead of failing the edit.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") throw new Error("Claude declined this edit. Try describing it differently.");
    if (response.stop_reason === "max_tokens") throw new Error("The edit was too large to finish. Try a smaller change.");
    if (!response.parsed_output) throw new Error("Claude's reply couldn't be read. Try again.");
    return { reply: response.parsed_output, model: response.model };
  } catch (e) {
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
export function cliSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(EditReplySchema, { target: "draft-7" }) as Record<string, unknown>;
  return schema;
}

async function viaClaudeCode(input: AIEditInput, prompt: string, image: string | undefined, cli: string, retry?: { previous: string; error: string }): Promise<{ reply: EditReply; model?: string }> {
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
      JSON.stringify(cliSchema()),
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
      const child = execFile(cli, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, out, err) => {
        if (!error) return resolve(out);
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
    return { reply: EditReplySchema.parse(raw), model: result.model };
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

// ---------------------------------------------------------------------------------------------

export async function editScene(raw: AIEditInput, onProgress: (p: AIProgress) => void = () => undefined): Promise<EditResult> {
  const input = AIEditSchema.parse(raw);
  const { safe, assets } = sceneAssets(input.request);
  const cli = hasApiCredentials() ? undefined : findClaudeCli();
  if (!hasApiCredentials() && !cli) {
    throw new Error("AI Edit needs Claude. Sign in to Claude Code (run `claude` once in Terminal) or add an Anthropic API key in Settings.");
  }
  // Let Claude see the design, not just its settings.
  onProgress({ step: "look" });
  const image = input.preview === false ? undefined : await previewImage(input.request);
  if (image) onProgress({ step: "look", image });
  const prompt = await userMessage(input, safe);
  const layout = await layoutScene(input.request).catch(() => undefined);
  onProgress({
    step: "read",
    items: [
      ...(layout?.entities ?? []).map((e) => (e.kind === "device" ? (e.device ?? (FRAME_NAMES[e.frame ?? "none"] ?? "Device")) : e.kind === "caption" ? "Headline" : `“${String(e.text ?? "Text").replace(/\*\*/g, "").slice(0, 18)}”`)),
      "Backdrop",
    ],
  });
  onProgress({ step: "think" });
  const askWith = (text: string, img: string | undefined, retry?: { previous: string; error: string }) =>
    cli ? viaClaudeCode(input, text, img, cli, retry) : viaApi(input, text, img, retry);
  const ask = (retry?: { previous: string; error: string }) => askWith(prompt, image, retry);

  // Operations on a scene (in token space), checked the way a render would check them.
  const apply = async (base: MockupInput, ops: Operation[]) => {
    const edited = MockupInputSchema.parse(applyOperations(base, ops));
    const restored = restoreAssets(structuredClone(edited), assets);
    await layoutScene(restored); // checks device names, finishes, looks and canvas
    return { edited, restored };
  };

  let { reply, model } = await ask();
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
  let scene = result.restored;
  let summary = reply.summary;
  let operations = reply.operations;
  let checked: EditResult["checked"];

  // Look at the result before the person does, and fix what's off. A review that fails to apply
  // is dropped: the first edit stands.
  if (reply.check && reply.operations.length && input.preview !== false) {
    const shot = await previewImage(scene);
    if (shot) {
      onProgress({ step: "check", image: shot });
      try {
        const review = await askWith(await reviewMessage(input, result.edited, scene, reply), shot);
        if (review.reply.operations.length) {
          const fixed = await apply(result.edited, review.reply.operations);
          scene = fixed.restored;
          operations = [...operations, ...review.reply.operations];
        }
        if (review.reply.summary.trim()) summary = review.reply.summary;
        checked = { fixes: review.reply.operations.length };
      } catch {
        checked = { fixes: 0 };
      }
    }
  }

  // Preferences the person stated go to the house style.
  const remembered = (reply.remember ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  if (remembered.length) updateHouseStyle({ add: remembered });

  // Keep delivery settings the edit never sees.
  for (const key of ["output", "preview", "quality", "format", "jpegQuality", "deliveryWidth"] as const) {
    if (input.request[key] !== undefined) (scene as Record<string, unknown>)[key] = input.request[key];
    else delete (scene as Record<string, unknown>)[key];
  }
  return {
    request: scene,
    summary,
    operations,
    changed: changedEntities(input.request, scene),
    provider: cli ? "claude-code" : "api",
    model,
    checked,
    remembered: remembered.length ? remembered : undefined,
  };
}

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
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEVICE_MODELS, GENERIC_COLORS } from "../devices/catalog.js";
import { CANVAS_PRESETS } from "../render/layouts.js";
import { LOOKS } from "../render/looks.js";
import { layoutScene } from "../render/mockup.js";
import { GRADES, LAYOUTS, MockupInputSchema, type MockupInput } from "../render/schema.js";

export const DEFAULT_EDIT_MODEL = "claude-opus-5-5";

export const AIEditSchema = z.object({
  request: MockupInputSchema,
  instruction: z.string().trim().min(1, "Describe the change you want").max(4000),
  /** Entity the user has selected on the canvas ("device-1", "caption", "text-2"), for "make this bigger". */
  selection: z.string().max(40).optional(),
  model: z.string().max(100).optional(),
});
export type AIEditInput = z.infer<typeof AIEditSchema>;

export const OperationSchema = z.object({
  op: z.enum(["set", "remove", "append"]).describe("set: create or replace the value at path. remove: delete it. append: push value onto the array at path."),
  path: z.string().describe('JSON pointer into the scene, e.g. "/devices/0/x", "/background", "/texts".'),
  value: z.string().describe('The new value encoded as JSON, e.g. "0.42", "\\"#ff5500\\"", "{\\"look\\":\\"dusk\\"}". Use "null" for remove.'),
});
export const EditReplySchema = z.object({
  summary: z.string().describe("One short sentence, past tense, describing what changed. Shown to the user."),
  operations: z.array(OperationSchema).describe("The edits, applied in order. Empty if the request can't be done."),
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
    d.screenshot = token(d.screenshot);
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
    d.screenshot = restore(d.screenshot, "screenshot");
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
  systemPrompt = `You are the design assistant inside Screenshotter Studio, an editor for App Store screenshots and marketing mockups. The user describes a change to their scene; you reply with JSON-pointer operations that make exactly that change.

How scenes work:
- The scene is JSON matching the schema below. Devices show screenshots in hardware frames; the caption is headline + subheadline styled by textStyle; texts are extra free-positioned labels.
- Positions and sizes are fractions of the canvas: x 0 = left edge, 1 = right edge; y 0 = top, 1 = bottom. Values outside 0–1 bleed off the canvas.
- A device's x/y is its centre. Set "anchor": "center" whenever you set a device's y. Size devices with "height" (fraction of canvas height). rotate is 2D degrees clockwise; rotateX/rotateY are 3D tilt/turn.
- The caption can follow the layout (no textStyle.x/y) or be placed with textStyle.x/y/anchor/align. headlineSize is a fraction of canvas height when < 1.
- Wrap words in **double asterisks** to paint them in an accent colour: textStyle.accentColor for the caption, texts[i].accentColor for extra text (which falls back to textStyle.accentColor). Without an accent colour the words are only bold.
- "entities" in the request is the current resolved placement of everything (after automatic layout), so use it to know where things are now, even when the scene itself has no x/y.
- If "selected" is given, "this", "it" and "the selection" mean that entity (device-N → /devices/N-1, text-N → /texts/N-1, caption → headline/subheadline/textStyle).

Rules:
- Change only what the user asked for. Keep every other property as it is.
- Screenshot, video and font values are asset tokens like "asset:1". Never invent a token or a file path. To add another device you may reuse an existing token.
- Prefer a named look for backgrounds ("background": "dusk") unless the user asks for specific colours. Photo backgrounds may use {"unsplash": "search words"}.
- Use device names, finishes, looks, grades, layouts and canvases from the lists below.
- If the request can't be expressed in the scene, return no operations and say why in the summary.
- The summary is one short sentence in plain language, like "Tilted the phone 12° and moved the title to the bottom."

Devices and finishes: ${DEVICE_MODELS.map((d) => `${d.name} (${d.colors.map((c) => c.name).join(", ")})`).join("; ")}. Generic finishes for any device: ${GENERIC_COLORS.map((c) => c.name).join(", ")}, or any hex.
Looks: ${LOOKS.map((l) => `${l.name} (${l.tone}): ${l.description}`).join("; ")}.
Layouts: ${LAYOUTS.join(", ")}. Grades: ${GRADES.join(", ")}.
Canvases: ${Object.entries(CANVAS_PRESETS)
    .map(([k, v]) => `${k} ${v.width}×${v.height}`)
    .join(", ")}, or "WIDTHxHEIGHT".

Scene schema:
${schema}`;
  return systemPrompt;
}

async function userMessage(input: AIEditInput, safe: MockupInput): Promise<string> {
  const layout = await layoutScene(input.request);
  const entities = layout.entities.map(({ screenshot, screen, ...e }) => e);
  return JSON.stringify({
    instruction: input.instruction,
    selected: input.selection || undefined,
    scene: safe,
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

async function viaApi(input: AIEditInput, prompt: string, retry?: { previous: string; error: string }): Promise<{ reply: EditReply; model: string }> {
  const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const model = input.model || process.env.SCREENSHOTTER_EDIT_MODEL || DEFAULT_EDIT_MODEL;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
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
      output_config: { effort: "low", format: zodOutputFormat(EditReplySchema) },
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

async function viaClaudeCode(input: AIEditInput, prompt: string, cli: string, retry?: { previous: string; error: string }): Promise<{ reply: EditReply; model?: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshotter-ai-"));
  try {
    const env = { ...process.env };
    // Don't let a parent Claude Code session's settings leak in.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const args = [
      "--safe-mode",
      "-p",
      "--output-format",
      "json",
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
      "low",
      "--system-prompt",
      system(),
    ];
    const model = input.model || process.env.SCREENSHOTTER_EDIT_MODEL;
    if (model) args.push("--model", model);
    const text = retry ? `${prompt}\n\nYour previous operations were:\n${retry.previous}\nThey didn't produce a valid scene: ${retry.error}\nReturn corrected operations.` : prompt;
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(cli, args, { cwd: dir, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, out, err) => {
        if (!error) return resolve(out);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new Error("Claude Code wasn't found. Install it, or add an Anthropic API key in Settings."));
        if (error.killed) return reject(new Error("Claude Code took too long to answer. Try again."));
        let detail = `${err}\n${out}`.trim();
        try {
          const parsed = JSON.parse(out) as { result?: string; errors?: string[] };
          detail = [parsed.result, ...(parsed.errors ?? [])].filter(Boolean).join(" ") || detail;
        } catch {
          // Not JSON: keep the raw text.
        }
        if (/not logged in|log ?in|authenticat|credential/i.test(detail)) return reject(new Error("Claude Code isn't signed in. Run `claude` in Terminal once to sign in, or add an API key in Settings."));
        if (/rate limit|quota|usage limit/i.test(detail)) return reject(new Error("Claude Code usage limit reached. Try again later or add an API key in Settings."));
        const last = detail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 240);
        reject(new Error(`Claude Code couldn't complete the edit${last ? `: ${last}` : ""}. Run \`claude\` in Terminal to check it works, then retry.`));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    });
    let result: { is_error?: boolean; structured_output?: unknown; result?: string; model?: string };
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error("Claude Code returned something unexpected. Update it with `claude update` and retry.");
    }
    if (result.is_error) throw new Error("Claude Code couldn't complete the edit. Check its login and usage, then retry.");
    const raw = result.structured_output ?? (result.result ? JSON.parse(result.result) : undefined);
    return { reply: EditReplySchema.parse(raw), model: result.model };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------

export async function editScene(raw: AIEditInput): Promise<EditResult> {
  const input = AIEditSchema.parse(raw);
  const { safe, assets } = sceneAssets(input.request);
  const prompt = await userMessage(input, safe);
  const cli = hasApiCredentials() ? undefined : findClaudeCli();
  if (!hasApiCredentials() && !cli) {
    throw new Error("AI Edit needs Claude. Sign in to Claude Code (run `claude` once in Terminal) or add an Anthropic API key in Settings.");
  }
  const ask = (retry?: { previous: string; error: string }) => (cli ? viaClaudeCode(input, prompt, cli, retry) : viaApi(input, prompt, retry));

  const attempt = async (reply: EditReply): Promise<MockupInput> => {
    const edited = MockupInputSchema.parse(applyOperations(safe, reply.operations));
    const restored = restoreAssets(edited, assets);
    await layoutScene(restored); // checks device names, finishes, looks and canvas
    return restored;
  };

  let { reply, model } = await ask();
  let scene: MockupInput;
  try {
    scene = await attempt(reply);
  } catch (e) {
    const error = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    if (/isn't in this scene/.test(error)) throw e;
    ({ reply, model } = await ask({ previous: JSON.stringify(reply), error }));
    scene = await attempt(reply);
  }
  // Keep delivery settings the edit never sees.
  for (const key of ["output", "preview", "quality", "format", "jpegQuality", "deliveryWidth"] as const) {
    if (input.request[key] !== undefined) (scene as Record<string, unknown>)[key] = input.request[key];
    else delete (scene as Record<string, unknown>)[key];
  }
  return {
    request: scene,
    summary: reply.summary,
    operations: reply.operations,
    changed: changedEntities(input.request, scene),
    provider: cli ? "claude-code" : "api",
    model,
  };
}

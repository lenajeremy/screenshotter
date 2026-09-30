import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Root folder for everything the server writes. */
export function outputRoot(): string {
  const configured = process.env.SCREENSHOTTER_OUTPUT_DIR;
  return path.resolve(configured ? expandHome(configured) : path.join(process.cwd(), "screenshots"));
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Resolve a user-supplied path relative to the working directory. */
export function resolveUserPath(p: string): string {
  return path.resolve(expandHome(p));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "shot"
  );
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The file extension (lower case, no dot) of a path, if any. */
export function extOf(p: string | undefined): string | undefined {
  const ext = p ? path.extname(p).slice(1).toLowerCase() : "";
  return ext || undefined;
}

/**
 * Pick the output format: explicit format, else the output path's extension if it's one of
 * the allowed formats, else the default.
 */
export function formatFor<T extends string>(explicit: T | undefined, output: string | undefined, allowed: readonly T[], fallback: T, aliases: Record<string, T> = {}): T {
  if (explicit) return explicit;
  const ext = extOf(output);
  if (!ext || (output && isDir(resolveUserPath(output)))) return fallback;
  const mapped = aliases[ext] ?? ext;
  return (allowed as readonly string[]).includes(mapped) ? (mapped as T) : fallback;
}

/**
 * Work out where to write a file. An explicit path wins (a directory gets a generated file
 * name, and a file name gets its extension corrected to match `ext`); otherwise the file goes
 * into `<outputRoot>/<subdir>`. Generated names never overwrite an existing file.
 */
export function outputPathFor(explicit: string | undefined, subdir: string, baseName: string, ext: string): string {
  const unique = (dir: string) => {
    const stem = `${slug(baseName)}-${timestamp()}`;
    let candidate = path.join(dir, `${stem}.${ext}`);
    for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}.${ext}`);
    return candidate;
  };
  if (explicit) {
    const resolved = resolveUserPath(explicit);
    if (explicit.endsWith("/") || isDir(resolved)) return unique(ensureDir(resolved));
    ensureDir(path.dirname(resolved));
    const current = path.extname(resolved);
    const aliases: Record<string, string[]> = { jpg: ["jpg", "jpeg"], jpeg: ["jpg", "jpeg"] };
    const ok = current && (aliases[ext] ?? [ext]).includes(current.slice(1).toLowerCase());
    return ok ? resolved : `${current ? resolved.slice(0, -current.length) : resolved}.${ext}`;
  }
  return unique(ensureDir(path.join(outputRoot(), subdir)));
}

/** Per-user cache (downloaded photos, generated images, compiled helpers, locks). */
export function cacheDir(sub: string): string {
  const base = process.env.SCREENSHOTTER_CACHE_DIR ?? path.join(homedir(), ".cache", "screenshotter");
  return ensureDir(path.join(base, sub));
}

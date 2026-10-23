#!/usr/bin/env node
/**
 * The ffmpeg inside the app: FFmpeg built from its released source with the encoders our videos
 * use (x264 for MP4, libvpx and Opus for WebM), linked only to what every Mac has, so videos work
 * without installing anything. Built once and kept in build/vendor; the app build copies it in.
 *
 *   node scripts/build-ffmpeg.mjs     → build/vendor/ffmpeg-<versions>/ffmpeg (a few minutes, once)
 *
 * Needs Xcode's command line tools (clang, make), git and pkg-config. x264 makes the build GPL v2
 * or later: the app carries the licences, and the release puts the exact source on the site
 * (scripts/build-dmg.mjs).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "build", "vendor");

// Every source is pinned: a release tarball by its checksum, or a git repository by its commit.
const FFMPEG = { version: "8.1.3", url: "https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz", sha256: "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" };
const OPUS = { version: "1.6.1", url: "https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz", sha256: "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1" };
const X264 = { version: "stable", git: "https://code.videolan.org/videolan/x264.git", commit: "b35605ace3ddf7c1a5d67a2eb553f034aef41d55" };
const VPX = { version: "1.17.0", git: "https://chromium.googlesource.com/webm/libvpx", commit: "6df3ec34557879fff673706f4a1d9fbd0f3a6f0e" };
const MACOS = "14.0";

/** What the engine asks ffmpeg for; the build is checked for every one. */
const NEEDS = {
  encoders: ["libx264", "prores_ks", "aac", "libvpx-vp9", "libopus", "gif", "png", "mjpeg"],
  filters: ["scale", "format", "fps", "palettegen", "paletteuse", "anullsrc", "trim", "atrim", "setpts", "asetpts", "afade", "xfade", "volume", "select", "showinfo", "concat", "color", "amix", "aformat", "adelay"],
  demuxers: ["mov", "matroska", "image2pipe", "rawvideo", "mp3", "wav", "aiff", "ogg", "flac"],
  muxers: ["mp4", "mov", "webm", "gif", "image2", "null", "s16le"],
};

export const ffmpegKey = `ffmpeg-${FFMPEG.version}-x264-${X264.commit.slice(0, 7)}-vpx-${VPX.version}-opus-${OPUS.version}`;

/**
 * The built ffmpeg (built first if it isn't yet): its binary, the licences that go with it, the
 * exact source it was built from, and a notice saying what it is.
 */
export function ffmpegBuild({ quiet = false } = {}) {
  const out = path.join(vendor, ffmpegKey);
  const done = {
    bin: path.join(out, "ffmpeg"),
    licenses: path.join(out, "licenses"),
    sources: path.join(out, "sources"),
    notice: path.join(out, "NOTICE.txt"),
  };
  if (existsSync(path.join(out, "ok"))) return done;
  const say = quiet ? () => undefined : (s) => console.log(`  · ${s}`);

  for (const [tool, args] of [["clang", ["--version"]], ["make", ["--version"]], ["git", ["--version"]], ["pkg-config", ["--version"]]]) {
    const r = spawnSync(tool, args, { stdio: "ignore" });
    if (r.error || r.status !== 0) throw new Error(`Building ffmpeg needs ${tool}. ${tool === "pkg-config" ? "Install it with `brew install pkgconf`." : "Install Xcode's command line tools: xcode-select --install"}`);
  }

  // Built in a temporary folder: its path is written into the binary, and shouldn't name anyone's home.
  const work = path.join(tmpdir(), `screenshotter-${ffmpegKey}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const prefix = path.join(work, "prefix");
  const log = path.join(work, "build.log");
  writeFileSync(log, "");
  const env = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: MACOS,
    // Only our own libraries are found: nothing from Homebrew ends up linked in.
    PKG_CONFIG_LIBDIR: path.join(prefix, "lib", "pkgconfig"),
    PKG_CONFIG_PATH: "",
    CFLAGS: `-O2 -mmacosx-version-min=${MACOS}`,
    LDFLAGS: `-mmacosx-version-min=${MACOS}`,
  };
  const run = (cmd, args, cwd) => {
    writeFileSync(log, `\n$ ${cmd} ${args.join(" ")}\n`, { flag: "a" });
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    writeFileSync(log, `${r.stdout ?? ""}${r.stderr ?? ""}`, { flag: "a" });
    if (r.error || r.status !== 0) {
      const tail = readFileSync(log, "utf8").trim().split("\n").slice(-25).join("\n");
      throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}… failed in ${cwd}:\n${tail}\n(full log: ${log})`);
    }
    return r.stdout;
  };
  const jobs = String(cpus().length);

  // Sources, checked against their pins.
  const src = path.join(vendor, "src");
  mkdirSync(src, { recursive: true });
  const tarball = (p) => {
    const file = path.join(src, path.basename(p.url));
    if (!existsSync(file)) {
      say(`Downloading ${path.basename(p.url)}`);
      run("curl", ["-fsSL", "--retry", "3", "-o", `${file}.part`, p.url], src);
      renameSync(`${file}.part`, file);
    }
    const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (sum !== p.sha256) {
      rmSync(file, { force: true });
      throw new Error(`${path.basename(p.url)} isn't the file it should be (sha256 ${sum}, expected ${p.sha256}). It was deleted; try again.`);
    }
    run("tar", ["-xf", file, "-C", work], work);
    return { file, dir: path.join(work, path.basename(p.url).replace(/\.tar\.(xz|gz|bz2)$/, "")) };
  };
  const checkout = (name, p) => {
    const archive = path.join(src, `${name}-${p.commit.slice(0, 12)}.tar.gz`);
    const dir = path.join(work, name);
    if (!existsSync(archive)) {
      say(`Fetching ${name} at ${p.commit.slice(0, 12)}`);
      const repo = path.join(work, `${name}-git`);
      mkdirSync(repo);
      run("git", ["init", "-q"], repo);
      run("git", ["fetch", "-q", "--depth", "1", p.git, p.commit], repo);
      const head = run("git", ["rev-parse", "FETCH_HEAD"], repo).trim();
      if (head !== p.commit) throw new Error(`${name}: fetched ${head}, expected ${p.commit}`);
      run("git", ["archive", "--format=tar.gz", `--prefix=${name}-${p.commit.slice(0, 12)}/`, "-o", `${archive}.part`, p.commit], repo);
      renameSync(`${archive}.part`, archive);
    }
    run("tar", ["-xf", archive, "-C", work], work);
    renameSync(path.join(work, `${name}-${p.commit.slice(0, 12)}`), dir);
    return { file: archive, dir };
  };

  const ff = tarball(FFMPEG);
  const opus = tarball(OPUS);
  const x264 = checkout("x264", X264);
  const vpx = checkout("libvpx", VPX);

  say("Building x264");
  run("./configure", [`--prefix=${prefix}`, "--enable-static", "--enable-pic", "--disable-cli", "--disable-opencl", `--extra-cflags=-mmacosx-version-min=${MACOS}`, `--extra-ldflags=-mmacosx-version-min=${MACOS}`], x264.dir);
  run("make", ["-j", jobs], x264.dir);
  run("make", ["install"], x264.dir);

  say("Building libvpx");
  const vpxBuild = path.join(work, "libvpx-build");
  mkdirSync(vpxBuild);
  run(path.join(vpx.dir, "configure"), [`--prefix=${prefix}`, "--target=arm64-darwin23-gcc", "--enable-static", "--disable-shared", "--enable-pic", "--enable-vp8", "--enable-vp9", "--disable-examples", "--disable-tools", "--disable-docs", "--disable-unit-tests", `--extra-cflags=-mmacosx-version-min=${MACOS}`], vpxBuild);
  run("make", ["-j", jobs], vpxBuild);
  run("make", ["install"], vpxBuild);

  say("Building Opus");
  run("./configure", [`--prefix=${prefix}`, "--enable-static", "--disable-shared", "--disable-doc", "--disable-extra-programs"], opus.dir);
  run("make", ["-j", jobs], opus.dir);
  run("make", ["install"], opus.dir);

  say(`Building FFmpeg ${FFMPEG.version}`);
  const flags = [
    `--prefix=${path.join(work, "out")}`,
    "--cc=clang",
    "--enable-gpl",
    "--enable-libx264",
    "--enable-libvpx",
    "--enable-libopus",
    // Nothing found by looking around (Homebrew's libraries): only what's asked for here.
    "--disable-autodetect",
    "--enable-pthreads",
    "--enable-videotoolbox",
    "--enable-audiotoolbox",
    "--enable-zlib",
    "--disable-ffplay",
    "--disable-ffprobe",
    "--disable-doc",
    "--disable-network",
    "--disable-debug",
    "--disable-indevs",
    "--enable-indev=lavfi",
    "--disable-outdevs",
    "--pkg-config-flags=--static",
    `--extra-cflags=-I${path.join(prefix, "include")} -mmacosx-version-min=${MACOS}`,
    `--extra-ldflags=-L${path.join(prefix, "lib")} -mmacosx-version-min=${MACOS}`,
  ];
  run("./configure", flags, ff.dir);
  run("make", ["-j", jobs, "ffmpeg"], ff.dir);
  const bin = path.join(ff.dir, "ffmpeg");

  say("Checking it");
  const links = run("otool", ["-L", bin], work).trim().split("\n").slice(1).map((l) => l.trim().split(" ")[0]);
  const foreign = links.filter((l) => !l.startsWith("/usr/lib/") && !l.startsWith("/System/Library/"));
  if (foreign.length) throw new Error(`ffmpeg links to libraries other Macs won't have: ${foreign.join(", ")}`);
  const list = (what) => run(bin, ["-hide_banner", `-${what}`], work);
  for (const [what, names] of Object.entries(NEEDS)) {
    const have = list(what);
    const missing = names.filter((n) => !new RegExp(`^\\s*\\S+\\s+${n.replace(/[-+]/g, "\\$&")}(\\s|,)`, "m").test(have));
    if (missing.length) throw new Error(`The built ffmpeg is missing ${what}: ${missing.join(", ")}`);
  }

  // The binary, its licences, its source, and what it is.
  const stage = path.join(work, "done");
  mkdirSync(path.join(stage, "licenses"), { recursive: true });
  mkdirSync(path.join(stage, "sources"), { recursive: true });
  copyFileSync(bin, path.join(stage, "ffmpeg"));
  const license = (name, files) => writeFileSync(path.join(stage, "licenses", `${name}.txt`), files.map((f) => readFileSync(f, "utf8")).join("\n\n"));
  license("FFmpeg", [path.join(ff.dir, "LICENSE.md"), path.join(ff.dir, "COPYING.GPLv2")]);
  license("x264", [path.join(x264.dir, "COPYING")]);
  license("libvpx", [path.join(vpx.dir, "LICENSE"), path.join(vpx.dir, "PATENTS")]);
  license("Opus", [path.join(opus.dir, "COPYING")]);
  for (const s of [ff, opus, x264, vpx]) copyFileSync(s.file, path.join(stage, "sources", path.basename(s.file)));
  writeFileSync(
    path.join(stage, "NOTICE.txt"),
    `Screenshotter includes ffmpeg, a program from the FFmpeg project (https://ffmpeg.org), which it uses to make and edit videos.
It is built from these sources, unchanged:

  FFmpeg ${FFMPEG.version}     ${FFMPEG.url}
  x264 (stable)    ${X264.git} at ${X264.commit}
  libvpx ${VPX.version}    ${VPX.git} at ${VPX.commit}
  Opus ${OPUS.version}       ${OPUS.url}

Because it includes x264, this ffmpeg is licensed under the GNU General Public License, version 2 or
later; libvpx and Opus are under BSD licences. Their licences are in this folder. The exact source
code of each is offered for download next to each release of Screenshotter, at
https://screenshotter-umber.vercel.app/downloads/sources/

FFmpeg was configured with:
  ${flags.filter((f) => !f.startsWith("--prefix") && !f.startsWith("--extra-")).join(" ")}
and built for macOS ${MACOS} or later (arm64) by scripts/build-ffmpeg.mjs in Screenshotter's repository.
`,
  );
  writeFileSync(path.join(stage, "ok"), `${new Date().toISOString()}\n`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(vendor, { recursive: true });
  cpSync(stage, out, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = Date.now();
  console.log(`▸ ffmpeg for the app (${ffmpegKey})`);
  const b = ffmpegBuild();
  console.log(`✓ ${path.relative(root, b.bin)} (${Math.round((Date.now() - t) / 1000)} s)`);
}

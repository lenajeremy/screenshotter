/**
 * Cloud account, teams, team boards and team assets.
 *
 * Talks to the collaboration server (server/): device sign-in for the Mac app, Better Auth teams
 * and invitations, team boards, and content-addressed pictures cached locally so the canvas and
 * headless exports read them quickly without exposing the bearer token to the page.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mapCssUrls, mapSvgImages, svgImageAttrs, type Board, type BoardNode, type Op } from "../board/core.js";
import { boardThumb, clearSyncMeta, deleteBoard, getBoard, setSyncMeta, writeSyncedBoard } from "../board/store.js";
import { cacheDir, ensureDir, outputRoot, resolveUserPath } from "../util/files.js";

export const DEFAULT_SERVER_URL = "https://glassine.thesunset.live";
const MAC_CLIENT_ID = "glassine-mac";

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface CloudTeam {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface TeamBoardSummary {
  id: string;
  teamId: string;
  name: string;
  rev: number;
  updatedAt: string;
  thumb?: string;
  thumbAt?: number;
}

export interface TeamMember {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string; image?: string | null };
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt?: string;
}

interface StoredAccount {
  serverUrl?: string;
  /** Kept in .studio/account.json (0600) outside the Mac app; inside the app Keychain holds it. */
  token?: string;
  user?: CloudUser;
  teams?: CloudTeam[];
}

const accountFile = () => {
  const dir = path.join(outputRoot(), ".studio");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "account.json");
};

function readStored(): StoredAccount {
  try {
    const raw = readFileSync(accountFile(), "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? (data as StoredAccount) : {};
  } catch {
    return {};
  }
}

function writeStored(next: StoredAccount): void {
  const file = accountFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, file);
}

/** In-memory token for this run (takes precedence over env/disk once signed in or signed out). */
let memoryToken: string | null = null;
let memoryServerUrl: string | null = null;

export function normalizeServerUrl(url?: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return DEFAULT_SERVER_URL;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProto.replace(/\/+$/, "");
}

export function serverUrl(): string {
  if (memoryServerUrl) return memoryServerUrl;
  const env = process.env.GLASSINE_SERVER_URL || process.env.SCREENSHOTTER_SERVER_URL;
  if (env?.trim()) return normalizeServerUrl(env);
  const stored = readStored().serverUrl;
  return stored ? normalizeServerUrl(stored) : DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  memoryServerUrl = normalized;
  const cur = readStored();
  writeStored({ ...cur, serverUrl: normalized });
  return normalized;
}

export function authToken(): string {
  if (memoryToken !== null) return memoryToken;
  const env = process.env.GLASSINE_AUTH_TOKEN?.trim();
  if (env) return env;
  return readStored().token?.trim() ?? "";
}

export function setAuthToken(token: string, persistToFile = true): void {
  const clean = token.trim();
  memoryToken = clean;
  if (clean) process.env.GLASSINE_AUTH_TOKEN = clean;
  else delete process.env.GLASSINE_AUTH_TOKEN;
  const cur = readStored();
  if (persistToFile) {
    if (clean) writeStored({ ...cur, serverUrl: serverUrl(), token: clean });
    else {
      const { token: _t, user: _u, teams: _ts, ...rest } = cur;
      writeStored(rest);
    }
  } else if (!clean) {
    const { token: _t, user: _u, teams: _ts, ...rest } = cur;
    writeStored(rest);
  }
}

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Call the collaboration server with our Bearer token and Origin header. */
export async function cloudFetch<T = any>(
  route: string,
  opts: { method?: string; body?: unknown; raw?: Buffer | Uint8Array; contentType?: string; token?: string; base?: string; timeoutMs?: number } = {},
): Promise<T> {
  const base = opts.base ?? serverUrl();
  const token = opts.token ?? authToken();
  const headers: Record<string, string> = { Origin: base };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    headers["Content-Type"] = opts.contentType || "application/octet-stream";
    body = Buffer.from(opts.raw);
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${base}${route}`, {
      method: opts.method ?? (body !== undefined ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new CloudError(0, `Couldn't reach the server at ${base}.`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    const msg = json?.error_description || json?.message || json?.error || `Server returned HTTP ${res.status}`;
    throw new CloudError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return json as T;
}

// ---------------------------------------------------------------------------------------------
// Device sign-in (Mac app approves a code in the browser, gets a Bearer token)

export interface DeviceSignInState {
  status: "idle" | "pending" | "approved" | "denied" | "expired" | "error";
  serverUrl: string;
  userCode?: string;
  displayCode?: string;
  verificationUrl?: string;
  user?: CloudUser;
  teams?: CloudTeam[];
  error?: string;
  /** Handed once to the Mac app so it can keep the token in Keychain. */
  token?: string;
}

interface ActiveDeviceFlow {
  id: number;
  deviceCode: string;
  userCode: string;
  displayCode: string;
  verificationUrl: string;
  serverUrl: string;
  intervalMs: number;
  expiresAt: number;
  status: DeviceSignInState["status"];
  user?: CloudUser;
  teams?: CloudTeam[];
  error?: string;
  token?: string;
  timer?: NodeJS.Timeout;
  cancelled?: boolean;
}

let flowSeq = 0;
let activeFlow: ActiveDeviceFlow | null = null;

function stopFlow(flow: ActiveDeviceFlow | null) {
  if (!flow) return;
  flow.cancelled = true;
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = undefined;
}

export async function startDeviceSignIn(customServerUrl?: string): Promise<DeviceSignInState> {
  stopFlow(activeFlow);
  const base = customServerUrl?.trim() ? setServerUrl(customServerUrl) : serverUrl();
  const data = await cloudFetch<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  }>("/api/auth/device/code", { method: "POST", body: { client_id: MAC_CLIENT_ID }, token: "", base });

  const code = String(data.user_code ?? "").toUpperCase();
  const displayCode = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  const verificationUrl = data.verification_uri_complete || `${base}/device?user_code=${encodeURIComponent(code)}`;
  const flow: ActiveDeviceFlow = {
    id: ++flowSeq,
    deviceCode: data.device_code,
    userCode: code,
    displayCode,
    verificationUrl,
    serverUrl: base,
    intervalMs: Math.max(2000, Number(data.interval || 2) * 1000) + 150,
    expiresAt: Date.now() + Number(data.expires_in || 900) * 1000,
    status: "pending",
  };
  activeFlow = flow;
  schedulePoll(flow);
  return deviceSignInStatus();
}

function schedulePoll(flow: ActiveDeviceFlow) {
  if (flow.cancelled || flow.status !== "pending") return;
  flow.timer = setTimeout(() => void pollDevice(flow), flow.intervalMs);
  flow.timer.unref?.();
}

async function pollDevice(flow: ActiveDeviceFlow) {
  if (flow.cancelled || activeFlow?.id !== flow.id || flow.status !== "pending") return;
  if (Date.now() > flow.expiresAt) {
    flow.status = "expired";
    flow.error = "That sign-in code expired. Start again.";
    return;
  }
  try {
    const res = await fetch(`${flow.serverUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: flow.serverUrl },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: flow.deviceCode,
        client_id: MAC_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (flow.cancelled || activeFlow?.id !== flow.id) return;
    if (json.access_token) {
      setServerUrl(flow.serverUrl);
      const persistToDisk = process.env.SCREENSHOTTER_APP !== "1" || process.env.SCREENSHOTTER_NO_KEYCHAIN === "1";
      setAuthToken(json.access_token, persistToDisk);
      // Also write token into account.json in all non-keychain setups; in native app UI saves to Keychain too.
      // Keep a fallback copy in 0600 account.json unless explicitly disabled so local studio restarts keep it.
      if (!persistToDisk) {
        const cur = readStored();
        writeStored({ ...cur, serverUrl: flow.serverUrl, token: json.access_token });
      }
      const me = await cloudFetch<{ user: CloudUser; teams: CloudTeam[] }>("/api/me", { token: json.access_token, base: flow.serverUrl });
      const cur = readStored();
      writeStored({ ...cur, serverUrl: flow.serverUrl, user: me.user, teams: me.teams });
      flow.user = me.user;
      flow.teams = me.teams;
      flow.token = json.access_token;
      flow.status = "approved";
      return;
    }
    if (json.error === "authorization_pending") {
      schedulePoll(flow);
      return;
    }
    if (json.error === "slow_down") {
      flow.intervalMs = Math.min(10_000, flow.intervalMs + 2000);
      schedulePoll(flow);
      return;
    }
    if (json.error === "access_denied") {
      flow.status = "denied";
      flow.error = "Sign-in was cancelled in your browser.";
      return;
    }
    if (json.error === "expired_token") {
      flow.status = "expired";
      flow.error = "That sign-in code expired. Start again.";
      return;
    }
    flow.status = "error";
    flow.error = json.error_description || json.error || "Sign-in didn't finish.";
  } catch {
    // Transient network blip while waiting for the person to approve in the browser: keep polling.
    schedulePoll(flow);
  }
}

export function deviceSignInStatus(consumeToken = false): DeviceSignInState {
  if (!activeFlow) return { status: "idle", serverUrl: serverUrl() };
  const token = consumeToken ? activeFlow.token : undefined;
  if (consumeToken && activeFlow.token) activeFlow.token = undefined;
  return {
    status: activeFlow.status,
    serverUrl: activeFlow.serverUrl,
    userCode: activeFlow.userCode,
    displayCode: activeFlow.displayCode,
    verificationUrl: activeFlow.verificationUrl,
    user: activeFlow.user,
    teams: activeFlow.teams,
    error: activeFlow.error,
    ...(token ? { token } : {}),
  };
}

export function cancelDeviceSignIn(): void {
  stopFlow(activeFlow);
  activeFlow = null;
}

// ---------------------------------------------------------------------------------------------
// Email sign-in: a six-digit code, typed in the app itself

const cleanEmail = (email: string) => email.trim().toLowerCase();

/** Email a six-digit sign-in code. */
export async function sendEmailCode(email: string): Promise<{ email: string }> {
  const to = cleanEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new CloudError(400, "That doesn't look like an email address.");
  await cloudFetch("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: to, type: "sign-in" }, token: "" });
  return { email: to };
}

/** Sign in with the code from the email: keeps the session as the device flow does. */
export async function signInWithEmailCode(email: string, code: string): Promise<{ user: CloudUser; teams: CloudTeam[]; token: string }> {
  const base = serverUrl();
  const otp = code.replace(/\D/g, "");
  if (otp.length !== 6) throw new CloudError(400, "The code has six digits.");
  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/sign-in/email-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ email: cleanEmail(email), otp }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new CloudError(0, "Couldn't reach Glassine. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string; code?: string };
  if (!res.ok) {
    const why = `${body.code ?? ""} ${body.message ?? ""}`.toLowerCase();
    throw new CloudError(res.status, /expire/.test(why) ? "That code has expired. Send a new one." : /attempt/.test(why) ? "Too many tries. Send a new code." : "That code isn't right. Check it and try again.");
  }
  const token = res.headers.get("set-auth-token") || body.token || "";
  if (!token) throw new CloudError(500, "Signed in, but the server sent no session. Try again.");
  const persistToDisk = process.env.SCREENSHOTTER_APP !== "1" || process.env.SCREENSHOTTER_NO_KEYCHAIN === "1";
  setAuthToken(token, persistToDisk);
  if (!persistToDisk) writeStored({ ...readStored(), serverUrl: base, token });
  const me = await cloudFetch<{ user: CloudUser; teams: CloudTeam[] }>("/api/me", { token, base });
  writeStored({ ...readStored(), serverUrl: base, user: me.user, teams: me.teams });
  return { user: me.user, teams: me.teams, token };
}

/** Change the name teammates see. */
export async function updateProfile(name: string): Promise<{ name: string }> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new CloudError(400, "A name can't be empty.");
  await cloudFetch("/api/auth/update-user", { method: "POST", body: { name: clean } });
  const cur = readStored();
  if (cur.user) writeStored({ ...cur, user: { ...cur.user, name: clean } });
  return { name: clean };
}

export async function signOut(): Promise<void> {
  stopFlow(activeFlow);
  activeFlow = null;
  const tok = authToken();
  if (tok) {
    await cloudFetch("/api/auth/sign-out", { method: "POST", body: {}, token: tok }).catch(() => undefined);
  }
  setAuthToken("", true);
}

// ---------------------------------------------------------------------------------------------
// Account & teams

export interface AccountInfo {
  signedIn: boolean;
  serverUrl: string;
  user?: CloudUser;
  teams: CloudTeam[];
  offline?: boolean;
  error?: string;
}

export async function getAccount(): Promise<AccountInfo> {
  const base = serverUrl();
  const tok = authToken();
  if (!tok) return { signedIn: false, serverUrl: base, teams: [] };
  try {
    const me = await cloudFetch<{ user: CloudUser; teams: CloudTeam[] }>("/api/me");
    const cur = readStored();
    writeStored({ ...cur, serverUrl: base, user: me.user, teams: me.teams });
    return { signedIn: true, serverUrl: base, user: me.user, teams: me.teams };
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) {
      setAuthToken("", true);
      return { signedIn: false, serverUrl: base, teams: [] };
    }
    const cached = readStored();
    return {
      signedIn: true,
      serverUrl: base,
      user: cached.user,
      teams: cached.teams ?? [],
      offline: true,
      error: (e as Error).message,
    };
  }
}

function slugifyTeam(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `team-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createTeam(name: string): Promise<CloudTeam> {
  const clean = name.trim();
  if (!clean) throw new CloudError(400, "A team needs a name.");
  const slug = slugifyTeam(clean);
  let created: { id: string; name: string; slug: string };
  try {
    created = await cloudFetch("/api/auth/organization/create", { method: "POST", body: { name: clean, slug } });
  } catch (e) {
    // Slug taken by another team: retry once with a short suffix.
    if (e instanceof CloudError && (e.status === 400 || e.status === 409)) {
      const suffix = Math.random().toString(36).slice(2, 6);
      created = await cloudFetch("/api/auth/organization/create", { method: "POST", body: { name: clean, slug: `${slug}-${suffix}` } });
    } else {
      throw e;
    }
  }
  return { id: created.id, name: created.name, slug: created.slug, role: "owner" };
}

export async function getTeamDetails(teamId: string): Promise<{ id: string; name: string; slug: string; members: TeamMember[]; invitations: TeamInvitation[] }> {
  const res = await cloudFetch<{
    id: string;
    name: string;
    slug: string;
    members?: TeamMember[];
    invitations?: TeamInvitation[];
  }>(`/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(teamId)}`);
  return {
    id: res.id,
    name: res.name,
    slug: res.slug,
    members: res.members ?? [],
    invitations: (res.invitations ?? []).filter((i) => i.status === "pending"),
  };
}

export async function inviteToTeam(teamId: string, email: string, role: "member" | "admin" = "member"): Promise<{ id: string }> {
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes("@")) throw new CloudError(400, "Enter an email address.");
  return cloudFetch("/api/auth/organization/invite-member", {
    method: "POST",
    body: { organizationId: teamId, email: clean, role },
  });
}

export async function cancelTeamInvitation(invitationId: string): Promise<void> {
  await cloudFetch("/api/auth/organization/cancel-invitation", {
    method: "POST",
    body: { invitationId },
  });
}

// ---------------------------------------------------------------------------------------------
// Team boards

export async function listTeamBoards(teamId: string): Promise<TeamBoardSummary[]> {
  const res = await cloudFetch<{ boards: Array<{ id: string; name: string; rev: number; updatedAt: string }> }>(`/api/teams/${encodeURIComponent(teamId)}/boards`);
  return (res.boards ?? []).map((b) => {
    const thumb = boardThumb(b.id);
    const hasThumb = existsSync(thumb);
    return {
      ...b,
      teamId,
      thumb: hasThumb ? thumb : undefined,
      thumbAt: hasThumb ? statSync(thumb).mtimeMs : undefined,
    };
  });
}

export async function createTeamBoard(teamId: string, name: string, board?: Partial<Board>): Promise<{ id: string; name: string; rev: number }> {
  return cloudFetch(`/api/teams/${encodeURIComponent(teamId)}/boards`, {
    method: "POST",
    body: { name: name.trim() || "Untitled board", ...(board ? { board } : {}) },
  });
}

export async function fetchTeamBoard(boardId: string): Promise<{ id: string; teamId: string; name: string; rev: number; role: string; doc: Board }> {
  return cloudFetch(`/api/boards/${encodeURIComponent(boardId)}`);
}

export async function renameTeamBoard(boardId: string, name: string): Promise<{ id: string; name: string }> {
  return cloudFetch(`/api/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", body: { name } });
}

export async function deleteTeamBoard(boardId: string): Promise<void> {
  await cloudFetch(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });
  clearSyncMeta(boardId);
  try {
    deleteBoard(boardId);
  } catch {
    // Not cached locally yet.
  }
}

// ---------------------------------------------------------------------------------------------
// Team assets: upload local files to /api/teams/:team/assets, cache downloads locally

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json",
};

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "application/json": ".json",
};

const uploadedCache = new Map<string, string>();
const isLocalRef = (src: string) => /^(\/|~|file:)/i.test(src) && !src.startsWith("/api/assets/");

export async function uploadTeamAsset(teamId: string, src: string): Promise<string> {
  if (!isLocalRef(src)) return src;
  const file = resolveUserPath(src.replace(/^file:\/\//i, ""));
  if (!existsSync(file)) return src;
  const st = statSync(file);
  if (!st.isFile() || st.size === 0 || st.size > 25 * 1024 * 1024) return src;
  const cacheKey = `${serverUrl()}|${teamId}|${file}|${st.size}|${st.mtimeMs}`;
  const hit = uploadedCache.get(cacheKey);
  if (hit) return hit;
  const bytes = readFileSync(file);
  const hash = createHash("sha1").update(bytes).digest("hex");
  const hashKey = `${serverUrl()}|${teamId}|sha1:${hash}`;
  const hashHit = uploadedCache.get(hashKey);
  if (hashHit) {
    uploadedCache.set(cacheKey, hashHit);
    return hashHit;
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = EXT_MIME[ext] ?? "application/octet-stream";
  const res = await cloudFetch<{ hash: string; url: string }>(`/api/teams/${encodeURIComponent(teamId)}/assets`, {
    method: "POST",
    raw: bytes,
    contentType,
    timeoutMs: 60_000,
  });
  uploadedCache.set(cacheKey, res.url);
  uploadedCache.set(hashKey, res.url);
  // Seed local download cache so rendering this asset back needs no extra round trip.
  saveAssetCache(teamId, res.hash, contentType, bytes);
  return res.url;
}

const assetCacheDir = () => ensureDir(cacheDir("team-assets"));
const safePart = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");

function saveAssetCache(teamId: string, hash: string, mime: string, bytes: Buffer): { file: string; mime: string } {
  const dir = assetCacheDir();
  const stem = `${safePart(teamId)}-${safePart(hash)}`;
  const ext = MIME_EXT[mime.split(";")[0].trim().toLowerCase()] ?? "";
  const file = path.join(dir, `${stem}${ext}`);
  const meta = path.join(dir, `${stem}.meta.json`);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  }
  writeFileSync(meta, JSON.stringify({ file, mime }));
  return { file, mime };
}

export function cachedTeamAsset(teamId: string, hash: string): { file: string; mime: string } | null {
  const meta = path.join(assetCacheDir(), `${safePart(teamId)}-${safePart(hash)}.meta.json`);
  try {
    const m = JSON.parse(readFileSync(meta, "utf8")) as { file: string; mime: string };
    if (m.file && existsSync(m.file)) return m;
  } catch {}
  return null;
}

const assetDownloads = new Map<string, Promise<{ file: string; mime: string }>>();

export async function downloadTeamAsset(teamId: string, hash: string): Promise<{ file: string; mime: string }> {
  const hit = cachedTeamAsset(teamId, hash);
  if (hit) return hit;
  const key = `${teamId}/${hash}`;
  const inflight = assetDownloads.get(key);
  if (inflight) return inflight;
  const job = (async () => {
    const tok = authToken();
    if (!tok) throw new CloudError(401, "Sign in to load team pictures.");
    const base = serverUrl();
    const res = await fetch(`${base}/api/assets/${encodeURIComponent(teamId)}/${encodeURIComponent(hash)}`, {
      headers: { Authorization: `Bearer ${tok}`, Origin: base },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new CloudError(res.status, `Couldn't fetch team asset (${res.status}).`);
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await res.arrayBuffer());
    return saveAssetCache(teamId, hash, mime, bytes);
  })().finally(() => assetDownloads.delete(key));
  assetDownloads.set(key, job);
  return job;
}

/** Collect every local file path referenced inside a node (or style/SVG) and upload it once. */
async function rewriteNodeAssets(teamId: string, n: BoardNode, map: Map<string, string>): Promise<BoardNode> {
  const out: BoardNode = { ...n, style: { ...n.style } };
  const resolve = async (src: string) => {
    if (!isLocalRef(src)) return src;
    let url = map.get(src);
    if (!url) {
      url = await uploadTeamAsset(teamId, src);
      map.set(src, url);
    }
    return url;
  };
  if (out.src && isLocalRef(out.src)) out.src = await resolve(out.src);
  if (out.poster && isLocalRef(out.poster)) out.poster = await resolve(out.poster);
  for (const [k, v] of Object.entries(out.style)) {
    if (typeof v !== "string" || !v.includes("url(")) continue;
    const refs: string[] = [];
    mapCssUrls(v, (s) => (isLocalRef(s) && refs.push(s), s));
    if (!refs.length) continue;
    for (const r of refs) await resolve(r);
    out.style[k] = mapCssUrls(v, (s) => map.get(s) ?? s);
  }
  if (out.type === "svg" || out.type === "vector") {
    const refs: string[] = [];
    if (out.attrs) svgImageAttrs(out.tag, out.attrs, (s) => (isLocalRef(s) && refs.push(s), s));
    for (const k of ["svg", "defs", "text"] as const) if (out[k]) mapSvgImages(out[k]!, (s) => (isLocalRef(s) && refs.push(s), s));
    if (refs.length) {
      for (const r of refs) await resolve(r);
      if (out.attrs) out.attrs = svgImageAttrs(out.tag, out.attrs, (s) => map.get(s) ?? s);
      for (const k of ["svg", "defs", "text"] as const) if (out[k]) out[k] = mapSvgImages(out[k]!, (s) => map.get(s) ?? s);
    }
  }
  return out;
}

/** Upload every local picture/video/font referenced by a list of operations, returning rewritten ops. */
export async function rewriteOpsAssets(teamId: string, ops: Op[]): Promise<Op[]> {
  const map = new Map<string, string>();
  const out: Op[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      const nodes: Record<string, BoardNode> = {};
      for (const [id, n] of Object.entries(op.nodes)) nodes[id] = await rewriteNodeAssets(teamId, n, map);
      out.push({ ...op, nodes });
    } else if (op.op === "set") {
      let next = { ...op };
      if (typeof next.src === "string" && isLocalRef(next.src)) next.src = await uploadTeamAsset(teamId, next.src);
      if (typeof next.poster === "string" && isLocalRef(next.poster)) next.poster = await uploadTeamAsset(teamId, next.poster);
      if (next.style) {
        const style = { ...next.style };
        for (const [k, v] of Object.entries(style)) {
          if (typeof v !== "string" || !v.includes("url(")) continue;
          const refs: string[] = [];
          mapCssUrls(v, (s) => (isLocalRef(s) && refs.push(s), s));
          for (const r of refs) if (!map.has(r)) map.set(r, await uploadTeamAsset(teamId, r));
          if (refs.length) style[k] = mapCssUrls(v, (s) => map.get(s) ?? s);
        }
        next.style = style;
      }
      if (next.replaceStyle) {
        const style = { ...next.replaceStyle };
        for (const [k, v] of Object.entries(style)) {
          if (typeof v !== "string" || !v.includes("url(")) continue;
          const refs: string[] = [];
          mapCssUrls(v, (s) => (isLocalRef(s) && refs.push(s), s));
          for (const r of refs) if (!map.has(r)) map.set(r, await uploadTeamAsset(teamId, r));
          if (refs.length) style[k] = mapCssUrls(v, (s) => map.get(s) ?? s);
        }
        next.replaceStyle = style;
      }
      if (typeof next.svg === "string") {
        const refs: string[] = [];
        mapSvgImages(next.svg, (s) => (isLocalRef(s) && refs.push(s), s));
        for (const r of refs) if (!map.has(r)) map.set(r, await uploadTeamAsset(teamId, r));
        if (refs.length) next.svg = mapSvgImages(next.svg, (s) => map.get(s) ?? s);
      }
      if (typeof next.defs === "string") {
        const refs: string[] = [];
        mapSvgImages(next.defs, (s) => (isLocalRef(s) && refs.push(s), s));
        for (const r of refs) if (!map.has(r)) map.set(r, await uploadTeamAsset(teamId, r));
        if (refs.length) next.defs = mapSvgImages(next.defs, (s) => map.get(s) ?? s);
      }
      out.push(next);
    } else if (op.op === "replace") {
      const nodes: Record<string, BoardNode> = {};
      for (const [id, n] of Object.entries(op.nodes)) nodes[id] = await rewriteNodeAssets(teamId, n, map);
      out.push({ ...op, nodes });
    } else if (op.op === "font") {
      const src = isLocalRef(op.font.src) ? await uploadTeamAsset(teamId, op.font.src) : op.font.src;
      out.push({ ...op, font: { ...op.font, src } });
    } else {
      out.push(op);
    }
  }
  return out;
}

/** Upload every local asset referenced by a whole board and move (or copy, for scratchpad) it into a team. */
export async function moveLocalBoardToTeam(localBoardId: string, teamId: string, teamName?: string): Promise<{ id: string; teamId: string; name: string }> {
  const local = getBoard(localBoardId);
  const map = new Map<string, string>();
  const nodes: Record<string, BoardNode> = {};
  for (const [id, n] of Object.entries(local.nodes)) nodes[id] = await rewriteNodeAssets(teamId, n, map);
  const fonts = await Promise.all((local.fonts ?? []).map(async (f) => ({ ...f, src: isLocalRef(f.src) ? await uploadTeamAsset(teamId, f.src) : f.src })));
  const uploaded: Partial<Board> = {
    pages: local.pages,
    nodes,
    tokens: local.tokens,
    fonts,
    shaders: local.shaders ?? [],
  };
  const created = await createTeamBoard(teamId, local.name, uploaded);
  const fetched = await fetchTeamBoard(created.id);
  setSyncMeta({ boardId: fetched.id, teamId, teamName, serverUrl: serverUrl(), syncedRev: fetched.rev });
  writeSyncedBoard({ ...fetched.doc, id: fetched.id, name: fetched.name, rev: fetched.rev });
  // Moving removes the old unlinked local file; the scratchpad stays local as a copy.
  if (localBoardId !== "scratchpad") {
    try {
      deleteBoard(localBoardId);
    } catch {}
  }
  return { id: fetched.id, teamId, name: fetched.name };
}

/** Ensure every /api/assets/:team/:hash referenced by a board is cached locally for headless exports/thumbnails. */
export async function ensureBoardTeamAssets(board: Board): Promise<Map<string, string>> {
  const found = new Set<string>();
  const scan = (s?: string) => {
    if (!s) return;
    for (const m of s.matchAll(/\/api\/assets\/([^/"')]+)\/([a-f0-9]{16,64})/gi)) found.add(`${m[1]}/${m[2]}`);
  };
  for (const n of Object.values(board.nodes)) {
    scan(n.src);
    scan(n.poster);
    for (const v of Object.values(n.style)) scan(v);
    if (n.svg) scan(n.svg);
    if (n.defs) scan(n.defs);
    if (n.attrs) for (const v of Object.values(n.attrs)) scan(v);
  }
  for (const f of board.fonts ?? []) scan(f.src);
  const resolved = new Map<string, string>();
  await Promise.all(
    [...found].map(async (pair) => {
      const [team, hash] = pair.split("/");
      try {
        const hit = await downloadTeamAsset(team, hash);
        resolved.set(`/api/assets/${team}/${hash}`, hit.file);
      } catch {
        // Offline or deleted: leave unresolved.
      }
    }),
  );
  return resolved;
}

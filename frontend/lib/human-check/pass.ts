/**
 * The human check in front of the site: Cloudflare Turnstile (ADR 013).
 *
 * Off unless the operator sets `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
 * Then a visitor without a pass is sent to `/human-check`, solves the widget
 * once, and `/api/human-check` checks the token with Cloudflare and sets a
 * **pass**: a cookie holding its expiry and an HMAC of it, keyed with the
 * Turnstile secret. `proxy.ts` checks the pass on every page and API request —
 * locally, with no call to Cloudflare — so a visitor is challenged once per
 * `TURNSTILE_PASS_HOURS`, not once per page.
 *
 * The pass says "this browser solved a challenge recently", nothing more: it
 * holds no identity, no address and no account. Rotating the secret ends every
 * pass at once.
 *
 * Web Crypto only, so the same code runs in the proxy, the route handler and
 * the tests.
 */

export const PASS_COOKIE = "dice_human_pass";
export const CHECK_PATH = "/human-check";
export const VERIFY_PATH = "/api/human-check";
/** The action the widget is rendered with, and the only one a token is accepted for. */
export const TURNSTILE_ACTION = "site-access";
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's own limit on a token's length. */
export const MAX_TOKEN_LENGTH = 2048;

const DEFAULT_PASS_HOURS = 24;
const PASS_VERSION = "v1";

export type HumanCheckConfig = { siteKey: string; secretKey: string; passSeconds: number };

/** The check's settings, or null when the deployment has not turned it on. */
export function humanCheckConfig(env: Record<string, string | undefined> = process.env): HumanCheckConfig | null {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? "").trim();
  const secretKey = (env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (!siteKey || !secretKey) return null;
  const hours = Number(env.TURNSTILE_PASS_HOURS ?? DEFAULT_PASS_HOURS);
  // At least a minute, at most thirty days: a pass for ever is no check at all.
  const passSeconds = Math.round(Math.min(720, Math.max(1 / 60, Number.isFinite(hours) ? hours : DEFAULT_PASS_HOURS)) * 3600);
  return { siteKey, secretKey, passSeconds };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** What is signed: the version and the expiry, so a pass cannot be stretched. */
const message = (expires: number) => encoder.encode(`dice-ifc.human-pass.${PASS_VERSION}.${expires}`);

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A pass valid for `seconds` from `now` (milliseconds), as the cookie's value. */
export async function issuePass(secret: string, seconds: number, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + seconds;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, "sign"), message(expires)));
  return `${PASS_VERSION}.${expires}.${base64url(signature)}`;
}

/** Whether a cookie value is a pass this deployment issued and that has not expired. */
export async function verifyPass(value: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!value || value.length > 200) return false;
  const [version, expiresText, signatureText, ...rest] = value.split(".");
  if (version !== PASS_VERSION || rest.length > 0 || !/^\d{1,12}$/.test(expiresText ?? "")) return false;
  const expires = Number(expiresText);
  if (expires * 1000 <= now) return false;
  const signature = fromBase64url(signatureText ?? "");
  if (!signature) return false;
  // `verify` compares in constant time.
  return crypto.subtle.verify("HMAC", await key(secret, "verify"), signature as BufferSource, message(expires));
}

// ---------------------------------------------------------------------------
// What needs one
// ---------------------------------------------------------------------------

/**
 * Open to everyone: the check itself, and the privacy page, so a visitor can
 * read what the check sends to Cloudflare before it runs.
 */
const OPEN_PATHS = new Set([CHECK_PATH, VERIFY_PATH, "/privacy"]);

/**
 * What a request without a pass gets: pages are sent to the check, API calls
 * are refused, and static files go through — they are the same for everyone,
 * and a worker or WASM fetch that does not carry the cookie must not break the
 * app for someone who did pass.
 */
export function gateFor(pathname: string): "page" | "api" | null {
  if (OPEN_PATHS.has(pathname)) return null;
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (last.includes(".")) return null;
  return "page";
}

/**
 * Where to go once the check is passed: a path on this site, never another
 * site (`//evil.example`, `/\evil.example`) and never the check itself.
 */
export function safeNext(value: string | null | undefined): string {
  const next = (value ?? "").trim();
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.length > 2048) return "/";
  if (/[\u0000-\u001f]/.test(next)) return "/";
  if (next === CHECK_PATH || next.startsWith(`${CHECK_PATH}?`) || next.startsWith(`${CHECK_PATH}/`)) return "/";
  return next;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export type TokenCheck = { ok: true } | { ok: false; reason: "invalid" | "unreachable"; codes: string[] };

/**
 * Ask Cloudflare whether a widget token is good. Tokens are single use and
 * last five minutes; Cloudflare enforces both. Only the secret and the token
 * are sent — not the visitor's address, which the API takes but does not need.
 */
export async function checkToken(
  token: string,
  config: HumanCheckConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenCheck> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid", codes: ["bad-token"] };
  let answer: { success?: unknown; action?: unknown; "error-codes"?: unknown };
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.secretKey, response: token }).toString(),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    answer = (await response.json()) as typeof answer;
  } catch {
    // Cloudflare unreachable: fail closed — this is the door, and it stays shut.
    return { ok: false, reason: "unreachable", codes: [] };
  }
  const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].map(String) : [];
  if (answer.success !== true) return { ok: false, reason: "invalid", codes };
  // A token from a widget rendered for something else is not a token for this.
  // Cloudflare's test keys answer with no action, so only a different one is refused.
  if (typeof answer.action === "string" && answer.action !== "" && answer.action !== TURNSTILE_ACTION) {
    return { ok: false, reason: "invalid", codes: ["wrong-action"] };
  }
  return { ok: true };
}

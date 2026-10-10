"use client";

/**
 * Where the browser is paired with a signing companion, and how it gets there.
 *
 * ## Nothing to type
 *
 * The URL is fixed — the companion binds `127.0.0.1:8765` and there is no
 * reason for a citizen to know that. The token is fetched from the companion's
 * `/pair` endpoint the first time it is needed and cached here.
 *
 * The token is a **local pairing secret**, not a credential for any remote
 * service: it exists so that a random web page cannot drive the card of whoever
 * happens to be running the companion. The companion only hands it to an
 * allow-listed `Origin`, which a page cannot forge because the browser sets it.
 * See `companion/dice_companion/server.py` for why that is the control that
 * matters, and why a fixed token compiled into both sides would have been
 * worse than none.
 *
 * `localStorage` rather than a cookie: it must never be attached to a request
 * to our own API, and a cookie would be.
 *
 * The companion generates a fresh token every time it starts, so a cached one
 * goes stale on every restart. That is handled rather than surfaced —
 * {@link pairWithCompanion} re-pairs on a 403, so a restarted companion costs
 * one extra round trip instead of an error the citizen has to understand.
 */

const URL_KEY = "dice-ifc.companion.url";
const TOKEN_KEY = "dice-ifc.companion.token";

export const DEFAULT_COMPANION_URL = "http://127.0.0.1:8765";

/** Pairing is a localhost round trip; it either answers at once or is not there. */
const PAIR_TIMEOUT_MS = 2_500;

export type CompanionSettings = { url: string; token: string };

export function getCompanionSettings(): CompanionSettings {
  if (typeof window === "undefined") {
    return { url: DEFAULT_COMPANION_URL, token: "" };
  }

  return {
    url:
      window.localStorage.getItem(URL_KEY)?.replace(/\/+$/, "") ||
      DEFAULT_COMPANION_URL,
    token: window.localStorage.getItem(TOKEN_KEY) ?? "",
  };
}

export function setCompanionSettings(settings: CompanionSettings) {
  window.localStorage.setItem(URL_KEY, settings.url.replace(/\/+$/, ""));
  window.localStorage.setItem(TOKEN_KEY, settings.token.trim());
}

export function clearCompanionSettings() {
  window.localStorage.removeItem(URL_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * Ask the companion for a token and remember it.
 *
 * Returns the token, or an empty string when no companion is answering — which
 * is the ordinary state of a machine that has not installed one yet, and is
 * reported by the setup checklist rather than thrown.
 */
export async function pairWithCompanion(url: string): Promise<string> {
  try {
    const response = await fetch(`${url}/pair`, {
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    });
    if (!response.ok) return "";

    const body = (await response.json()) as { token?: string };
    const token = String(body.token ?? "");
    if (token) setCompanionSettings({ url, token });
    return token;
  } catch {
    return "";
  }
}

/**
 * The settings to use for a card operation, pairing first if needed.
 *
 * Every call into the companion goes through this, so pairing is never a step
 * the citizen performs — it is a thing that has already happened by the time
 * they press a button.
 */
export async function getPairedSettings(): Promise<CompanionSettings> {
  const settings = getCompanionSettings();
  if (settings.token) return settings;

  return { url: settings.url, token: await pairWithCompanion(settings.url) };
}

/**
 * Drop the cached token and pair again.
 *
 * Called when the companion answers 403, which in practice means it restarted
 * and generated a new one.
 */
export async function repairCompanion(url: string): Promise<string> {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
  return pairWithCompanion(url);
}

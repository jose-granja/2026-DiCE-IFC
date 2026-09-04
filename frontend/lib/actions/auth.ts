"use server";

/**
 * Auth Server Actions — the *only* Server Actions in this app.
 *
 * They move a JWT pair in and out of an httpOnly cookie and talk to the Django
 * `core`/djoser endpoints. No IFC, BCF or IDS payload may ever be passed to a
 * function in this file; see AGENTS.md §1.
 *
 * Next 16: `cookies()` is async-only.
 */

import { cookies } from "next/headers";
import { jwtDecode } from "jwt-decode";
import type { AuthTokens, User } from "@/types";
import { getApiBaseUrl } from "@/lib/apiBaseUrl";

const COOKIE_NAME = "tokens";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

type ApiResult<T> = { data: T; error: null } | { data: null; error: string };

async function api<T>(
  path: string,
  init: RequestInit & { accessToken?: string } = {},
): Promise<{ status: number; body: T | null }> {
  const { accessToken, ...rest } = init;
  const res = await fetch(`${getApiBaseUrl()}/${path.replace(/^\//, "")}`, {
    ...rest,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `JWT ${accessToken}` } : {}),
      ...rest.headers,
    },
  });

  // 204 and other empty bodies are normal for djoser's password endpoints.
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
}

function isExpired(token?: string): boolean {
  if (!token) return true;
  try {
    const { exp } = jwtDecode<{ exp: number }>(token);
    return exp < Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

async function readTokens(): Promise<AuthTokens | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthTokens;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: AuthTokens) {
  const store = await cookies();
  store.set(COOKIE_NAME, JSON.stringify(tokens), COOKIE_OPTIONS);
}

async function clearTokens() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

// ---------------------------------------------------------------------------
// Token flow
// ---------------------------------------------------------------------------

/**
 * The access token, refreshing it if needed. Returns null (after clearing the
 * cookie) when the session is dead — a network blip does not destroy it.
 */
export async function getAccessToken(): Promise<string | null> {
  const tokens = await readTokens();
  if (!tokens) return null;
  if (!isExpired(tokens.access)) return tokens.access;

  if (!tokens.refresh || isExpired(tokens.refresh)) {
    await clearTokens();
    return null;
  }
  const refreshed = await refreshTokens(tokens.refresh);
  return refreshed?.access ?? null;
}

/** The raw access token without any validity check — for decoding claims. */
export async function peekAccessToken(): Promise<string | null> {
  return (await readTokens())?.access ?? null;
}

async function refreshTokens(refresh: string): Promise<AuthTokens | null> {
  let result;
  try {
    result = await api<AuthTokens>("auth/jwt/refresh/", {
      method: "POST",
      body: JSON.stringify({ refresh }),
    });
  } catch {
    // Transient network failure: keep the (possibly valid) session alive.
    return null;
  }

  if (result.status !== 200 || !result.body?.access) {
    await clearTokens();
    return null;
  }

  const tokens: AuthTokens = {
    access: result.body.access,
    // The refresh endpoint only returns a new refresh token when rotation is on.
    refresh: result.body.refresh ?? refresh,
  };
  await writeTokens(tokens);
  return tokens;
}

// ---------------------------------------------------------------------------
// User endpoints
// ---------------------------------------------------------------------------

export async function getCurrentUser(): Promise<{ user: User | null }> {
  const accessToken = await getAccessToken();
  if (!accessToken) return { user: null };

  const { status, body } = await api<User>("auth/users/me/", { accessToken });
  if (status !== 200 || !body) return { user: null };
  return { user: body };
}

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<ApiResult<AuthTokens>> {
  const { status, body } = await api<AuthTokens & { detail?: string }>(
    "auth/jwt/create",
    { method: "POST", body: JSON.stringify(input) },
  );

  if (status !== 200 || !body?.access) {
    return { data: null, error: body?.detail ?? "Invalid email or password." };
  }
  await writeTokens({ access: body.access, refresh: body.refresh });
  return { data: { access: body.access, refresh: body.refresh }, error: null };
}

export async function signOut(): Promise<void> {
  await clearTokens();
}

export async function signUp(input: {
  email: string;
  password: string;
  re_password: string;
  first_name?: string;
  last_name?: string;
}): Promise<ApiResult<User>> {
  const { status, body } = await api<User & Record<string, string[]>>(
    "auth/users/",
    { method: "POST", body: JSON.stringify(input) },
  );
  if (status !== 201 || !body) {
    return { data: null, error: firstError(body) ?? "Could not create account." };
  }
  return { data: body, error: null };
}

export async function requestPasswordReset(
  email: string,
): Promise<ApiResult<null>> {
  const { status, body } = await api<Record<string, string[]>>(
    "auth/users/reset_password/",
    { method: "POST", body: JSON.stringify({ email }) },
  );
  if (status !== 204) {
    return { data: null, error: firstError(body) ?? "Could not send the email." };
  }
  return { data: null, error: null };
}

export async function confirmPasswordReset(input: {
  uid: string;
  token: string;
  new_password: string;
  re_new_password: string;
}): Promise<ApiResult<null>> {
  const { status, body } = await api<Record<string, string[]>>(
    "auth/users/reset_password_confirm/",
    { method: "POST", body: JSON.stringify(input) },
  );
  if (status !== 204) {
    return { data: null, error: firstError(body) ?? "Could not reset the password." };
  }
  return { data: null, error: null };
}

/** djoser returns `{ field: ["message", ...] }`; surface the first message. */
function firstError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

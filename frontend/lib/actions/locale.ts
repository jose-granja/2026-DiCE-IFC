"use server";

import { cookies } from "next/headers";

import { LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";

/**
 * Persist the chosen language. The only Server Action outside auth, and it
 * carries one enum value.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    sameSite: "lax",
    // A year: the language a professional works in does not change often.
    maxAge: 60 * 60 * 24 * 365,
  });
}

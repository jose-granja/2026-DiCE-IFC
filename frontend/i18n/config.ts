/**
 * Portuguese and English, both first-class.
 *
 * Portuguese is the default and is not a translation of the English: the
 * signing and georeferencing modules are Portugal-specific, and terms like
 * "Cartão de Cidadão", "PIN de Assinatura" and "ETRS89 / PT-TM06" are the
 * source strings, not localisations of an English original.
 *
 * **No i18n routing.** There is no `/pt` or `/en` URL prefix and no
 * `app/[locale]/` segment. This app is a local-first tool behind a login, not a
 * public site — nothing here benefits from per-locale URLs, and the routing
 * setup would put a dynamic segment in front of every module for no gain. The
 * locale comes from a cookie, falling back to the `Accept-Language` header.
 */

export const LOCALES = ["pt", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "pt";

export const LOCALE_COOKIE = "dice-locale";

export const LOCALE_LABELS: Record<Locale, string> = {
  pt: "Português",
  en: "English",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best locale for an `Accept-Language` header. Deliberately crude — the cookie
 * is what actually decides once the user has chosen, and this only has to be
 * right on the first visit.
 */
export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  localeFromAcceptLanguage,
} from "./config";

/**
 * Resolves the locale per request, with no URL prefix (see `./config.ts`).
 *
 * Next 16: `cookies()` and `headers()` are async-only.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;

  const locale = isLocale(fromCookie)
    ? fromCookie
    : localeFromAcceptLanguage((await headers()).get("accept-language"));

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    // Fall back to Portuguese for any key a translation has not caught up on,
    // rather than rendering the raw key at the user.
    getMessageFallback({ key, namespace }) {
      return namespace ? `${namespace}.${key}` : key;
    },
    onError(error) {
      if (process.env.NODE_ENV === "development") console.warn(error);
    },
    ...(locale === DEFAULT_LOCALE ? {} : {}),
  };
});

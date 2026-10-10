/**
 * Who operates this deployment.
 *
 * Read from `NEXT_PUBLIC_*` at build time, like every other deployment setting
 * here (see Dockerfile.prod). They are not secrets: they are printed on the
 * About and Privacy pages, and exist so that whoever offers the app to the
 * public can name themselves and say how to get in touch.
 */

const clean = (value: string | undefined) => (value ?? "").trim();

export const OPERATOR = {
  name: clean(process.env.NEXT_PUBLIC_OPERATOR_NAME),
  /** An email address or a URL. */
  contact: clean(process.env.NEXT_PUBLIC_OPERATOR_CONTACT),
  sourceUrl: clean(process.env.NEXT_PUBLIC_SOURCE_URL),
};

/** `mailto:` for an address, the URL itself for a link, nothing for neither. */
export function contactHref(contact: string): string | null {
  if (/^https?:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`;
  return null;
}

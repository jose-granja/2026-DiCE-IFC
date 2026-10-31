/**
 * Who operates this deployment.
 *
 * Read from `NEXT_PUBLIC_*` at build time, like every other deployment setting
 * here (see Dockerfile.prod). They are not secrets: they are printed on the
 * About and Privacy pages, and exist so that whoever offers the app to the
 * public can name themselves and say how to get in touch.
 */

const clean = (value: string | undefined) => (value ?? "").trim();

/** Where DiCE-IFC's own source lives. A fork sets `NEXT_PUBLIC_SOURCE_URL` to its own. */
export const REPOSITORY_URL = "https://github.com/jose-granja/2026-DiCE-IFC";

export const OPERATOR = {
  name: clean(process.env.NEXT_PUBLIC_OPERATOR_NAME),
  /** An email address or a URL. */
  contact: clean(process.env.NEXT_PUBLIC_OPERATOR_CONTACT),
  /** The source code, as the MIT licence and the About page point to it. */
  sourceUrl: clean(process.env.NEXT_PUBLIC_SOURCE_URL) || REPOSITORY_URL,
};

/** `mailto:` for an address, the URL itself for a link, nothing for neither. */
export function contactHref(contact: string): string | null {
  if (/^https?:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`;
  return null;
}

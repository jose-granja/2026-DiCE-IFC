/**
 * Turn the plain attribution line the globe returns into pieces a page can link.
 *
 * ODbL asks that the credit for OpenStreetMap data point to where its licence
 * is explained, and the other providers ask for the same of their own. The
 * globe keeps returning one string (`Globe#getAttribution`) so nothing that
 * reads it has to change; this only finds the credits in it.
 */

export type AttributionPart = { text: string; href?: string };

/** Longest phrase first, so "© MapTiler © OpenStreetMap contributors" is not split. */
const KNOWN: Array<{ phrase: string; href: string }> = [
  { phrase: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
  { phrase: "© MapTiler", href: "https://www.maptiler.com/copyright/" },
  { phrase: "© Cesium ion", href: "https://cesium.com/legal/terms-of-service/" },
  { phrase: "terrain via Cesium ion", href: "https://cesium.com/platform/cesium-ion/content/cesium-world-terrain/" },
  { phrase: "© Google", href: "https://www.google.com/intl/en/help/terms_maps/" },
];

export function linkAttribution(line: string): AttributionPart[] {
  return line
    .split(" · ")
    .flatMap((segment) => {
      // A segment can hold more than one credit ("© MapTiler © OpenStreetMap contributors").
      const parts: AttributionPart[] = [];
      let rest = segment;
      while (rest.length > 0) {
        const hit = KNOWN.map((entry) => ({ entry, at: rest.indexOf(entry.phrase) }))
          .filter(({ at }) => at >= 0)
          .sort((a, b) => a.at - b.at || b.entry.phrase.length - a.entry.phrase.length)[0];
        if (!hit) {
          if (rest.trim()) parts.push({ text: rest.trim() });
          break;
        }
        if (hit.at > 0 && rest.slice(0, hit.at).trim()) parts.push({ text: rest.slice(0, hit.at).trim() });
        parts.push({ text: hit.entry.phrase, href: hit.entry.href });
        rest = rest.slice(hit.at + hit.entry.phrase.length);
      }
      return parts;
    });
}

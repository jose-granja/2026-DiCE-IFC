/**
 * Colours for a lens's groups.
 *
 * A hand-picked first dozen, chosen to stay apart from each other and from the
 * ghost grey under the common colour-vision deficiencies, then evenly spaced
 * hues by the golden angle — so a lens by material on a model with forty
 * materials still gives forty colours, each the same for the same position.
 */

const FIRST = [
  "#e53935",
  "#1e88e5",
  "#fdd835",
  "#43a047",
  "#8e24aa",
  "#fb8c00",
  "#00acc1",
  "#d81b60",
  "#6d4c41",
  "#7cb342",
  "#3949ab",
  "#f4511e",
];

/** Unmatched elements, drawn translucent: neutral, so the matches stand out. */
export const GHOST_COLOUR = "#a9b1c2";

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** The colour of the `index`th group (largest first). */
export function paletteColour(index: number): string {
  if (index < FIRST.length) return FIRST[index];
  const hue = (index * 137.508) % 360;
  // Alternate lightness so neighbours in hue are still told apart.
  return hslToHex(hue, 0.62, index % 2 === 0 ? 0.48 : 0.62);
}

/**
 * IDS `xs:pattern` values, adjusted before the engine sees them.
 *
 * The engine refuses, before compiling it, any pattern its regex guard
 * (`@ifc-lite/regex-guard` 0.3) takes for a catastrophic-backtracking shape: a
 * group with a quantifier inside it, followed by another quantifier — `(a+)+`.
 * The guard's own documentation lists the inner quantifiers that count as
 * `+`, `*` and `{n,}`, but its scan counts **any** `{`, so an exact repeat
 * inside a repeated group is refused too: `(_\d{2}){1,3}`, which is how a
 * SECClasS code (`Ss_20_05_15_70`) is naturally written, cannot backtrack
 * catastrophically and is refused all the same. The specification then comes
 * back unevaluated.
 *
 * Writing an exact repeat of a single atom out in full (`\d{2}` → `\d\d`)
 * matches exactly the same values and leaves nothing for the guard to object
 * to. Only that is done here, and only to a pattern the guard would otherwise
 * refuse — one with a quantified group — so every other pattern, including the
 * text the engine quotes back in a failure, stays as the author wrote it. A
 * genuinely ambiguous pattern (`(\d{1,2})+`, `(a+)+`) is left alone and is
 * still refused, as it should be.
 *
 * Engine-free and pure, so it is testable without the WASM parser.
 */

/** Longest exact repeat written out; beyond this the pattern is left as is. */
export const MAX_EXPANDED_REPEAT = 16;

/** Index just past a character class starting at `start` (`[` … `]`), or -1. */
function classEnd(pattern: string, start: number): number {
  let depth = 0;
  for (let index = start; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      // `\p{…}` inside a class is one escape, braces included.
      if ((pattern[index + 1] === "p" || pattern[index + 1] === "P") && pattern[index + 2] === "{") {
        const close = pattern.indexOf("}", index + 3);
        if (close < 0) return -1;
        index = close;
      } else {
        index++;
      }
      continue;
    }
    // XSD class subtraction nests a class inside a class: `[a-z-[aeiou]]`.
    if (character === "[") depth++;
    else if (character === "]" && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Index just past the single atom starting at `start` — an escape, a class,
 * `.` or a literal character — or -1 when the character there is syntax
 * (`(`, `)`, `|`, a quantifier) rather than an atom.
 */
function atomEnd(pattern: string, start: number): number {
  const character = pattern[start];
  if (character === "\\") {
    const next = pattern[start + 1];
    if (next === undefined) return -1;
    if ((next === "p" || next === "P") && pattern[start + 2] === "{") {
      const close = pattern.indexOf("}", start + 3);
      return close < 0 ? -1 : close + 1;
    }
    return start + 2;
  }
  if (character === "[") return classEnd(pattern, start);
  if ("(){}|*+?".includes(character)) return -1;
  return start + 1;
}

const REPEAT = /^\{(\d+)(?:,(\d*))?\}/;

/**
 * Every exact repeat of a single atom written out in full: `\d{2}` → `\d\d`,
 * `[A-Z]{3}` → `[A-Z][A-Z][A-Z]`, `x{2,2}` → `xx`. Ranges (`{1,3}`, `{2,}`)
 * and repeats of a group are kept, so the set of matching values never
 * changes.
 */
export function expandExactRepeats(pattern: string): string {
  let output = "";
  let index = 0;

  while (index < pattern.length) {
    const end = atomEnd(pattern, index);

    if (end < 0) {
      // Syntax. A `{…}` here quantifies a group: copy it whole, so its digits
      // are not taken for atoms of their own.
      const repeat = pattern[index] === "{" ? REPEAT.exec(pattern.slice(index)) : null;
      const length = repeat ? repeat[0].length : 1;
      output += pattern.slice(index, index + length);
      index += length;
      continue;
    }

    const atom = pattern.slice(index, end);
    const repeat = REPEAT.exec(pattern.slice(end));
    if (!repeat) {
      output += atom;
      index = end;
      continue;
    }

    const count = Number(repeat[1]);
    const exact = repeat[2] === undefined || (repeat[2] !== "" && Number(repeat[2]) === count);
    const after = pattern[end + repeat[0].length];
    // A second quantifier straight after (`a{2}?`) would then apply to the
    // last copy only; XSD does not allow it, and it is left untouched.
    const stacked = after !== undefined && "?*+{".includes(after);

    output += exact && !stacked && count >= 1 && count <= MAX_EXPANDED_REPEAT
      ? atom.repeat(count)
      : atom + repeat[0];
    index = end + repeat[0].length;
  }

  return output;
}

/** True when a group is followed by a quantifier: `(…)+`, `(…)*`, `(…){1,3}`. */
export function hasQuantifiedGroup(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "[") {
      const end = classEnd(pattern, index);
      if (end < 0) return false;
      index = end - 1;
      continue;
    }
    if (character === ")" && "+*{".includes(pattern[index + 1] ?? "")) return true;
  }
  return false;
}

/** The pattern to hand the engine: unchanged, unless the guard would refuse it for an exact repeat. */
export function patternForEngine(pattern: string): string {
  return hasQuantifiedGroup(pattern) ? expandExactRepeats(pattern) : pattern;
}

/**
 * Apply `patternForEngine` to every pattern constraint in a parsed IDS
 * document, in place. The walk is generic — any `{ type: "pattern", pattern }`
 * object, at any depth — so it reaches entity names, predefined types,
 * property sets, values and the `and` siblings of a restriction alike, without
 * depending on the shape of each facet.
 */
export function adaptPatternsForEngine(document: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "pattern" && typeof record.pattern === "string") {
      record.pattern = patternForEngine(record.pattern);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(document);
}

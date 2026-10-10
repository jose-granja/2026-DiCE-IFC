/**
 * Plain text or a regular expression, from one text field.
 *
 * A value written `/pattern/` or `/pattern/flags` is a regular expression and
 * is searched anywhere in the text (anchor it with `^` and `$` to match the
 * whole). Anything else is fixed text and must equal the value, ignoring case
 * and surrounding spaces — what these filters did before they accepted
 * patterns, so existing queries keep their meaning. Fixed text may also use
 * `*` (any run of characters) and `?` (any one) as wildcards, the way a clash
 * matrix names classes: `IfcWall*`.
 */

export class TextPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextPatternError";
  }
}

export type TextMatcher = {
  readonly source: string;
  readonly isRegex: boolean;
  test(value: string): boolean;
};

const REGEX_FORM = /^\/((?:\\.|[^\\/])+)\/([a-z]*)$/;

const fold = (value: string) => value.trim().toLocaleLowerCase();

const cache = new Map<string, TextMatcher>();

/** Memoised: a query compiles the same few patterns once per entity it tests. */
export function compileTextMatcher(source: string): TextMatcher {
  const cached = cache.get(source);
  if (cached) return cached;
  const matcher = buildTextMatcher(source);
  if (cache.size > 500) cache.clear();
  cache.set(source, matcher);
  return matcher;
}

function buildTextMatcher(source: string): TextMatcher {
  const trimmed = source.trim();
  const form = REGEX_FORM.exec(trimmed);

  if (!form && /[*?]/.test(trimmed)) {
    const glob = new RegExp(
      `^${trimmed
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "i",
    );
    return { source: trimmed, isRegex: false, test: (value) => glob.test(value.trim()) };
  }

  if (!form) {
    const wanted = fold(trimmed);
    return { source: trimmed, isRegex: false, test: (value) => fold(value) === wanted };
  }

  const [, body, flags] = form;
  let expression: RegExp;
  try {
    // Case-insensitive unless the author gave flags of their own, like the
    // fixed-text form. `g`/`y` would make `test` stateful, so they are dropped.
    const kept = flags.replace(/[gy]/g, "");
    expression = new RegExp(body, kept || "i");
  } catch (error) {
    throw new TextPatternError(
      `Invalid regular expression ${trimmed}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { source: trimmed, isRegex: true, test: (value) => expression.test(value) };
}

/** Compile every non-empty entry; throws `TextPatternError` for a bad pattern. */
export function compileTextMatchers(values: string[]): TextMatcher[] {
  return values.map((value) => value.trim()).filter(Boolean).map(compileTextMatcher);
}

export function matchesAnyText(matchers: TextMatcher[], value: string): boolean {
  return matchers.some((matcher) => matcher.test(value));
}

/**
 * Split a comma-separated field into entries, leaving a `/regex/` whole — so
 * `/^Ifc(Wall|Slab)$/, IfcBeam` and `/a{1,3}/` are not cut at their commas.
 */
export function splitTextList(text: string): string[] {
  const entries: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    const leading = rest.match(/^\s*/)![0].length;
    const regex = /^\/(?:\\.|[^\\/])+\/[a-z]*\s*(?:,|$)/.exec(rest.slice(leading));
    let end: number;
    if (regex) {
      end = leading + regex[0].length;
      entries.push(regex[0].replace(/\s*,$/, "").trim());
    } else {
      const comma = rest.indexOf(",");
      end = comma === -1 ? rest.length : comma + 1;
      entries.push(rest.slice(0, comma === -1 ? undefined : comma).trim());
    }
    rest = rest.slice(end);
  }

  return entries.filter(Boolean);
}

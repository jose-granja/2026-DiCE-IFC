/**
 * Exclusive XML Canonicalization (`http://www.w3.org/2001/10/xml-exc-c14n#`).
 *
 * ADR 006 chose to *emit* canonical XML rather than implement c14n, and noted
 * that the trick stops applying "if XAdES-T or LTA needs to sign a fragment we
 * do not author". It missed the case that matters just as much: **verifying a
 * signature somebody else produced**.
 *
 * A container signed by another tool is not canonical on disk. The one that
 * exposed this — a real Cartão de Cidadão signature — writes
 * `<ds:SignedInfo>` with no namespace declaration of its own (it inherits
 * `xmlns:ds` from `ds:Signature`) and writes empty elements as `<x/>`.
 * Canonicalising adds the declaration and expands the tags, so the bytes on
 * disk and the bytes that were signed are different, and hashing the substring
 * reports a valid signature as broken.
 *
 * ## The algorithm, and the parts that are easy to get wrong
 *
 * Exclusive c14n differs from inclusive c14n in one respect that is the whole
 * point of it: a namespace declaration is rendered on an element only if that
 * element **visibly utilises** the prefix — through its own name or one of its
 * attribute names — and no ancestor *in the output* has already rendered the
 * same prefix with the same value. Inherited-but-unused declarations are
 * dropped, which is what makes a signed fragment survive being moved into a
 * different document.
 *
 * Everything else is bookkeeping, but each rule changes the bytes:
 *
 * - attributes sorted by namespace URI then local name, with unprefixed
 *   attributes (which are in no namespace) first;
 * - namespace declarations sorted by prefix, default namespace first;
 * - empty elements as `<a></a>`, never `<a/>`;
 * - text escapes `&`, `<`, `>` and CR; attribute values escape `&`, `<`, `"`,
 *   tab, LF and CR;
 * - **whitespace between elements is content and is preserved.** A
 *   pretty-printed signature was pretty-printed when it was signed, so the
 *   indentation is inside the digest.
 * - comments are omitted; CDATA becomes ordinary text.
 */

const XMLNS = "http://www.w3.org/2000/xmlns/";

type Rendered = Map<string, string>;

/**
 * Canonicalise an element subtree.
 *
 * `rendered` carries the namespace declarations an ancestor already emitted, so
 * a nested call does not repeat them. Callers start with an empty map: the
 * fragment is canonicalised as if it were a document on its own, which is what
 * XMLDSig does when it verifies a `Reference`.
 */
export function canonicalize(node: Element): string {
  return serializeElement(node, new Map());
}

function serializeElement(element: Element, inherited: Rendered): string {
  const rendered: Rendered = new Map(inherited);
  const declarations: Array<[string, string]> = [];

  // Which prefixes this element actually uses: its own, plus its attributes'.
  // An unprefixed element name uses the default namespace.
  const used = new Set<string>();
  used.add(element.prefix ?? "");

  for (const attribute of Array.from(element.attributes)) {
    if (attribute.namespaceURI === XMLNS) continue;
    // An unprefixed attribute is in no namespace and utilises nothing.
    if (attribute.prefix) used.add(attribute.prefix);
  }

  for (const prefix of used) {
    const uri = lookupNamespace(element, prefix);

    if (prefix === "") {
      // The default namespace. `xmlns=""` has to be emitted when an ancestor
      // put us in one and this element is not in it — otherwise the element
      // silently inherits a namespace it does not belong to.
      const current = uri ?? "";
      const previous = rendered.get("") ?? "";
      if (current !== previous) {
        if (current !== "" || previous !== "") {
          declarations.push(["xmlns", current]);
          rendered.set("", current);
        }
      }
      continue;
    }

    if (!uri) continue;
    if (rendered.get(prefix) === uri) continue;

    declarations.push([`xmlns:${prefix}`, uri]);
    rendered.set(prefix, uri);
  }

  declarations.sort(([a], [b]) => {
    if (a === "xmlns") return -1;
    if (b === "xmlns") return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const attributes = Array.from(element.attributes)
    .filter((attribute) => attribute.namespaceURI !== XMLNS)
    .sort(compareAttributes)
    .map(
      (attribute) =>
        ` ${attribute.name}="${escapeAttribute(attribute.value)}"`,
    )
    .join("");

  const namespaces = declarations
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");

  const name = element.nodeName;
  const children = Array.from(element.childNodes)
    .map((child) => serializeNode(child, rendered))
    .join("");

  return `<${name}${namespaces}${attributes}>${children}</${name}>`;
}

function serializeNode(node: Node, rendered: Rendered): string {
  switch (node.nodeType) {
    case 1:
      return serializeElement(node as Element, rendered);
    case 3: // text
    case 4: // CDATA becomes ordinary text
      return escapeText(node.nodeValue ?? "");
    case 7: {
      const instruction = node as ProcessingInstruction;
      return `<?${instruction.target}${instruction.data ? ` ${instruction.data}` : ""}?>`;
    }
    // Comments are omitted: this is the without-comments variant, which is what
    // `xml-exc-c14n#` means without the `WithComments` suffix.
    default:
      return "";
  }
}

/**
 * Attribute order: namespace URI, then local name.
 *
 * Attributes in no namespace sort before all others — not alphabetically among
 * the namespaced ones, which is the mistake that produces a digest that is
 * right for simple signatures and wrong for the ones that carry `xml:id` or a
 * prefixed attribute.
 */
function compareAttributes(a: Attr, b: Attr): number {
  const uriA = a.namespaceURI ?? "";
  const uriB = b.namespaceURI ?? "";

  if (uriA !== uriB) {
    if (uriA === "") return -1;
    if (uriB === "") return 1;
    return uriA < uriB ? -1 : 1;
  }

  const localA = a.localName ?? a.name;
  const localB = b.localName ?? b.name;
  return localA < localB ? -1 : localA > localB ? 1 : 0;
}

/** The in-scope URI for a prefix, walking up the tree. */
function lookupNamespace(element: Element, prefix: string): string | null {
  let current: Element | null = element;
  const attributeName = prefix === "" ? "xmlns" : `xmlns:${prefix}`;

  while (current) {
    const declared = current.getAttribute(attributeName);
    if (declared !== null) return declared || null;
    current = current.parentElement;
  }

  // Fall back to what the parser resolved, which covers documents whose
  // declarations sit above the fragment we were handed.
  if (prefix === "") return element.namespaceURI;
  return element.lookupNamespaceURI(prefix);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

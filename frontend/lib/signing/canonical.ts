/**
 * Canonical XML, by construction.
 *
 * XMLDSig does not hash the XML you wrote — it hashes the **canonical form** of
 * it. A verifier re-parses the signature, re-canonicalises `SignedInfo` and
 * `SignedProperties`, and hashes the result. If those bytes differ from the
 * ones we hashed by so much as an attribute order, the signature is invalid,
 * and the failure gives no hint why.
 *
 * There are two ways to be correct here. One is to implement Exclusive XML
 * Canonicalization (`xml-exc-c14n#`) — a real specification with namespace
 * visibility rules that is easy to get subtly wrong. The other is to **only
 * ever emit XML that is already in canonical form**, so canonicalisation is the
 * identity function on our output. That is what this module does, and every
 * rule it enforces is one of the c14n rules:
 *
 * - UTF-8, no XML declaration, no comments, no DOCTYPE.
 * - Empty elements written as `<a></a>`, never `<a/>`.
 * - No whitespace between elements. Indentation would be *content*, and would
 *   change the digest.
 * - Attributes sorted: namespace declarations first (default namespace, then by
 *   prefix), then attributes by namespace URI and local name.
 * - `&`, `<` and `>` escaped in text; `&`, `<`, `"` and CR escaped in attribute
 *   values.
 *
 * The one rule we satisfy by discipline rather than by code is **namespace
 * visibility**: exclusive c14n renders a namespace declaration on the outermost
 * element of the fragment that uses it. So every fragment we hash separately —
 * `SignedInfo`, `SignedProperties` — declares the prefixes its own subtree uses,
 * explicitly, at its root. `xades.ts` does that, and `canonical.test.ts` checks
 * the emitted fragments against a real XML parser rather than against itself.
 */

export type Attribute = { name: string; value: string };

/**
 * One element. Children are either elements or a single text node — mixed
 * content has no place in a signature and would only invite whitespace bugs.
 */
export type XmlNode = {
  name: string;
  attributes?: Attribute[];
  children?: XmlNode[];
  text?: string;
};

export function element(
  name: string,
  attributes: Attribute[] = [],
  children: XmlNode[] = [],
): XmlNode {
  return { name, attributes, children };
}

export function textElement(
  name: string,
  text: string,
  attributes: Attribute[] = [],
): XmlNode {
  return { name, attributes, text };
}

/**
 * Serialise to canonical form.
 *
 * The output of this is what gets hashed *and* what gets written into the
 * container — the same bytes in both places, so a verifier that re-canonicalises
 * and a verifier that naively takes the substring both arrive at the same digest.
 */
export function serialize(node: XmlNode): string {
  const attributes = sortAttributes(node.attributes ?? [])
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join("");

  const inner =
    node.text !== undefined
      ? escapeText(node.text)
      : (node.children ?? []).map(serialize).join("");

  // Always an explicit end tag: `<a/>` and `<a></a>` are the same infoset but
  // different bytes, and c14n mandates the second.
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

/**
 * Namespace declarations first (default namespace before prefixed ones, then
 * alphabetically by prefix), then ordinary attributes.
 *
 * Real exclusive c14n sorts ordinary attributes by (namespace URI, local name).
 * Every attribute we emit is unprefixed — `Algorithm`, `URI`, `Id`, `Target`,
 * `ObjectReference` — so sorting by name is the same ordering. `assertNoPrefixedAttributes`
 * is what keeps that assumption true rather than merely likely.
 */
function sortAttributes(attributes: Attribute[]): Attribute[] {
  const namespaces = attributes.filter((a) => isNamespaceDeclaration(a.name));
  const rest = attributes.filter((a) => !isNamespaceDeclaration(a.name));

  assertNoPrefixedAttributes(rest);

  namespaces.sort((a, b) => {
    if (a.name === "xmlns") return -1;
    if (b.name === "xmlns") return 1;
    return a.name.localeCompare(b.name);
  });
  rest.sort((a, b) => a.name.localeCompare(b.name));

  return [...namespaces, ...rest];
}

function isNamespaceDeclaration(name: string): boolean {
  return name === "xmlns" || name.startsWith("xmlns:");
}

function assertNoPrefixedAttributes(attributes: Attribute[]) {
  for (const attribute of attributes) {
    if (attribute.name.includes(":")) {
      // Sorting these correctly needs the namespace URI, not the prefix. Rather
      // than sort them wrongly and produce a signature that fails to verify
      // somewhere else, refuse.
      throw new Error(
        `Canonical serialisation does not support the prefixed attribute "${attribute.name}". ` +
          `Exclusive c14n sorts attributes by namespace URI, which this emitter does not track.`,
      );
    }
  }
}

/**
 * c14n escapes `&`, `<` and `>` in text, and normalises CR.
 *
 * `>` does not strictly need escaping in XML, but c14n mandates it, and the
 * point of this module is to match c14n exactly.
 */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

/** In attribute values c14n escapes `&`, `<`, `"`, and the whitespace chars. */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#xD;")
    .replace(/\n/g, "&#xA;")
    .replace(/\t/g, "&#x9;");
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the call stack somewhere
  // around 100 kB, and certificates are small but payload digests are not the
  // only thing that passes through here.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function digest(
  algorithm: "SHA-256" | "SHA-384" | "SHA-512",
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Uint8Array(await crypto.subtle.digest(algorithm, buffer));
}

export async function digestBase64(
  algorithm: "SHA-256" | "SHA-384" | "SHA-512",
  bytes: Uint8Array,
): Promise<string> {
  return base64(await digest(algorithm, bytes));
}

/**
 * An `xs:dateTime` in UTC, to the second.
 *
 * Milliseconds are legal but some verifiers render them oddly, and the extra
 * precision means nothing for a signing time.
 */
export function signingTime(at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

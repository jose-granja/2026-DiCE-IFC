// @vitest-environment jsdom

/**
 * Exclusive canonicalisation.
 *
 * Each case here is a rule that changes the bytes, and therefore the digest.
 * The one that caused a real bug is `renders a declaration where it is used,
 * not at the fragment root` — our writer used to hoist `xmlns:ds` to the top of
 * `SignedProperties`, our verifier agreed with it, every test passed, and no
 * conforming verifier would have accepted the signature.
 */

import { describe, expect, it } from "vitest";

import { canonicalize } from "../c14n";
import { prepareSignature } from "../xades";
import { createSoftwareSigningProvider } from "../providers/software";

const parse = (xml: string) =>
  new DOMParser().parseFromString(xml, "application/xml").documentElement;

const c14n = (xml: string) => canonicalize(parse(xml));

describe("canonicalize", () => {
  it("expands empty elements", () => {
    expect(c14n("<a><b/></a>")).toBe("<a><b></b></a>");
  });

  it("renders a namespace declaration on the element that uses it", () => {
    // The bug. `xmlns:d` belongs on <d:c>, not hoisted to <a>.
    expect(c14n('<a xmlns:d="urn:d"><d:c></d:c></a>')).toBe(
      '<a><d:c xmlns:d="urn:d"></d:c></a>',
    );
  });

  it("drops a declared but unused namespace", () => {
    // This is what "exclusive" means, and why a signed fragment survives being
    // moved into another document.
    expect(c14n('<a xmlns:unused="urn:x"><b></b></a>')).toBe("<a><b></b></a>");
  });

  it("does not repeat a declaration an ancestor already rendered", () => {
    expect(c14n('<d:a xmlns:d="urn:d"><d:b></d:b></d:a>')).toBe(
      '<d:a xmlns:d="urn:d"><d:b></d:b></d:a>',
    );
  });

  it("keeps a declaration a prefixed attribute makes necessary", () => {
    expect(c14n('<a xmlns:d="urn:d"><b d:x="1"></b></a>')).toBe(
      '<a><b xmlns:d="urn:d" d:x="1"></b></a>',
    );
  });

  it("sorts unprefixed attributes before namespaced ones", () => {
    expect(c14n('<a xmlns:d="urn:d" d:z="1" b="2" a="3"></a>')).toBe(
      '<a xmlns:d="urn:d" a="3" b="2" d:z="1"></a>',
    );
  });

  it("sorts namespace declarations, default first", () => {
    const out = c14n('<a xmlns:z="urn:z" xmlns:b="urn:b" xmlns="urn:d" z:p="1" b:q="2"></a>');
    expect(out).toBe(
      '<a xmlns="urn:d" xmlns:b="urn:b" xmlns:z="urn:z" b:q="2" z:p="1"></a>',
    );
  });

  it("emits xmlns=\"\" when a child leaves the default namespace", () => {
    // Without this the child silently inherits a namespace it is not in.
    expect(c14n('<a xmlns="urn:d"><b xmlns=""></b></a>')).toBe(
      '<a xmlns="urn:d"><b xmlns=""></b></a>',
    );
  });

  it("preserves whitespace between elements", () => {
    // Indentation in a signed fragment is content: a pretty-printed signature
    // was pretty-printed when it was signed.
    expect(c14n("<a>\n  <b></b>\n</a>")).toBe("<a>\n  <b></b>\n</a>");
  });

  it("omits comments", () => {
    expect(c14n("<a><!-- gone --><b></b></a>")).toBe("<a><b></b></a>");
  });

  it("escapes text and attribute values as the specification requires", () => {
    // `>` needs no escaping in XML but c14n mandates it; a tab in an attribute
    // becomes a character reference.
    expect(c14n("<a>1 &lt; 2 &gt; 0 &amp; true</a>")).toBe(
      "<a>1 &lt; 2 &gt; 0 &amp; true</a>",
    );
    expect(c14n('<a b="x&#9;y"></a>')).toBe('<a b="x&#x9;y"></a>');
  });

  it("turns CDATA into ordinary text", () => {
    expect(c14n("<a><![CDATA[<raw>]]></a>")).toBe("<a>&lt;raw&gt;</a>");
  });
});

describe("what we sign is already canonical", () => {
  /**
   * The invariant the writer must hold.
   *
   * A fragment is hashed and then embedded. If the embedded bytes are not the
   * canonical form, every other verifier disagrees with us about the digest —
   * silently, because our own verifier would make the same mistake.
   */
  it.each(["RSA", "EC"] as const)("holds for a %s signature", async (keyType) => {
    const device = await createSoftwareSigningProvider({ keyType });
    const certificate = await device.getSigningCertificate();

    const prepared = await prepareSignature(
      [
        {
          name: "model.ifc",
          bytes: new TextEncoder().encode("ISO-10303-21;\nEND-ISO-10303-21;\n"),
          mimeType: "application/x-step",
        },
      ],
      certificate,
      { algorithm: keyType === "EC" ? "ES256" : "RS256" },
    );

    const signedInfo = new TextDecoder().decode(prepared.dataToBeSigned);
    expect(canonicalize(parse(signedInfo))).toBe(signedInfo);

    const signedProperties = prepared.context.signedPropertiesXml;
    expect(canonicalize(parse(signedProperties))).toBe(signedProperties);
  });
});

# ADR 006 — Canonical XML by construction, not by canonicalising

- **Status:** **Superseded by ADR 008.** The premise below was wrong, and shipping it would have produced signatures no conforming verifier accepts.
- **Date:** 2026-09-04 · superseded 2026-09-05
- **Phase:** 3
- **Related:** ADR 002 (container format), ADR 004 (card companion), **ADR 008 (what replaced this)**

> **Read this first.** This ADR argued that emitting already-canonical XML makes
> canonicalisation unnecessary. That is true for `SignedInfo` and false for
> `SignedProperties`, for a reason the ADR itself asserted incorrectly — see
> "Why this was wrong" at the end. It is kept rather than deleted because the
> reasoning is the useful part of the record.

## Context

XMLDSig does not sign the XML you wrote. It signs the **canonical form** of
`SignedInfo`, and each `ds:Reference` covers the canonical form of what it
points at. A verifier re-parses the signature, re-canonicalises those fragments
with Exclusive XML Canonicalization (`xml-exc-c14n#`), and hashes the result.

If our bytes and the verifier's bytes differ by one attribute's position, the
signature is invalid. The failure carries no diagnostic: a verifier reports
"signature does not verify", identically to a forgery.

So Phase 3 needed a C14N story. Two options:

1. **Implement exclusive c14n.** Parse to a DOM, then apply the specification:
   namespace visibility (which declarations are "visibly utilised" in a
   subtree), attribute ordering by namespace URI then local name, whitespace and
   character-escaping rules.
2. **Only ever emit XML that is already canonical**, so canonicalisation is the
   identity function on our output.

## Decision

**Option 2.** `lib/signing/canonical.ts` is a small emitter that can only
produce canonical XML, and `lib/signing/xades.ts` builds every signed fragment
through it.

The bytes we hash are the bytes we write into the container. `SignedInfo` and
`SignedProperties` are serialised once, hashed, and then **spliced verbatim**
into the final document — never rebuilt. `completeSignature` takes them as
strings for exactly this reason.

## Why

**Implementing c14n is a lot of specification to get right for no benefit
here.** Its hard parts — namespace visibility, prefix rewriting, inherited
declarations — are hard precisely because it must handle *arbitrary* input. We
control our input completely. A signature is a small, fixed document shape with
two namespaces and a handful of unprefixed attributes.

**The failure mode of getting c14n wrong is silent and total.** Every signature
we produce would be invalid everywhere, and the only symptom would be
"signature does not verify". Reducing the surface where that can happen is
worth more than generality we never use.

**It is checkable.** `canonical.test.ts` parses the emitted fragments with a
real XML parser and asserts the structural properties c14n requires;
`roundtrip.test.ts` signs with real WebCrypto keys and verifies, which is the
end-to-end proof: if the emitted form were not canonical, our own verifier
would still agree with itself, but the *reference digest* over
`SignedProperties` is computed from the emitted string and checked against a
re-read of the stored bytes — so a mismatch between "what we hashed" and "what
we stored" fails the test.

## What this costs

Three constraints are now permanent, and each is enforced rather than
remembered:

- **No prefixed attributes** in signed fragments. Sorting them correctly needs
  the namespace URI, which the emitter does not track, so it **throws** rather
  than sorting them wrongly. Nothing in XAdES-B needs one.
- **Every separately-hashed fragment declares its own namespaces at its root.**
  Exclusive c14n renders declarations at the apex of the fragment that uses
  them, so `SignedProperties` carries both `xmlns:ds` and `xmlns:xades`
  explicitly even though it inherits them in the document.
- **No pretty-printing, ever.** Indentation inside a signed fragment is content
  and changes the digest. The unsigned parts of the container
  (`META-INF/manifest.xml`) are indented, because nothing hashes them.

## When to revisit

If XAdES-T or LTA needs to sign a fragment we do not author — a timestamp token
embedded by a TSA, say, or counter-signatures over third-party XML — the
identity trick stops applying and a real c14n implementation becomes necessary.
`UnsignedProperties` is deliberately appendable and outside the signed
fragments, so adding T does not force this.

## Alternatives considered

**A c14n library.** `xml-crypto` and friends are Node-oriented and pull in a
DOM implementation; this is a browser-first application where the whole point is
that signing happens in the tab. The bundle cost is real and the trust surface
is larger than the emitter it replaces.

**Sign the raw string without canonicalising and hope verifiers do the same.**
They will not. Every conforming verifier canonicalises, which is the entire
reason the algorithm is named in `CanonicalizationMethod`.


---

## Why this was wrong

The claim in "What this costs" — *"every separately-hashed fragment declares its
own namespaces at its root"* — misstates exclusive canonicalisation. Exclusive
c14n renders a namespace declaration on the element that **visibly utilises** it,
meaning the element whose own name or attribute name carries the prefix. It does
**not** hoist a declaration to the root of the fragment on behalf of a
descendant.

Our `SignedProperties` is a `xades:`-prefixed element containing a
`ds:DigestMethod` several levels down. We emitted `xmlns:ds` on
`SignedProperties`; the canonical form declares it on `ds:DigestMethod`. So the
bytes we hashed were not the canonical form, and **every signature this
application produced would have been rejected by any conforming verifier** —
including the official Portuguese one at `validador.autenticacao.gov.pt`.

Nothing caught it, and the reason is worth recording: our verifier used the same
shortcut, hashing the stored substring rather than canonicalising. Writer and
verifier agreed with each other, all 39 signing tests passed, and the output was
wrong. **A round trip through one's own implementation proves nothing about
interoperability.** What exposed it was a container signed by a different tool
with a real Cartão de Cidadão — and the same fix made that file verify and our
own files verify correctly for the first time.

The regression tests that now hold the line:

- `c14n.test.ts` asserts the specific rule that was misunderstood, and asserts
  the invariant directly: everything the writer hashes must equal its own
  canonical form.
- `real-container.test.ts` verifies a signature produced elsewhere, which is the
  only kind of test that could have caught this.

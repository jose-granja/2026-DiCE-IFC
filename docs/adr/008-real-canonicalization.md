# ADR 008 — Implement exclusive canonicalisation

- **Status:** Accepted — supersedes ADR 006
- **Date:** 2026-09-05
- **Phase:** 3
- **Supersedes:** ADR 006

## Context

ADR 006 avoided implementing Exclusive XML Canonicalization by emitting XML that
was already canonical, so that canonicalisation would be the identity function.
The reasoning was that c14n's hard parts exist to handle arbitrary input, and we
control our input completely.

Two things falsified it, both found by the same file: a `.ifczip` signed with a
real Cartão de Cidadão by a different tool.

1. **Verification could not work at all on other tools' output.** Their
   `SignedInfo` inherits `xmlns:ds` from `ds:Signature` and writes empty
   elements as `<x/>`. The canonical form adds the declaration and expands the
   tags, so hashing the stored bytes gives the wrong digest. A valid qualified
   signature was reported as broken.

2. **Our own signing was wrong.** Exclusive c14n renders a namespace declaration
   on the element that visibly utilises it, not at the root of the fragment.
   ADR 006 asserted the opposite. Our `SignedProperties` hoisted `xmlns:ds` to
   its root on behalf of a `ds:DigestMethod` inside it, so the digest was taken
   over non-canonical bytes and no conforming verifier would have accepted the
   signature.

The second one is the serious one, and it was invisible: our verifier made the
identical assumption, so writer and verifier agreed and every test passed.

## Decision

**Implement exclusive canonicalisation** (`lib/signing/c14n.ts`) and use it on
both sides.

- **Writing** — `xades.ts` builds a fragment, serialises it, parses it, and
  canonicalises it. The canonical string is what gets hashed *and* what gets
  embedded, so the bytes in the file are the bytes that were signed.
- **Verifying** — `verify.ts` canonicalises `SignedInfo` and each same-document
  reference target before hashing, instead of extracting substrings.

`canonical.ts` remains as the emitter that produces well-formed XML with no
stray whitespace. It is no longer load-bearing for correctness; c14n is.

## Consequences

- Roughly 180 lines to maintain, covering the rules that change bytes:
  visibly-utilised namespace rendering, `xmlns=""` when a child leaves the
  default namespace, attribute ordering by namespace URI then local name,
  expanded empty elements, the escaping rules, preserved inter-element
  whitespace, dropped comments.
- We can now verify signatures from any conforming implementation, which is what
  an offline verification tab is for.
- XAdES-T and LTA are no longer blocked on this: ADR 006 flagged that
  timestamps and counter-signatures would need real c14n, and now they have it.

## What this cost, and the lesson

Every signature produced before this fix was invalid to everyone but us, and the
full test suite was green throughout. The tests were all round trips through our
own implementation.

**A round trip proves self-consistency, not correctness.** The regression suite
now includes a container signed by another tool with a real card
(`real-container.test.ts`, read from disk and skipped when absent so no personal
certificate is committed), and a direct assertion that everything the writer
hashes equals its own canonical form (`c14n.test.ts`).

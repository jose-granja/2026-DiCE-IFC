# ADR 004 — Card-signing companion, and why Chave Móvel Digital was dropped

- **Status:** Accepted (with one item still open — see "Still open")
- **Date:** 2026-09-03
- **Phase:** 1 spike, blocking Phase 3
- **Resolves:** Open question Q1
- **Related:** ADR 002 (container format), Q2 (installer signing), Q3 (bulk PIN behaviour)

## Context

Modules 2 and 7 produce qualified electronic signatures over IFC and BCF
containers. The signing device is the **physical Cartão de Cidadão** and nothing
else.

A browser cannot reach a smart card. WebCrypto has no token access; WebAuthn
cannot drive an arbitrary qualified signing key. A locally installed companion
is therefore mandatory — the only choice is which one.

The brief listed three candidates in order: **Web eID**, **our own Rust native
messaging host**, and **a localhost HTTP service** (marked "do not"). Q1 asked
whether Web eID's native app can be pointed at `pteidpkcs11` by configuration,
and said to resolve it with a spike rather than an argument.

## Why CMD is out of scope

Chave Móvel Digital would mean an AMA contract, an `ApplicationId`, and a
certification process measured in months, all on the critical path before a
single signature could be produced. It would also break the privacy line: SCMD
is a remote signing service, so a digest would have to leave the machine.

Card signing keeps the line absolute — **not even a digest crosses the wire.**
Users who want CMD are pointed at the official Autenticação.gov desktop
application, in the UI, plainly.

## The spike

Read against `web-eid/libelectronic-id` `main` and `web-eid/web-eid-app`,
September 2026.

### 1. Can Web eID be pointed at `pteidpkcs11` by configuration? **No.**

Tier-2 (PKCS#11) card support is compiled in. Three things are hardcoded:

- **The card type**, an enum in `include/electronic-id/electronic-id.hpp`:
  `EstEID, FinEID, LatEID, LitEID, HrvEID, BelEID, CzeEID, LuxtrustV2, LuxEID`
  (plus `MsCryptoApiEID` on Windows). **Portugal is not there.**
- **The module path**, from a per-OS `inline fs::path` function feeding a
  `const std::map<ElectronicID::Type, Pkcs11ElectronicIDModule> SUPPORTED_PKCS11_MODULES`
  in `src/electronic-ids/pkcs11/Pkcs11ElectronicID.cpp`.
- **Card detection**, by exact and masked ATR tables (`SUPPORTED_ATRS`,
  `MASKED_ATRS`) in `src/electronic-id.cpp`.

There is no configuration file, no environment variable and no plugin
mechanism. An unmodified Web eID installation will not recognise a Cartão de
Cidadão at all — it will not get as far as looking for a PKCS#11 module.

So Q1's first branch is closed: **configuration is not an option.**

### 2. Is the *shape* right anyway? **Yes, and better than expected.**

Three findings make a fork much cheaper than writing our own host:

- **`providesExternalPinDialog` is already a per-card flag.** Belgian, Czech and
  Luxembourg eID all set it. When true, Web eID does not render a PIN field and
  lets the middleware raise its own dialog. That is exactly `pteid-pkcs11`'s
  behaviour, and it is the requirement we were most worried about — it is
  already a first-class, shipped, tested path, not something we would be
  introducing.
- **The signature algorithm is negotiated, not assumed.** `signWithSigningKey`
  checks the returned algorithm against `supportedSigningAlgorithms()`, which
  covers `RS224`–`RS512` and `ES224`–`ES512`. The **CC v1 (RSA) / CC v2 (ECDSA,
  June 2024+)** split therefore needs no special handling in the companion. Our
  XAdES builder still has to handle both, and ECDSA values arrive as raw P1363
  `r‖s` — which is what XMLDSig wants directly.
- **Upstream invites new cards** ("submit an issue if you want to request
  support for your country's eID card").

### 3. What a fork actually costs

Four mechanical edits, no new architecture:

1. `PrtEID` in the `ElectronicID::Type` enum.
2. The Cartão de Cidadão ATRs in `SUPPORTED_ATRS` / `MASKED_ATRS` (v1 and v2,
   contact and contactless).
3. A `portuguesePkcs11ModulePath()` returning
   `C:\Windows\System32\pteidpkcs11.dll`,
   `/usr/local/lib/libpteidpkcs11.dylib`, `/usr/local/lib/libpteidpkcs11.so`.
4. One `SUPPORTED_PKCS11_MODULES` entry with `retryMax = 3` and
   **`providesExternalPinDialog = true`**.

Compare with option 2, our own Rust host: ~500 lines of `cryptoki` is the
optimistic part. The rest — a Chrome MV3 extension, a Firefox extension, native
messaging manifests for three OSes, origin binding, the two-step
get-data-to-sign / sign-with-value protocol, PIN-dialog handling, retry and
lockout semantics, and an installer for each platform — is most of the work, and
Web eID has all of it, audited, in production across five countries.

## Decision

1. **Use Web eID, forked, as the card companion.** Maintain
   `dice-ifc/libelectronic-id` and `dice-ifc/web-eid-app` forks carrying only the
   four edits above, rebased on upstream.
2. **Open the upstream issue and PR immediately, in parallel.** If upstream
   accepts `PrtEID`, the fork disappears and — critically — Portuguese users
   install a Web eID build signed and notarised by RIA rather than by us. That
   makes upstreaming the cheapest available answer to Q2, not just a nicety.
3. **Do not write our own native messaging host.** Revisit only if upstream
   rejects Portuguese support *and* the fork proves unmaintainable.
4. **Do not use a localhost HTTP service.** Chrome's Private Network Access
   rules make HTTPS → `http://127.0.0.1` increasingly permission-gated.
5. **Registering `pteidpkcs11` in Firefox is not a substitute.** It enables TLS
   client authentication, not document signing.

## Consequences

- **`frontend/lib/signing/provider.ts` is the only thing the app talks to**, with
  three implementations:
  - `webeid` — the real card, through `@web-eid/web-eid-library`.
  - `softhsm` — SoftHSM2 with one RSA and one ECDSA test key, driving the same
    native host. This is the only way to cover the CC v1 / CC v2 algorithm split
    in CI, and it means the XAdES builder, the manifest logic and the container
    assembly need no hardware.
  - `mock` — deterministic fixtures, for unit tests and UI development.
- **No PIN field, ever.** `providesExternalPinDialog` is true for our card; the
  middleware owns the PIN. The app never sees, transports, caches or stores it.
  A PIN input appearing anywhere in this codebase is a bug, not a feature.
- **Never hard-code RSA.** Read the algorithm from the certificate's public key
  and from what `sign()` returns.
- **`/sign/setup`** detects reader, middleware, extension and native host and
  shows a per-OS checklist with links to autenticacao.gov. Expect most of this
  module's support burden to land there — build it before the signing UI, not
  after.
- **Q2 (who code-signs and notarises the installer) is now sharper, not solved.**
  An unsigned helper will not install cleanly on Windows or macOS; an EV
  certificate plus Apple notarisation is a real recurring cost. Upstreaming
  removes it entirely. Budget for it as the fallback.

## Still open

**Q3 — what does `pteid-pkcs11` prompt for a batch?** This cannot be answered
without a physical card, a reader and a person to type a PIN; no amount of
source reading substitutes for it. Until it is measured, assume **one PIN entry
per signature.**

The experiment, to run as the first task of Phase 3 with real hardware:

> Sign three files in a row through the forked host without removing the card.
> Count PIN prompts. Repeat with a deliberate 60-second pause between the second
> and third to see whether the middleware caches a session and, if so, for how
> long.

The answer decides the default bulk mode:

- **one prompt for the batch** → per-file signatures are affordable, and each
  file stays independently verifiable;
- **one prompt per file** → default to a single XAdES signature over an
  `ASiCManifest` of digests, and be explicit in the UI that individual files are
  no longer independently verifiable on their own.

Build both paths regardless — the manifest form is a genuine feature, not just a
workaround — and make the default a one-line change.

# ADR 007 — A local signing companion, and localhost as part of the trust boundary

- **Status:** Accepted — supersedes the companion decision in ADR 004; **amended 2026-09-06** for automatic pairing and installers. See "Amendment".
- **Date:** 2026-09-05
- **Phase:** 3
- **Supersedes:** ADR 004 decisions 1–4 (Web eID fork). ADR 004's analysis of the card, CMD and the algorithm split still stands.

## Context

Phase 3 shipped a complete browser-side signing stack: XAdES-B, ASiC-E
containers, co-signing and offline verification, all tested against real RSA and
ECDSA keys. What it could not do was **sign with an actual Cartão de Cidadão**.

ADR 004 chose Web eID and recorded that Portuguese support needs a fork — four
mechanical edits to add a card type, its ATRs and the `pteidpkcs11` module path.
That fork was never built, so `/sign` had no working device and the module was
useless for its actual purpose. The user was right to call this out.

The brief listed three companion options and ranked a **localhost HTTP service**
third, marked "Do not", on the grounds that Chrome's Private Network Access
rules make HTTPS → `http://127.0.0.1` increasingly permission-gated.

## What changed the assessment

A working reference implementation exists and was inspected: `ifcsign`, running
locally, signing IFC models with the Cartão de Cidadão through
`/usr/local/lib/libpteidpkcs11.dylib`, with a token-authenticated local HTTP
API. It demonstrates that the ranked-third option is the one that actually works
today, and that the ranked-first option is blocked on work nobody has done.

The Private Network Access concern is real but narrower than it looked: it bites
when an **HTTPS page on the public internet** calls a private address. During
development the app is itself on `http://localhost`, and for a deployed instance
the mitigation is the same one every such tool uses — the companion sends CORS
headers for the app's origin, and Chrome's PNA preflight is satisfied by a
service that opts in. It is a deployment constraint to manage, not a reason the
approach cannot work.

## Decision

1. **Build our own local companion** (`companion/`), a small Python service
   driving `pteidpkcs11` over PKCS#11. Not a dependency on `ifcsign`: the
   protocol is ours, it ships in this repo, and it does strictly less.
2. **The companion is a device, not a signing service.** It exposes exactly
   three things — `GET /status`, `GET /certificate`, `POST /sign` — and `/sign`
   takes a **digest**. The XAdES signature and the ASiC-E container are still
   built in the browser by code that is already tested.
3. **Localhost is inside the trust boundary.** AGENTS.md §1 is amended: user
   content may reach a program on the same machine, and still never the network.
4. **Keep the `webeid` provider.** If Portuguese support is upstreamed, a Web
   eID build signed and notarised by RIA is a better answer than an installer we
   sign ourselves — that was ADR 004's strongest argument and it survives.

## Why a digest and not the file

The privacy question was put to the user, who allowed localhost to carry user
content. We send a digest anyway, because:

- The browser-side XAdES and ASiC-E code exists and is covered by 39 tests with
  real keys. Delegating to the companion would retire tested code in favour of
  untested code.
- The smallest thing that can cross a boundary is the right thing to send. A
  32-byte hash cannot be reconstructed into a model.
- The companion stays small enough to audit. It has no endpoint that accepts a
  document, and a body limit that enforces it.

Permission to send more is not a reason to send more.

## What the companion must never do

Each of these is enforced in code, not by convention:

- **No PIN.** `pteid-pkcs11` shows its own window; there is no parameter, field
  or cache for one here.

  This ADR originally said the card "declares a protected authentication path
  and `C_Login` is called with no PIN". **That was asserted without checking and
  is wrong.** A Cartão de Cidadão reports `CKF_LOGIN_REQUIRED = false` and
  `CKF_PROTECTED_AUTHENTICATION_PATH = false`, so `C_Login(NULL)` fails with
  `CKR_GENERAL_ERROR` behind a wall of ASN.1 errors from the middleware's EAC
  code. The middleware prompts from inside **`C_Sign`**. The companion therefore
  does not log in at all, and attempts `C_Login` only if signing returns
  `CKR_USER_NOT_LOGGED_IN`. Verified against a real card: with the login removed,
  the PIN window appears and `C_Sign` returns `CKR_FUNCTION_CANCELED` when it is
  dismissed.
- **The CITIZEN SIGNATURE key only.** The card's authentication key may not sign
  documents. Matched by label, and it fails rather than falling back.
- **No RSA assumption.** The mechanism follows the key type the card reports:
  `CKM_ECDSA` for a CC v2, `CKM_RSA_PKCS` over a DigestInfo-wrapped digest for a
  CC v1.
- **127.0.0.1 only**, a fresh token per start, an origin allow-list, and no
  request logging — a service that logs its requests writes down digests.

## Consequences

- Something must be installed. That was always true; only which thing changed.
  The support burden lands on `/sign/setup`, which now pairs with the companion
  and reports middleware, reader, card and pairing separately, so a failure says
  which one.
- We own an installer for three operating systems, and Q2 (code signing and
  notarisation) returns in full. Upstreaming into Web eID remains the cheapest
  escape from it.
- One Python dependency (`PyKCS11`), chosen so the thing non-developers install
  is as close to "pip install and run" as possible.

## Verified

Against the real middleware on macOS, with no card inserted:

```
GET /status  → {"middleware":"/usr/local/lib/libpteidpkcs11.dylib",
                "reader":"Gemplus USB SmartCard Reader",
                "cardPresent":false,"ready":false,"paired":false}
GET /certificate (no token)    → 403
GET /certificate (with token)  → {"error":"No card was found…","code":"no-card"}
```

The middleware and reader are detected through PKCS#11, and the card-absent path
reports precisely what is missing.

With a card inserted, verified further:

```
GET /certificate → the real CITIZEN SIGNATURE CERTIFICATE
                   (CN=…, issued by EC de Assinatura Digital Qualificada)
card objects     → CITIZEN SIGNATURE KEY, CKA_KEY_TYPE = CKK_RSA (a CC v1)
POST /sign       → the middleware's PIN window appears;
                   dismissing it returns CKR_FUNCTION_CANCELED,
                   reported as "Signing was cancelled."
```

**A complete signature has now been produced and verified** with the citizen
entering the PIN:

```
POST /sign → RS256, 256 bytes
verified against the card's own certificate:
  public key                 2048-bit RSA, exponent 65537
  PKCS#1 v1.5 padding        intact
  DigestInfo + SHA-256       matches the signed bytes
```

### One more thing the card taught us

`POST /sign` takes the **bytes to be signed**, not their digest, and the reason
is worth recording. A Cartão de Cidadão advertises `CKM_RSA_PKCS` with
`CKF_SIGN` — `C_GetMechanismInfo` confirms it — and then refuses it at `C_Sign`
for the *signature* key with `CKR_MECHANISM_INVALID`. The middleware hashes
internally for a qualified signature, so it wants `CKM_SHA256_RSA_PKCS` and the
data.

The companion still tries the digest-only mechanism first and falls back, so a
card that does accept raw signing keeps the smaller exchange. What crosses to
localhost either way is `SignedInfo`: a few hundred bytes of digests, URIs and
algorithm identifiers, from which no document can be reconstructed.

The mechanism list this middleware returns is also unusable — `C_GetMechanismList`
over-reports its count and spills memory garbage after the first thirteen
entries, so the list is not worth consulting. `C_GetMechanismInfo` on a named
mechanism is reliable; trying the mechanism and handling `CKR_MECHANISM_INVALID`
is more reliable still.


## Amendment — 2026-09-06: pairing without typing, and installers

Two things the original decision left for the citizen to do turned out to be
things they should never have been asked to do.

### The token is fetched, not pasted

The companion generated a random token at start-up and printed it for the
citizen to copy into a form. That token changes on every restart, so the copying
is not a one-time setup step — it recurs, silently, whenever the machine
reboots, and the failure it produces ("signing is not working") does not point
at its cause.

The obvious fix — **a fixed token compiled into both sides** — is worse than the
problem. This repository is public, so a constant here is a constant everyone
has: it would authenticate nobody while looking like it authenticated somebody.
That is the dangerous kind of wrong, because it survives review.

**`GET /pair` returns the token to an allow-listed `Origin`.** A browser sets
`Origin` itself and a page cannot forge it, so this is exactly as strong as the
origin allow-list, which is the control that actually matters against the threat
this service has: *another web page in the same browser*. A random per-start
secret is preserved; only the copying is removed. The frontend re-pairs
automatically on a 403, so a restarted companion costs a round trip instead of a
support conversation.

What this does not defend against — deliberately, and as before — is a program
already running on the machine as the same user. It can forge any header, read
the browser's storage, or skip this service and drive `pteidpkcs11` directly.
**The card's PIN dialog is the control there**, and it is one this service can
neither see nor answer.

### One PIN prompt per signature

The original implementation tried `CKM_RSA_PKCS` first and fell back to
`CKM_SHA256_RSA_PKCS` when the card refused it. On a Cartão de Cidadão the card
always refuses it — and **the middleware raises its PIN window from inside
`C_Sign`, before the mechanism is validated**. So the refused attempt had
already cost a PIN entry, and every single signature asked for the PIN twice.

The order is now reversed, so the mechanism the card accepts is tried first, and
the winner is remembered per card. The fallback still exists for cards that want
the other mechanism; they pay a second dialog once rather than always. The
assumption behind the original order — that a card validates a mechanism before
prompting — was never checked against hardware, which is the same failure mode
`AGENTS.md` §6 already records twice.

### Installers

`companion/packaging/` builds a `.pkg` for macOS and an Inno Setup `.exe` for
Windows, both via PyInstaller, each built on its target OS because PyKCS11 is a
compiled extension. Both arrange for the companion to **run at login** — a
LaunchAgent, a Startup shortcut — so there is nothing to start by hand.

The companion runs as the logged-in user rather than as a service, because the
middleware's PIN window has to appear on that user's desktop; a Windows service
in session 0 could never show it.

**Neither installer is code-signed**, which is open question **Q2** and remains
open: it needs an Apple Developer ID and an EV certificate, not a code change.
Until then macOS says "unidentified developer" and Windows SmartScreen warns.
The download button says so before the click rather than after it — an expected
warning is a different experience from an unexplained one.

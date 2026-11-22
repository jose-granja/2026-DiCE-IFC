# ADR 012 — Signature time-stamps (XAdES-B-T) through a same-origin proxy

- **Status:** Accepted for the mechanism. **The authority is a deployment choice** (Q5), made by setting `TSA_URL`; none is configured by default. **Amended 2026-11-22:** the free Cartão de Cidadão service, asked through the companion — see "Amendment".
- **Date:** 2026-10-12
- **Related:** ADR 002 (container), ADR 007 (companion), ADR 009 (the proxy pattern)

## Context

A signature made on the card carries `SigningTime` — a time the signer's own
computer supplied. Nothing proves it. That matters for two reasons:

1. **It cannot outlive the certificate.** A Cartão de Cidadão certificate
   expires, and can be revoked. Without independent evidence of *when* the
   signature was made, a verifier after expiry cannot tell a signature made last
   year from one forged afterwards.
2. **It is what separates a usable signature from a long-lived one.** XAdES
   baseline B-B is the floor; B-T adds a time-stamp from a third party. A
   *qualified* time-stamp (eIDAS art. 41) also carries a legal presumption that the
   time is accurate and the data unchanged since.

Time-stamp authorities speak RFC 3161 over HTTP, send no CORS headers, and the
paid ones want credentials that cannot be put in a browser. So, like bSDD
(ADR 009), it needs a server-side hop.

## Decision

1. **The browser sends a hash and nothing else.** After the card has signed, the
   page hashes the canonical `ds:SignatureValue` (SHA-256) and `POST`s it, as hex
   in a small JSON body, to `/api/tsa`. The binary RFC 3161 request is built by the
   route handler, never by the page, so no `File`/`Blob`/typed array is ever sent
   and the lint rule that forbids it stays unbroken. A `SignatureValue` is itself a
   signature over digests; its hash says nothing about the model.
2. **The authority is fixed by the deployment**, not named by the caller:
   `TSA_URL` (+ optional `TSA_USERNAME`/`TSA_PASSWORD`, `TSA_NAME`), all server-side.
   The caller can say only "stamp this 32-byte hash". It is not an open relay.
3. **It costs money per stamp and is public, so it is defended:** a per-client rate
   limit (`TSA_RATE_LIMIT_PER_HOUR`, default 60), a cross-origin refusal, a 256-byte
   body cap and a reply cap. The handler never logs a digest.
4. **The answer is checked twice**, by the route and again by the page, before it is
   embedded: the token must stamp *this* hash and answer *this* nonce. A token for
   something else is a perfectly good token attached to the wrong signature.
5. **A failed stamp does not lose the signature.** By then the citizen has typed the
   PIN; the container is built as B-B and the page says "signed, but not
   time-stamped". Silently downgrading would be worse; throwing would waste a PIN.
6. **The stamp is an unsigned property** (`xades:UnsignedProperties` →
   `SignatureTimeStamp`) with an explicit exclusive-c14n `CanonicalizationMethod`,
   because the XAdES default (inclusive c14n) is not what the digest was taken with.
7. **The verifier reports it** — time, issuer, whether it covers *this* signature —
   and states what it does not check: the token's own CMS signature and whether its
   issuer is a (qualified) time-stamping service. That needs the trusted list, the
   same gap as the signer's certificate, and is shown rather than glossed.

## What crosses the wire (adds a row to the AGENTS.md §1 table)

| What | Where | Why |
|---|---|---|
| SHA-256 of a `SignatureValue` + a random nonce | this app's server → the configured time-stamp authority | a time-stamp needs a third party; they send no CORS headers |

## Choosing an authority (Q5)

The mechanism is provider-neutral — anything that speaks RFC 3161 over HTTP(S)
with Basic auth or none works. What is a *qualified* time-stamp is decided by the
EU/national trusted list, not by this table: confirm a provider is listed there
(eidas.ec.europa.eu → Trusted List Browser) **for the qualified time-stamping
service**, not merely as a trust service provider. Figures below were read from
the providers' own pages on 2026-10-12 and are not quotes.

| Provider | Qualified? | Pricing found | Access | Notes |
|---|---|---|---|---|
| **SK ID Solutions** (EE) | Yes, states it is on the EU trusted list | Monthly plans, from €0.036 to €0.006 per stamp as volume rises (1 000 to 500 000 a month). The page's monthly totals look 100× too large for those unit prices — confirm | RFC 3161, IP-based access | **Free test environment, no contract**, demo credentials published on their GitHub. Best place to start. |
| **Disig** (SK) | Yes ("qualified electronic time stamps") | Prepaid, ex-VAT: 100 → €11.67, 500 → €39.17, 1 000 → €52.50, 5 000 → €266.67, 10 000 → €500 | Access certificate (token) valid 3 years; e-shop, self-service | Cheapest for low volume, no monthly commitment. Stamps valid ≥ 1 year (longer, priced separately). Endpoint and auth are in their service documentation, not on the price page. |
| **Lleida.net** (ES) | Yes ("Qualified Electronic Time-Stamp Service Provider") | From €0.03 per stamp | RFC 3161; URL, user and password by email after purchase | Test and production environments mentioned. |
| **MULTICERT** (PT) | Yes — its time-stamp policy states qualified stamps under eIDAS 910/2014 | Not published; sold by number of stamps, the subscriber must not exceed the number bought | Contract | The Portuguese provider; ask for a quote, a per-stamp price, an annual fee, and its entry in the Portuguese trusted list. |
| **Mensatek** (ES) | Resells two qualified TSAs: its own and **FNMT** | Credits (1 for Mensatek's, 2 for FNMT's); credit prices not published | RFC 3161 over HTTPS, `application/timestamp-query`, Basic/Digest or client certificate | Useful if FNMT is wanted. |
| **Namirial**, **Sectigo** | Yes | On request; Sectigo says fees may apply and are not refunded | Contact sales | Not found published. |
| *Development only:* **FreeTSA**, public DigiCert / Sectigo endpoints | **No** | Free | RFC 3161, no auth | Produce valid RFC 3161 tokens — right for trying this out. A signature stamped by them is **not** a QES time-stamp. |

~~Not found: any Portuguese public-sector (ARTE / Cartão de Cidadão) free
time-stamping service.~~ **Wrong — there is one; see the amendment below.**

**Suggested path:** try the mechanism against SK ID's free test environment (or a
public development TSA), then buy from whichever of Disig (low volume),
SK ID (volume) or MULTICERT (a Portuguese contract) fits — and confirm its
qualified time-stamping service in the trusted list before telling anyone the
signatures are qualified.

## Consequences

- With no `TSA_URL` the page says so, and signatures stay B-B exactly as before.
- `LT`/`LTA` (embedded revocation data, archive time-stamps) are **not** built; they
  need OCSP/CRL fetches through the same kind of allow-listed proxy.
- Qualified status of a *signature* still needs the verifier to resolve the signer's
  certificate against the trusted list. This ADR does not provide that.

## Amendment (2026-11-22) — the Cartão de Cidadão time-stamp, through the companion

### What was missed

The Autenticação.gov application time-stamps signatures by default through the
**Cartão de Cidadão time-stamping service**, `http://ts.cartaodecidadao.pt/tsa/server`
(its user manual, "timestamp" section). The service's own site,
pki.cartaodecidadao.pt, says, read on 2026-11-22:

- it is **free** and open to "quaisquer cidadãos que deles necessitem", with
  **no authentication**;
- it allows **at most 20 requests in each 20-minute period**; going beyond
  blocks access for **24 hours**, and repeated blocks may have further
  consequences;
- it publishes a *Política de selo temporal qualificado* and its own TSA
  certificates. That suggests a qualified service; it was **not** confirmed in
  the trusted list, and nothing here says so to the user.

Tried once on 2026-11-22, through the relay below: the service granted a
token for a random hash, which `checkTimestampToken` accepted — right hash,
right nonce — issued by "Serviço de Validação Cronológica do Cartão de Cidadão"
under policy `0.4.0.2023.1.1` (ETSI EN 319 421's baseline time-stamp policy).

The table above missed it. It is the obvious first choice for Portuguese
citizens signing with the card, and costs nothing.

### Why not through `/api/tsa`

`TSA_URL=http://ts.cartaodecidadao.pt/tsa/server` works with no code change,
and is wrong for any deployment with more than one user: the limit is per
caller, the caller would be this app's server, and **every user would share 20
stamps per 20 minutes**. One forty-file batch would get the deployment blocked
for a day, for everyone. It is also not what the service is for — a citizen's
own stamps.

### Decision

**The citizen's machine asks, through the companion**, as the Autenticação.gov
application does — so the allowance is the citizen's own.

- **The browser builds the RFC 3161 request** (`buildTimestampRequest`: a
  SHA-256 hash of the `SignatureValue` and a fresh nonce) and **checks the
  answer** (`parseTimestampResponse`, `checkTimestampToken` with that hash and
  nonce) — the same tested code `/api/tsa` uses.
- **The companion relays** (`companion/dice_companion/timestamp.py`,
  `POST /timestamp`): it accepts only a `TimeStampReq` in exactly the shape the
  browser builds (version 1, SHA-256 imprint of 32 bytes, a nonce, `certReq`;
  no policy, no extensions, ≤ 128 bytes), forwards it to the **one fixed host**
  — the caller cannot name another — and returns the reply untouched.
- **It keeps under the limit.** It counts its own requests and refuses the 19th
  inside 20 minutes with `rate-limited` and a `retryAfter`, leaving two for the
  Autenticação.gov application on the same machine, which it cannot see. A
  restart forgets the count; within one window that is a rare way to lose two.
- **A refused or failed stamp keeps the signature**, as before: B-B, and the
  page says why — for the limit, in the reader's language.
- **The page offers it when the companion says it can**: `/status` lists
  `"timestamp"` in `features` (companion 0.2.0+), with the stamps left. An older
  companion gets a note to update. When both this and `TSA_URL` exist, the
  page offers a choice, the Cartão de Cidadão first; it shows how many stamps
  are left, and says before signing when a batch is larger than that.
- ~~Still XAdES only.~~ **A signature inside an IFC takes one too**, as CAdES-T
  (ADR 011, amended 2026-11-22), from either source.
- **It is the user's choice, and starts off.** The checkbox is unticked on
  every page: nothing goes to any time-stamp service unless the user ticks it.
  (Before this amendment it was ticked whenever an authority was configured.)

### What crosses (adds a row to AGENTS.md §1)

| What | Where | Why |
|---|---|---|
| SHA-256 of a `SignatureValue` + a nonce, as a `TimeStampReq` | browser → the companion → `ts.cartaodecidadao.pt` | the per-caller limit has to be the citizen's |

The service sees the citizen's address, not this deployment's. The service is
plain HTTP, as it is offered; the request reveals a hash of a signature and
nothing of the model, and the answer is a signed token the browser checks.

### Consequences

- Free time-stamps for every citizen with the card, with no deployment setup.
- The companion now makes one outbound call (ADR 007, amended). It stays a
  relay: the request is built and the answer checked in the browser.
- Companion 0.2.0's macOS (arm64) installer was built on 2026-11-22 and is
  served from `public/companion/`; its relay was tried against the real
  service. The Windows program served beside it is still 0.1.1, so Windows
  users see "update the companion" until `build_windows.ps1` runs on Windows
  (or the `companion-v0.2.0` tag workflow does).


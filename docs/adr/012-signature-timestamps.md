# ADR 012 — Signature time-stamps (XAdES-B-T) through a same-origin proxy

- **Status:** Accepted for the mechanism. **The authority is a deployment choice** (Q5), made by setting `TSA_URL`; none is configured by default.
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

Not found: any Portuguese public-sector (AMA / Cartão de Cidadão) free
time-stamping service. Worth asking AMA and GNS directly before buying.

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

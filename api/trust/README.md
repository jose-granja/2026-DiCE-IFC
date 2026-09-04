# `trust/` — the only reason the backend is involved in signing

Everything about a signature is produced in the browser: the digest, the XAdES
XML, the ASiC-E container. This app exists for one reason — **timestamp
authorities, OCSP responders, CRL distribution points and the EU/PT trusted
lists do not send CORS headers**, so a browser cannot fetch them directly.

It is a thin, caching proxy. It is not a signing service.

## What it must never do

- **Never log or persist a digest.** A timestamp request carries a hash of the
  user's document. It is forwarded and the response is returned; nothing is
  written down. Access logging is disabled for these endpoints for the same
  reason.
- **Never receive file content.** The request bodies here are a hash, a
  certificate serial, or nothing at all. There is no endpoint that accepts a
  model.
- **Never write an audit row implicitly.** `SignatureAudit` is opt-in per call
  and carries only the fields in `cde.models.SignatureAudit`.

## Endpoints

| Route | Carries | Why it cannot be done in the browser |
|---|---|---|
| `POST /api/trust/timestamp` | an RFC 3161 request (a hash) | TSAs send no CORS headers |
| `GET /api/trust/ocsp` | a certificate serial | OCSP responders send no CORS headers |
| `GET /api/trust/crl` | nothing | CRL endpoints send no CORS headers |
| `GET /api/trust/tsl` | nothing | the LOTL is a large XML file, cached here |

## Status

`timestamp` is deliberately **disabled by default**. XAdES-T needs a
*qualified* TSA, and which one — and who pays for it — is open question Q5. The
endpoint returns `503` with an explanation until `TRUST_TSA_URL` is configured,
rather than quietly signing against a non-qualified free TSA and producing
timestamps that look qualified and are not.

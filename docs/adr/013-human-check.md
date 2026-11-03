# ADR 013 — A human check in front of the site (Cloudflare Turnstile), off by default

- **Status:** Accepted. **Enabled per deployment** by setting `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`; off when either is empty.
- **Date:** 2026-11-03
- **Related:** ADR 012 (a paid service behind a public route), ADR 009 (the proxy pattern); the sibling CDE project's ADR 022 (its login CAPTCHA, which this follows)

## Context

The site is public and has no accounts, so nothing stands between a bot and
its pages or its service routes: `/api/tsa` spends money per stamp, `/api/ogc`
and `/api/bsdd` relay requests to third parties, and scrapers fetch the app
for no one. Rate limits (ADR 012) bound the damage per client; they do not tell
a person from a script.

The sibling CDE project already uses Cloudflare Turnstile for its login under
attack. Turnstile needs no account from the visitor, usually passes without an
interaction, and has published test keys that make it testable.

## Decision

1. **A gate in `proxy.ts`, not a login.** With both keys set, a page request
   without a valid pass is redirected (307) to `/human-check?next=<path>`; an
   API request is refused with 403. Static files (any path whose last segment
   has an extension, outside `/api/`) are not gated: they are the same for
   everyone, and a worker or WASM fetch must not break the app for someone who
   passed. `/human-check`, `/api/human-check` and `/privacy` are open, so a
   visitor can read what the check sends before it runs. Prefetch requests are
   gated too — they used to bypass the proxy altogether, which would have let a
   `Purpose: prefetch` header walk past the gate.
2. **The pass is a signed cookie, checked locally.** `/api/human-check` takes
   the widget's token, checks it with Cloudflare's `siteverify`, and sets
   `dice_human_pass` = `v1.<expiry>.<HMAC-SHA256(secret, version + expiry)>`,
   HttpOnly, SameSite=Lax, Secure over https, for `TURNSTILE_PASS_HOURS`
   (default 24, clamped to one minute–30 days). The proxy verifies the HMAC with
   Web Crypto on each request — no call to Cloudflare per page. The cookie holds
   no identifier; rotating the secret ends every pass.
3. **Only the token goes to Cloudflare from this server** — with the secret,
   not the visitor's address, which `siteverify` accepts but does not need. The
   token must come from a widget rendered with action `site-access`. Cloudflare
   unreachable means no pass (fail closed); the page says so and offers a retry.
4. **The CSP opens to `https://challenges.cloudflare.com` on `/human-check`
   only, and only when the check is on** — `script-src`, `frame-src` and
   `connect-src`. Every other page's policy is unchanged. The widget script is
   unversioned on Cloudflare's side, so it cannot carry an SRI hash (same as the
   CDE). The widget works under the site's `COEP: credentialless`; the e2e test
   walks through it.
5. **Keys are runtime settings**, not `NEXT_PUBLIC_`: the page reads the site
   key per request, so one image serves deployments with and without the check.

## Consequences

- With the check on, the browser contacts Cloudflare once per pass, on one
  page. Cloudflare sees the visitor's IP address and browser signals while it
  runs. That is a new third party in the privacy statement (`/privacy` row,
  AGENTS.md §1 table) — the reason it is off by default and an operator choice.
- No user content is involved: the check happens before the app loads, and the
  only things this server sends are the secret and the token.
- A pass is a bearer cookie: a bot that solves one challenge (with a human's
  help) can reuse its cookie until it expires. The pass length is the knob.
- The route `/api/human-check` exposed a latent bug shared with `/api/tsa`:
  both compared the browser's `Origin` with `request.nextUrl.origin`, which is
  Next's own listening address (`localhost:3000`), never the address a browser
  used. Both now use `lib/http/same-origin.ts`, which compares with `Host` /
  `X-Forwarded-Host`.

## Testing

`lib/human-check/__tests__/pass.test.ts` covers the pass (forgery, stretching,
expiry), what is gated, the redirect target (no open redirect, no loop) and
the token check with a fake `siteverify`. `e2e/human-check.spec.ts` starts a
second production server with Cloudflare's test keys (`1x00000000000000000000AA`
/ `1x0000000000000000000000000000000AA`) and checks the gate, the CSP, the
prefetch bypass, forged and expired passes, and the real widget end to end
(skipped when challenges.cloudflare.com is unreachable).

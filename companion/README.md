# DiCE-IFC signing companion

A small local service that lets the browser sign with a **Cartão de Cidadão**.

A browser cannot reach a smart card: WebCrypto has no token access and WebAuthn
cannot drive an arbitrary qualified signing key. Something has to run on the
machine. This is that something, and it is deliberately as small as it can be.

## What it does, and what it refuses to do

It is a **signing device, not a signing service**. It answers three questions:

| Endpoint | Returns |
|---|---|
| `GET /pair` | the pairing token, to an allow-listed browser origin only |
| `GET /status` | whether the middleware, a reader and a card are present |
| `GET /certificate` | the CITIZEN SIGNATURE certificate and its chain |
| `POST /sign` | a signature over the bytes you supply |

It never receives a model, a BCF file, or any document content. What it signs is
the signature's own `SignedInfo` — a few hundred bytes listing digests, URIs and
algorithm names. The model is hashed in the browser and only its digest appears
in there.

It takes those bytes rather than just their hash because a Cartão de Cidadão
rejects `CKM_RSA_PKCS` for the signature key and insists on hashing internally.
That mechanism is therefore tried **first**, not as a fallback: the middleware
raises its PIN window from inside `C_Sign`, before the card validates the
mechanism, so a refused attempt has already cost a PIN entry. Getting this order
wrong is what made every signature ask for the PIN twice.

The XAdES signature and the ASiC-E container are built in the browser, which is
where the file already is.

It never sees your PIN. The Autenticação.gov middleware raises its own PIN
window; this service does not ask for one, cannot cache one, and has no field
to type one into.

It uses the **CITIZEN SIGNATURE** key only. The card also carries an
authentication key; that one may not be used to sign documents, and this
service refuses to.

## Installing it

Most people should use an installer from the releases page, or the **Download**
button on DiCE-IFC's signing setup page. Both install the companion so that it
**starts when you log in** — a LaunchAgent on macOS, a Startup shortcut on
Windows — so there is nothing to run by hand.

Neither installer is code-signed yet, so macOS says "unidentified developer"
(right-click → Open) and Windows SmartScreen warns on first run. See
`packaging/README.md`, and open question Q2 in `docs/adr/README.md`.

To remove it: `dice-companion-uninstall` on macOS, Settings → Apps on Windows
(details in `packaging/README.md`).

From source:

    pip install -e .
    dice-companion

## Pairing — there is nothing to paste

The service mints a random token on every start and requires it on every
request; without it the answer is 403, so a random web page cannot drive your
card. The browser gets that token from `GET /pair`, which **only answers an
allow-listed origin** — a page cannot forge `Origin`, the browser sets it. So
pairing happens by itself and no one copies anything.

A fixed token compiled into both sides would have been simpler and much worse:
this repository is public, so the constant would be public too, authenticating
nobody while looking like it authenticated somebody.

`--show-token` prints it anyway, for debugging.

Requests are only accepted from an allow-list: the development defaults
(`http://localhost:3000`, `http://127.0.0.1:3000`) plus anything given with
`--allow-origin`, `DICE_COMPANION_ORIGINS`, the `allowed-origins.txt` the
installer was built with, or `~/.dice-ifc/allowed-origins.txt`. **A deployed site
has to be on it**, or the companion refuses to pair and the app reports it as not
running — see `packaging/README.md`. Wildcards are refused.

What none of this defends against is a program already running on your machine
as you — it can forge any header, or skip this service and drive the PKCS#11
module directly. The card's PIN dialog is the control there, and this service
can neither see nor answer it.

## Why a local HTTP service

The project brief originally ruled this out in favour of a browser extension
plus native messaging host (Web eID). That was the right call in principle and
turned out to be unavailable in practice: Web eID compiles in its supported card
types, and Portugal is not among them, so it needs a fork that does not exist.
See `docs/adr/007-local-signing-companion.md`.

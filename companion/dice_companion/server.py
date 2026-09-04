"""
The companion's HTTP surface.

Deliberately the standard library and nothing else. This gets installed by
people who are not developers, on three operating systems; every extra wheel is
another way for that to fail.

## Why any of this is safe

A service on localhost is reachable by every page in the browser, so two things
guard it:

- **A token**, generated fresh on each start and required on every request. A
  random web page does not have it and gets 403.
- **An origin allow-list.** CORS headers are only sent for origins passed with
  `--allow-origin`, so a page from anywhere else cannot read a response even if
  it guesses the token.

Neither is a substitute for the other: the token stops requests, CORS stops
replies being read.

## Why the token is handed out rather than typed

`GET /pair` returns the token to an allow-listed origin, so the citizen never
copies it anywhere. That looks like giving away the secret, so the reasoning
needs to be explicit.

The alternative people reach for first — a **fixed token compiled into both
sides** — is worse, and not slightly. This repository is public: a constant here
is a constant everyone has, so it would authenticate nobody while looking like
it authenticated somebody. That is the failure mode worth avoiding, because it
survives review by appearing to be a security control.

A random per-start token released only to an allow-listed `Origin` is exactly as
strong as the origin check, and the origin check is the control that actually
matters against the threat this service has: **another web page in the same
browser**. A browser sets `Origin` itself and a page cannot forge it, so
`https://evil.example` is refused at `/pair` and cannot read the reply even if
it calls the endpoint blind.

What this does not defend against is a **program already running on the
machine** as the same user. That is deliberate and unavoidable: such a program
can forge any header, read the browser's storage, or skip this service and drive
`pteidpkcs11` itself. The card's own PIN dialog is the control there, and it is
one this service can neither see nor answer.

## What it will not accept

There is no endpoint that takes a document. The largest thing this service reads
is a 64-byte digest, and the body limit is set accordingly — an upload path is
not something to leave lying around "just in case".
"""

from __future__ import annotations

import base64
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from . import card

# A digest and a certificate, base64, with room to spare. Nothing legitimate
# sent here is larger.
MAX_BODY_BYTES = 8 * 1024

VERSION = "0.1.0"


class Companion:
    def __init__(self, token: str, allowed_origins: list[str]):
        self.token = token
        self.allowed_origins = allowed_origins
        # PKCS#11 sessions are not safe to use concurrently, and a card can only
        # do one thing at a time anyway.
        self.lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = f"dice-companion/{VERSION}"
    companion: Companion

    # ---------------------------------------------------------------- plumbing

    def log_message(self, format: str, *args: Any) -> None:
        """
        Quiet by default.

        Request logging on a service that handles digests is a way to write
        those digests to disk without meaning to.
        """
        return

    def _origin_allowed(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin and origin in self.companion.allowed_origins:
            return origin
        return None

    def _send(self, status: int, payload: dict, origin: str | None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        return secrets.compare_digest(
            self.headers.get("X-DiCE-Token", ""), self.companion.token
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self._origin_allowed()
        self.send_response(204)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "X-DiCE-Token, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
        self.end_headers()

    # ---------------------------------------------------------------- routes

    def do_GET(self) -> None:  # noqa: N802
        origin = self._origin_allowed()
        path = urlparse(self.path).path

        if path == "/status":
            # Readable without a token on purpose: the setup page has to be able
            # to say "the companion is running" before anything is paired, and
            # this reveals only whether a reader and card are present.
            state = card.status()
            self._send(
                200,
                {
                    "version": VERSION,
                    "middleware": state.module_path,
                    "reader": state.reader,
                    "cardPresent": state.card_present,
                    "ready": state.ready,
                    "paired": self._authorised(),
                },
                origin,
            )
            return

        if path == "/pair":
            # Deliberately before the token check — this is how a caller gets
            # one. The origin allow-list is the whole of the protection here,
            # so it is enforced strictly rather than by omitting CORS headers.
            if not origin:
                self._send(
                    403,
                    {
                        "error": "This origin is not allowed to pair with the companion.",
                        "code": "forbidden-origin",
                    },
                    None,
                )
                return
            self._send(200, {"token": self.companion.token}, origin)
            return

        if not self._authorised():
            self._send(403, {"error": "Missing or wrong companion token.", "code": "forbidden"}, origin)
            return

        if path == "/certificate":
            try:
                with self.companion.lock:
                    result = card.read_certificate()
            except card.CardError as error:
                self._send(409, {"error": str(error), "code": error.code}, origin)
                return

            self._send(
                200,
                {
                    "certificate": base64.b64encode(result["certificate"]).decode(),
                    "chain": [base64.b64encode(c).decode() for c in result["chain"]],
                },
                origin,
            )
            return

        self._send(404, {"error": "No such endpoint.", "code": "not-found"}, origin)

    def do_POST(self) -> None:  # noqa: N802
        origin = self._origin_allowed()
        path = urlparse(self.path).path

        if not self._authorised():
            self._send(403, {"error": "Missing or wrong companion token.", "code": "forbidden"}, origin)
            return

        if path != "/sign":
            self._send(404, {"error": "No such endpoint.", "code": "not-found"}, origin)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            # There is no endpoint here that takes a document, and this is what
            # keeps it that way.
            self._send(
                413,
                {"error": "This service signs a digest, not a document.", "code": "too-large"},
                origin,
            )
            return

        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "Malformed JSON.", "code": "bad-request"}, origin)
            return

        try:
            data = base64.b64decode(request["data"], validate=True)
            expect = base64.b64decode(request["certificate"], validate=True)
            hash_name = str(request["hash"])
        except (KeyError, ValueError):
            self._send(
                400,
                {
                    "error": "Expected {data, hash, certificate}, all base64 except hash.",
                    "code": "bad-request",
                },
                origin,
            )
            return

        try:
            # Serialised: the card does one thing at a time, and two PIN dialogs
            # at once is not a state worth discovering.
            with self.companion.lock:
                result = card.sign_data(data, hash_name, expect)
        except card.CardError as error:
            self._send(409, {"error": str(error), "code": error.code}, origin)
            return

        self._send(
            200,
            {
                "signature": base64.b64encode(result["signature"]).decode(),
                "algorithm": result["algorithm"],
                "certificate": base64.b64encode(result["certificate"]).decode(),
            },
            origin,
        )


def serve(host: str, port: int, token: str, allowed_origins: list[str]) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"companion": Companion(token, allowed_origins)})
    return ThreadingHTTPServer((host, port), handler)

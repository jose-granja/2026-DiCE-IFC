"""
The Cartão de Cidadão time-stamp, asked for from the citizen's own machine.

The Autenticação.gov application stamps signatures through the Cartão de
Cidadão time-stamping service, `ts.cartaodecidadao.pt`: free, no login, and
limited to **20 requests in any 20 minutes**, after which it blocks the caller
for 24 hours (pki.cartaodecidadao.pt). The limit is per caller, so the request
has to come from the citizen's machine, as the Autenticação.gov app's does — a
web server asking for everyone would spend one shared budget and get every user
blocked at once. That is why this is here and not in the web app (ADR 012,
amended 2026-11-22).

It is a relay to one host and nothing more:

- **The host is fixed.** The caller cannot name another; this is not a proxy.
- **The body must be an RFC 3161 request for a SHA-256 hash**, in exactly the
  shape the web app builds — version 1, a SHA-256 imprint, a nonce, certReq.
  Nothing else is forwarded, so nothing of a document can be.
- **It stays under the limit.** It counts its own requests and refuses the
  `BUDGET`-th one inside the window instead of letting the service block the
  citizen for a day. A refused stamp is reported, and the signature is kept
  without one (the web app already handles a failed stamp that way).
- **The answer is passed back untouched.** The web app parses it and checks it
  stamps *its* hash and *its* nonce; this program does not, so a reply it
  mangled could not be mistaken for a good one.

Nothing here is logged.
"""

from __future__ import annotations

import threading
import time
import urllib.error
import urllib.request
from collections import deque

TSA_URL = "http://ts.cartaodecidadao.pt/tsa/server"
TSA_NAME = "Cartão de Cidadão"

# The service allows 20 in 20 minutes. Two are left for the Autenticação.gov
# application, or anything else on this machine that stamps, which this
# program cannot see.
WINDOW_SECONDS = 20 * 60
BUDGET = 18

MAX_REQUEST_BYTES = 128
MAX_REPLY_BYTES = 64 * 1024
TIMEOUT_SECONDS = 15

_SHA256_OID = bytes.fromhex("0609608648016503040201")


class TimestampError(Exception):
    def __init__(self, code: str, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


# ---------------------------------------------------------------- the request


def _read(data: bytes, offset: int) -> tuple[int, bytes, int]:
    """One DER value: (tag, content, offset after it). Short and long lengths."""
    if offset + 2 > len(data):
        raise ValueError("truncated")
    tag = data[offset]
    length = data[offset + 1]
    cursor = offset + 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or count > 2 or cursor + count > len(data):
            raise ValueError("bad length")
        length = int.from_bytes(data[cursor : cursor + count], "big")
        cursor += count
    if cursor + length > len(data):
        raise ValueError("truncated")
    return tag, data[cursor : cursor + length], cursor + length


def _children(content: bytes) -> list[tuple[int, bytes]]:
    out = []
    offset = 0
    while offset < len(content):
        tag, value, offset = _read(content, offset)
        out.append((tag, value))
    return out


def check_request(data: bytes) -> None:
    """
    Accept a `TimeStampReq` for a SHA-256 hash, in the web app's shape, and
    nothing else: version 1, `messageImprint` (SHA-256, 32 bytes), a nonce of
    at most 16 bytes, and optionally `certReq`. No policy, no extensions.
    """
    if not data or len(data) > MAX_REQUEST_BYTES:
        raise TimestampError("bad-request", "That is not a time-stamp request for a hash.")
    try:
        tag, content, end = _read(data, 0)
        if tag != 0x30 or end != len(data):
            raise ValueError("not one SEQUENCE")
        fields = _children(content)
        if len(fields) not in (3, 4):
            raise ValueError("fields")
        if fields[0] != (0x02, b"\x01"):
            raise ValueError("version")
        tag, imprint = fields[1]
        if tag != 0x30:
            raise ValueError("imprint")
        algorithm, hashed = _children(imprint)
        if algorithm[0] != 0x30 or hashed[0] != 0x04 or len(hashed[1]) != 32:
            raise ValueError("imprint")
        parts = _children(algorithm[1])
        if not parts or bytes([parts[0][0], len(parts[0][1])]) + parts[0][1] != _SHA256_OID:
            raise ValueError("algorithm")
        if len(parts) > 2 or (len(parts) == 2 and parts[1] != (0x05, b"")):
            raise ValueError("parameters")
        tag, nonce = fields[2]
        if tag != 0x02 or not 1 <= len(nonce) <= 16:
            raise ValueError("nonce")
        if len(fields) == 4 and fields[3] != (0x01, b"\xff"):
            raise ValueError("certReq")
    except (ValueError, IndexError) as error:
        raise TimestampError("bad-request", "That is not a time-stamp request for a hash.") from error


# ---------------------------------------------------------------- the budget


class Budget:
    """Requests in the last `WINDOW_SECONDS`, kept under `BUDGET`."""

    def __init__(self, budget: int = BUDGET, window: float = WINDOW_SECONDS, clock=time.monotonic):
        self.budget = budget
        self.window = window
        self.clock = clock
        self.sent: deque[float] = deque()
        self.lock = threading.Lock()

    def _forget(self, now: float) -> None:
        while self.sent and now - self.sent[0] >= self.window:
            self.sent.popleft()

    def take(self) -> None:
        with self.lock:
            now = self.clock()
            self._forget(now)
            if len(self.sent) >= self.budget:
                retry = int(self.window - (now - self.sent[0])) + 1
                raise TimestampError(
                    "rate-limited",
                    f"The Cartão de Cidadão time-stamp service allows 20 requests in 20 minutes; "
                    f"try again in {max(1, retry // 60)} min.",
                    retry_after=retry,
                )
            self.sent.append(now)

    def remaining(self) -> int:
        with self.lock:
            self._forget(self.clock())
            return self.budget - len(self.sent)


# ---------------------------------------------------------------- the relay


def post(body: bytes) -> bytes:
    """POST to the one service. Replaced in tests; nothing else calls out."""
    request = urllib.request.Request(
        TSA_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/timestamp-query",
            "Accept": "application/timestamp-reply",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        reply = response.read(MAX_REPLY_BYTES + 1)
    if len(reply) > MAX_REPLY_BYTES:
        raise TimestampError("tsa-error", "The time-stamp service's answer was too large.")
    return reply


def relay(data: bytes, budget: Budget) -> bytes:
    """Check, count, forward. The reply is returned exactly as received."""
    check_request(data)
    budget.take()
    try:
        return post(data)
    except TimestampError:
        raise
    except urllib.error.HTTPError as error:
        raise TimestampError("tsa-error", f"The time-stamp service answered {error.code}.") from error
    except (urllib.error.URLError, OSError) as error:
        raise TimestampError("tsa-unreachable", "The time-stamp service could not be reached.") from error

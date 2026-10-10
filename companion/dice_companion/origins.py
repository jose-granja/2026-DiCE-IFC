"""
Which web origins may talk to the companion.

The allow-list is the control that matters (see `server.py`): the companion
hands its pairing token only to an origin on it, and a page from anywhere else
cannot read a response. That is also why it has to be *configurable* — the
companion is installed on a citizen's machine and the app it serves lives at
whatever address the deployment has, which is not known when this code is
written. With only `localhost:3000` on the list, an installed companion silently
refused every production site, and the app reported it as "not running".

Sources, merged (all of them apply):

  1. the development defaults;
  2. `--allow-origin` on the command line;
  3. `DICE_COMPANION_ORIGINS` — origins separated by commas or spaces;
  4. a file next to the program, `allowed-origins.txt`, one origin per line —
     what the installers are built with, so the download from a deployment
     works as installed;
  5. the same file name in `~/.dice-ifc/`, for adding a site without
     rebuilding anything.

An origin is `scheme://host[:port]` and nothing else. Wildcards are refused:
`*` would turn the allow-list into "any web page", which is the one thing it
exists to prevent.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

FILE_NAME = "allowed-origins.txt"
ENV_VAR = "DICE_COMPANION_ORIGINS"


class InvalidOrigin(ValueError):
    pass


def normalise(value: str) -> str:
    """`https://App.Example.com:443/` -> `https://app.example.com` (what browsers send)."""
    text = value.strip()
    if "*" in text:
        raise InvalidOrigin(f"{value!r}: wildcards are not allowed")
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise InvalidOrigin(f"{value!r}: an origin looks like https://app.example.com")
    if parsed.path not in ("", "/") or parsed.params or parsed.query or parsed.fragment:
        raise InvalidOrigin(f"{value!r}: an origin has no path — use only scheme, host and port")
    host = parsed.hostname.lower()
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    port = parsed.port
    suffix = f":{port}" if port and port != default_port else ""
    return f"{parsed.scheme}://{host}{suffix}"


def _parse_lines(text: str) -> list[str]:
    origins = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            origins.append(line)
    return origins


def _split(text: str) -> list[str]:
    return [part for part in re.split(r"[,\s]+", text) if part]


def _bundle_dir() -> Path:
    """Where data shipped with the program lives: the PyInstaller bundle, or the package."""
    frozen = getattr(sys, "_MEIPASS", None)
    return Path(frozen) if frozen else Path(__file__).resolve().parent


def _read(path: Path) -> list[str]:
    try:
        return _parse_lines(path.read_text(encoding="utf-8"))
    except OSError:
        return []


def load_origins(cli: list[str] | None = None, environ: dict[str, str] | None = None,
                 home: Path | None = None) -> tuple[list[str], list[str]]:
    """Return `(origins, problems)`. A bad entry is reported and skipped, never trusted."""
    environ = os.environ if environ is None else environ
    home = home or Path.home()

    candidates = [
        *DEFAULT_ORIGINS,
        *(cli or []),
        *_split(environ.get(ENV_VAR, "")),
        *_read(_bundle_dir() / FILE_NAME),
        *_read(home / ".dice-ifc" / FILE_NAME),
    ]

    origins: list[str] = []
    problems: list[str] = []
    for candidate in candidates:
        try:
            origin = normalise(candidate)
        except InvalidOrigin as error:
            problems.append(str(error))
            continue
        if origin not in origins:
            origins.append(origin)
    return origins, problems

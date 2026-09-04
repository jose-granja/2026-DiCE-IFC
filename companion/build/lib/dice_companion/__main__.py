"""
Start the companion.

Binds to 127.0.0.1 only. This service must never be reachable from another
machine: it is a remote-signing service for anyone who can talk to it, and the
only person entitled to that is the one sitting at the card reader.
"""

from __future__ import annotations

import argparse
import secrets
import sys

# Absolute, not `from . import ...`: PyInstaller's spec (`packaging/dice-
# companion.spec`) points `Analysis` straight at this file, so it runs as a
# bare top-level script named `__main__` with no parent package — exactly
# the case relative imports cannot resolve, and where they fail silently
# until run, since `python -m dice_companion` and the `dice-companion`
# console-script entry point both give this module a real package context
# and never surface the bug. Absolute imports resolve the same way in every
# case: `dice_companion` is on `sys.path` in all three (source checkout,
# console script, PyInstaller bundle), so there's nothing relative imports
# buy here that's worth the one invocation path they break.
from dice_companion import __version__, card
from dice_companion.server import serve

DEFAULT_PORT = 8765
DEFAULT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="dice-companion",
        description="Sign with a Cartão de Cidadão on behalf of DiCE-IFC running in your browser.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=None,
        help="Origin allowed to call this companion. Repeatable. "
        f"Defaults to {', '.join(DEFAULT_ORIGINS)}.",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Use a fixed token instead of a fresh random one. For development only.",
    )
    parser.add_argument(
        "--show-token",
        action="store_true",
        help="Print the pairing token. Only needed for debugging; the browser "
        "fetches it from /pair by itself.",
    )
    args = parser.parse_args()

    origins = args.allow_origin or DEFAULT_ORIGINS
    token = args.token or secrets.token_hex(24)

    state = card.status()
    print(f"DiCE-IFC signing companion {__version__}")
    print()
    if state.module_path:
        print(f"  middleware   {state.module_path}")
    else:
        print("  middleware   NOT FOUND — install the Autenticação.gov application")
    print(f"  reader       {state.reader or 'none detected'}")
    print(f"  card         {'present' if state.card_present else 'not inserted'}")
    print()
    print(f"  Listening on http://127.0.0.1:{args.port}")
    print("  Nothing to copy: DiCE-IFC pairs with this automatically.")
    if args.show_token:
        print(f"  Token   {token}")
    print()
    print(f"  Accepting requests from: {', '.join(origins)}")
    print("  Only those origins can pair; anything else is refused.")
    print("  Press Ctrl-C to stop. Your PIN is asked for by the card middleware,")
    print("  in its own window — this program never sees it.")
    print()

    httpd = serve("127.0.0.1", args.port, token, origins)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
#
# Remove the DiCE-IFC signing companion from this Mac.
#
#   ./packaging/uninstall_macos.sh            (from a checkout)
#   dice-companion-uninstall                  (installed by the .pkg)
#
# Undoes exactly what the .pkg did: stops the LaunchAgent, deletes the program
# and the agent's plist, and forgets the package receipt. It asks for your
# password once, for the parts that live outside your home folder.
#
# Add --purge to also delete ~/.dice-ifc (your own allowed-origins.txt). Left
# alone by default: it is yours, not the installer's, and a reinstall wants it.
set -euo pipefail

LABEL="pt.dice.companion"
PROGRAM="/usr/local/bin/dice-companion"
UNINSTALLER="/usr/local/bin/dice-companion-uninstall"
PLIST="/Library/LaunchAgents/${LABEL}.plist"
USER_DIR="${HOME}/.dice-ifc"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This removes the macOS install; on Windows use Apps > Installed apps." >&2
  exit 1
fi

# Stop it first, or it would still hold port 8765 and be restarted by launchd.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
pkill -x dice-companion 2>/dev/null || true

echo "Removing the program, its login agent and the install receipt (needs your password)..."
sudo rm -f "${PROGRAM}" "${UNINSTALLER}" "${PLIST}"
sudo pkgutil --forget "${LABEL}" >/dev/null 2>&1 || true

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "${USER_DIR}"
  echo "Removed ${USER_DIR}"
elif [[ -d "${USER_DIR}" ]]; then
  echo "Kept ${USER_DIR} (your settings). Run again with --purge to delete it."
fi

if lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Something is still listening on 127.0.0.1:8765:" >&2
  lsof -nP -iTCP:8765 -sTCP:LISTEN >&2
  exit 1
fi

echo "DiCE-IFC companion removed."

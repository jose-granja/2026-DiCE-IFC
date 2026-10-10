#!/usr/bin/env bash
#
# Build the macOS installer.
#
#   ./packaging/build_macos.sh
#
# Produces dist/DiCE-IFC-Companion-<version>-macos-<arch>.pkg, which installs
# the companion to /usr/local/bin and registers a LaunchAgent so it starts at
# login. There is nothing to start by hand afterwards, which is the point: the
# browser pairs with whatever is listening on 127.0.0.1:8765.
#
# NOT SIGNED OR NOTARISED. Without an Apple Developer ID this .pkg raises
# Gatekeeper's "unidentified developer" warning and needs a right-click → Open.
# Signing is ADR 004's open question Q2 and needs a certificate, not a code
# change. Set DEVELOPER_ID to sign:
#
#   DEVELOPER_ID="Developer ID Installer: Your Org (TEAMID)" ./packaging/build_macos.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(python3 -c 'import tomllib;print(tomllib.load(open("pyproject.toml","rb"))["project"]["version"])')"
ARCH="$(uname -m)"
STAGE="build/pkg-root"
OUT="dist_mac/DiCE-IFC-Companion-${VERSION}-macos-${ARCH}.pkg"

rm -rf build dist_mac
python3 -m pip install --quiet --upgrade pyinstaller .
# --distpath: PyInstaller writes to ./dist unless told otherwise, and everything
# below reads from dist_mac.
python3 -m PyInstaller --clean --noconfirm --distpath dist_mac packaging/dice-companion.spec

mkdir -p "${STAGE}/usr/local/bin" "${STAGE}/Library/LaunchAgents"
cp dist_mac/dice-companion "${STAGE}/usr/local/bin/dice-companion"
chmod 755 "${STAGE}/usr/local/bin/dice-companion"
# Shipped with the program so removing it never needs the repository.
cp packaging/uninstall_macos.sh "${STAGE}/usr/local/bin/dice-companion-uninstall"
chmod 755 "${STAGE}/usr/local/bin/dice-companion-uninstall"
sed "s/@VERSION@/${VERSION}/g" packaging/pt.dice.companion.plist \
  > "${STAGE}/Library/LaunchAgents/pt.dice.companion.plist"

mkdir -p dist_mac
pkgbuild \
  --root "${STAGE}" \
  --identifier pt.dice.companion \
  --version "${VERSION}" \
  --scripts packaging/macos-scripts \
  --install-location / \
  "${OUT}"

if [[ -n "${DEVELOPER_ID:-}" ]]; then
  productsign --sign "${DEVELOPER_ID}" "${OUT}" "${OUT}.signed"
  mv "${OUT}.signed" "${OUT}"
  echo "Signed with ${DEVELOPER_ID}. Notarise with: xcrun notarytool submit ${OUT}"
else
  echo "WARNING: unsigned. Gatekeeper will warn on install."
fi

echo "Built ${OUT}"

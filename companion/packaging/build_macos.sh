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
OUT="dist/DiCE-IFC-Companion-${VERSION}-macos-${ARCH}.pkg"

rm -rf build dist
python3 -m pip install --quiet --upgrade pyinstaller .
python3 -m PyInstaller --clean --noconfirm packaging/dice-companion.spec

mkdir -p "${STAGE}/usr/local/bin" "${STAGE}/Library/LaunchAgents"
cp dist/dice-companion "${STAGE}/usr/local/bin/dice-companion"
chmod 755 "${STAGE}/usr/local/bin/dice-companion"
sed "s/@VERSION@/${VERSION}/g" packaging/pt.dice.companion.plist \
  > "${STAGE}/Library/LaunchAgents/pt.dice.companion.plist"

mkdir -p dist
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

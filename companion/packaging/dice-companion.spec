# PyInstaller build of the DiCE-IFC signing companion.
#
# One file, no console window on Windows — this is started by a citizen, not by
# a developer, and a terminal that must stay open is a support call waiting to
# happen. On macOS the same binary runs from a LaunchAgent.
#
# What must be bundled and is easy to miss: PyKCS11 ships a compiled extension
# (`PyKCS11.LowLevel`), so the build has to happen on the target OS **and**
# architecture. There is no cross-compiling here.
#
# The Autenticação.gov middleware is deliberately NOT bundled. It is a
# government-distributed component that the citizen installs and updates
# themselves; shipping a copy would mean shipping a stale one, and the whole
# point of PKCS#11 is that the module is theirs, not ours.

import sys

block_cipher = None

a = Analysis(
    ["../dice_companion/__main__.py"],
    pathex=[".."],
    binaries=[],
    datas=[],
    hiddenimports=["PyKCS11", "PyKCS11.LowLevel"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc_data"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="dice-companion",
    debug=False,
    strip=False,
    upx=False,
    # A window would be the only visible sign it is running on Windows, but it
    # also invites people to close it. The installer adds a Startup entry
    # instead, and the setup page reports whether it is answering.
    console=sys.platform != "win32",
)

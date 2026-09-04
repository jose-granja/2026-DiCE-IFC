# Building the companion installers

One installer per operating system, each built **on** that operating system.
There is no cross-compiling: PyKCS11 is a compiled extension, so the build has
to match the target OS *and* CPU architecture.

| Target | Command | Output |
|---|---|---|
| macOS | `./packaging/build_macos.sh` | `dist/DiCE-IFC-Companion-<v>-macos-<arch>.pkg` |
| Windows | `powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1` | `dist\DiCE-IFC-Companion-<v>-windows-setup.exe` |

`.github/workflows/companion.yml` runs both on a `companion-v*` tag and attaches
the results to a GitHub release.

## What the installers do

Both install the binary and arrange for it to **run at login** — a LaunchAgent
on macOS, a Startup shortcut on Windows. Nothing has to be started by hand and
nothing has to be copied into the browser: the app pairs with whatever is
listening on `127.0.0.1:8765`.

Windows installs per-user (`PrivilegesRequired=lowest`). A helper that drives
your own card needs no machine-wide state, and a signing tool that demands
administrator rights is exactly the prompt people should refuse.

The companion runs as the logged-in user rather than as a service, because the
Autenticação.gov middleware raises its PIN window on that user's desktop. A
Windows service in session 0 could never show it.

## What they deliberately do not do

**They do not bundle the Autenticação.gov middleware.** It is government-
distributed, updated on its own schedule, and the whole point of PKCS#11 is that
the module belongs to the citizen. Shipping a copy would mean shipping a stale
one. The setup page detects its absence and links to the download.

## Code signing — not done

Neither installer is signed:

- **macOS** raises Gatekeeper's "unidentified developer" warning; installing
  needs right-click → Open. Set `DEVELOPER_ID` to sign, then notarise with
  `xcrun notarytool`.
- **Windows** triggers SmartScreen on first run. Set `SIGNTOOL_CERT` to sign.

This is ADR 004's open question **Q2**, and it is a certificate-and-money
problem rather than a code one: an Apple Developer ID (99 USD/year) and an EV
code-signing certificate (a few hundred a year, on a hardware token). Until
those exist, the honest thing is to warn people that the warning is expected
rather than to pretend it will not appear — the download page says so.

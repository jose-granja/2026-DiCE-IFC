# Build the Windows installer.
#
#   powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1
#
# Produces dist\DiCE-IFC-Companion-<version>-windows-setup.exe. Needs Inno
# Setup 6 (`winget install JRSoftware.InnoSetup`) and a 64-bit Python, because
# the Autenticação.gov PKCS#11 module is 64-bit and a 32-bit host cannot load it.
#
# NOT CODE-SIGNED — see dice-companion.iss. Set SIGNTOOL_CERT to sign.
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$version = python -c "import tomllib;print(tomllib.load(open('pyproject.toml','rb'))['project']['version'])"
$env:COMPANION_VERSION = $version

if ([System.Environment]::Is64BitProcess -eq $false) {
  throw "Build with 64-bit Python: the pteid PKCS#11 module is 64-bit and a 32-bit build cannot load it."
}

Remove-Item -Recurse -Force build, dist_win -ErrorAction SilentlyContinue
python -m pip install --quiet --upgrade pyinstaller .
# -distpath: PyInstaller writes to .\dist unless told otherwise, and the Inno
# Setup script reads dist_win.
python -m PyInstaller --clean --noconfirm --distpath dist_win packaging\dice-companion.spec

$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { throw "Inno Setup 6 not found. winget install JRSoftware.InnoSetup" }
& $iscc packaging\dice-companion.iss

$installer = "dist_win\DiCE-IFC-Companion-$version-windows-setup.exe"
if ($env:SIGNTOOL_CERT) {
  & signtool sign /f $env:SIGNTOOL_CERT /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $installer
} else {
  Write-Warning "Unsigned. SmartScreen will warn on first run."
}

Write-Host "Built $installer"

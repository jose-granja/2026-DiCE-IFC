; Inno Setup script for the DiCE-IFC signing companion.
;
; Installs the PyInstaller binary and adds a Startup shortcut, so the companion
; is running whenever the citizen is logged in. Per-user (PrivilegesRequired=lowest)
; on purpose: this drives *their* card and needs no machine-wide state, and
; asking for administrator rights to install a signing helper is exactly the
; prompt people should be suspicious of.
;
; NOT CODE-SIGNED. Without an EV certificate SmartScreen warns on first run.
; That is ADR 004's open question Q2 — a certificate, not a code change.

#define AppName "DiCE-IFC Signing Companion"
#define AppVersion GetEnv("COMPANION_VERSION")
#define AppExe "dice-companion.exe"

[Setup]
AppId={{7B2F1C9E-4A3D-4E21-9B77-1D2C5E8A0F31}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=DiCE-IFC
DefaultDirName={autopf}\DiCE-IFC Companion
DefaultGroupName=DiCE-IFC
PrivilegesRequired=lowest
OutputDir=..\dist_win
OutputBaseFilename=DiCE-IFC-Companion-{#AppVersion}-windows-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The companion needs the Autenticação.gov middleware, which is 64-bit.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\dist_win\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
; Startup rather than a service: it must run as the logged-in user, because the
; card middleware raises its PIN window on that user's desktop. A service in
; session 0 could never show it.
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start the companion now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

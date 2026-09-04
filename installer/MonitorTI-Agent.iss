#define MyAppName "HenriTech Control Agent"
#ifndef MyAppVersion
  #define MyAppVersion "1.1.18"
#endif
#ifndef MyAppSourceDir
  #define MyAppSourceDir "agent-1.1.18"
#endif
#define MyPublisher "Monitor TI"
#define MyUrl "https://monitor-ti.local"

[Setup]
AppId={{MONITORTI-AGENT-INSTALLER-2026}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyPublisher}
AppPublisherURL={#MyUrl}
DefaultDirName={autopf}\MonitorTI\Agent
PrivilegesRequired=admin
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
; Nao cria atalhos no Desktop/Menu Iniciar
DisableWelcomePage=no
OutputBaseFilename=HenriTech-Control-Agent-Setup-{#MyAppVersion}
; O diretorio de saida e definido por /O na linha de comando (build-installer.mjs)

[Files]
Source: "..\release\{#MyAppSourceDir}\MonitorTI-Agent.exe"; DestDir: "{app}"; Flags: ignoreversion; BeforeInstall: PrepareExistingInstall
Source: "..\release\{#MyAppSourceDir}\MonitorTI-Notifier.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\release\{#MyAppSourceDir}\notifier-integrity.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\agent\config.json"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist
Source: "..\release\{#MyAppSourceDir}\WinSW.exe"; DestName: "MonitorTIAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "MonitorTIAgent.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "notifier-companion-task.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Run]
; 1) registra o servico (WinSW usa MonitorTIAgent.xml no mesmo diretorio)
Filename: "{app}\MonitorTIAgent.exe"; Parameters: "install"; Flags: runhidden; StatusMsg: "Registrando serviço Monitor TI Agent..."
; 2) garante inicializacao automatica
Filename: "sc"; Parameters: "config MonitorTIAgent start= auto"; Flags: runhidden
; 3) recuperacao: reiniciar apos falhas (5s)
Filename: "sc"; Parameters: "failure MonitorTIAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000"; Flags: runhidden
; 4) instala/atualiza a task companion do Notifier
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\notifier-companion-task.ps1"" install -InstallDir ""{app}"""; Flags: runhidden; StatusMsg: "Configurando task MonitorTI-Notifier..."
; 5) inicia o servico
Filename: "{app}\MonitorTIAgent.exe"; Parameters: "start"; Flags: runhidden; StatusMsg: "Iniciando serviço Monitor TI Agent..."
; 6) inicia o Companion na sessão interativa atual, se houver
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\notifier-companion-task.ps1"" run -InstallDir ""{app}"""; Flags: runhidden; StatusMsg: "Iniciando Companion do Notifier..."

[UninstallRun]
; Para e remove o servico (nao toca em ProgramData\MonitorTI)
Filename: "{app}\MonitorTIAgent.exe"; Parameters: "stop"; Flags: runhidden
Filename: "{app}\MonitorTIAgent.exe"; Parameters: "uninstall"; Flags: runhidden
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\notifier-companion-task.ps1"" remove -InstallDir ""{app}"""; Flags: runhidden

[UninstallDelete]
; Remove arquivos/restos do diretorio de instalacao.
; ProgramData\MonitorTI (deviceId, logs) e preservado por padrao.
Type: filesandordirs; Name: "{app}"

[Code]
procedure PrepareExistingInstall;
var
  ResultCode: Integer;
begin
  if FileExists(ExpandConstant('{app}\MonitorTIAgent.exe')) then
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "MonitorTI-Notifier"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if FileExists(ExpandConstant('{app}\MonitorTIAgent.exe')) then
    Exec(ExpandConstant('{app}\MonitorTIAgent.exe'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if FileExists(ExpandConstant('{app}\notifier-companion-task.ps1')) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{app}\notifier-companion-task.ps1" remove -InstallDir "{app}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

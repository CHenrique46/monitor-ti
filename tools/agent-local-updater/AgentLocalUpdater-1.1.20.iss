#define TargetVersion "1.1.20"
#define AgentHash "f9e10960bda3e3213c8ea5a6059440204a801c62d4db8ee40e7e9d6e38cba6d0"
#define NotifierHash "86da924d60223e32a654526658c21b707574aedc80332611257197ffe79640b5"
#define MetadataHash "843bdf4d6daf9fdf6f80a2acae484667866395b211bcb6bf8c99dd47f9f8efdb"

[Setup]
AppId={{A1E4A4E7-4F64-4F5B-9BA4-HTCONTROL-AGENT-UPDATE}}
AppName=HenriTech Control Agent Update
AppVersion={#TargetVersion}
AppPublisher=HenriTech Control
DefaultDirName={tmp}\HenriTech-Control-Agent-Update
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
Uninstallable=no
PrivilegesRequired=admin
OutputDir=..\..\release\agent-local-updater-1.1.20
OutputBaseFilename=HenriTech-Control-Agent-Update-1.1.20
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64

[Files]
Source: "..\..\release\agent-1.1.20\MonitorTI-Agent.exe"; DestDir: "{tmp}"; Flags: dontcopy
Source: "..\..\release\agent-1.1.20\MonitorTI-Notifier.exe"; DestDir: "{tmp}"; Flags: dontcopy
Source: "..\..\release\agent-1.1.20\notifier-integrity.json"; DestDir: "{tmp}"; Flags: dontcopy
Source: "..\..\installer\notifier-companion-task.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Code]
const
  ServiceName = 'MonitorTIAgent';
  TargetVersion = '{#TargetVersion}';
  AgentHash = '{#AgentHash}';
  NotifierHash = '{#NotifierHash}';
  MetadataHash = '{#MetadataHash}';

var
  PayloadPath: string;
  NotifierPayloadPath: string;
  IntegrityPayloadPath: string;
  TaskScriptPath: string;
  LogPath: string;
  UpdateStarted: Boolean;

function ServiceStateIs(const Expected: string): Boolean; forward;
function ChangeServiceState(const Command: string; const Expected: string): Boolean; forward;

function Timestamp: string;
begin
  Result := GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':');
end;

procedure WriteLog(const Line: string);
begin
  if LogPath = '' then begin
    LogPath := ExpandConstant('{commonappdata}\MonitorTI\logs\local-updater.log');
    ForceDirectories(ExtractFileDir(LogPath));
  end;
    SaveStringToFile(LogPath, Timestamp + ' ' + Line + #13#10, True);
end;

procedure AbortUpdate(const Message: string);
begin
  if UpdateStarted and not ServiceStateIs('RUNNING') then begin
    WriteLog('rollback_service_restart=required');
    if not ChangeServiceState('start', 'RUNNING') then
      WriteLog('ROLLBACK_SERVICE_RESTART_FAILED');
  end;
  WriteLog('resultado=ABORTED reason=' + Message);
  MsgBox(Message, mbError, MB_OK);
  Abort;
end;

function RunSc(const Args: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function RunTaskScript(const Mode, InstallDir: string): Boolean;
var
  ResultCode: Integer;
begin
  WriteLog('task_' + Mode + '=requested');
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + TaskScriptPath +
    '" -Mode ' + Mode + ' -InstallDir "' + InstallDir + '"', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if Result then WriteLog('task_' + Mode + '=ok')
  else WriteLog('task_' + Mode + '=failed code=' + IntToStr(ResultCode));
end;

function StopCompanion: Boolean;
var
  ResultCode: Integer;
begin
  WriteLog('notifier_stop=requested');
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN "MonitorTI-Notifier"', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
  if ResultCode <> 0 then WriteLog('notifier_stop_task=not_running_or_failed code=' + IntToStr(ResultCode));
end;

function NotifierProcessIsRunning(const InstallDir: string): Boolean;
var
  ResultCode: Integer;
  Command: string;
begin
  Command := '$p=Get-Process -Name ''MonitorTI-Notifier'' -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.Path -eq ''' + InstallDir + '\MonitorTI-Notifier.exe'' }; ' +
    'if ($p) { exit 0 } else { exit 1 }';
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "' + Command + '"', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function WaitForNotifierState(const InstallDir: string; Running: Boolean; Seconds: Integer): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Seconds do begin
    if NotifierProcessIsRunning(InstallDir) = Running then begin
      Result := True;
      exit;
    end;
    Sleep(1000);
  end;
end;

function ServiceStateIs(const Expected: string): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\cmd.exe'), '/C sc.exe query "' + ServiceName +
    '" | findstr /C:" ' + Expected + ' " > nul', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function ServiceImagePath(var ImagePath: string): Boolean;
begin
  Result := RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\' + ServiceName,
    'ImagePath', ImagePath);
  if Result then begin
    StringChangeEx(ImagePath, '%SystemRoot%', GetEnv('SystemRoot'), True);
    StringChangeEx(ImagePath, '%windir%', GetEnv('windir'), True);
    StringChangeEx(ImagePath, '%ProgramFiles%', GetEnv('ProgramFiles'), True);
    StringChangeEx(ImagePath, '%ProgramFiles(x86)%', GetEnv('ProgramFiles(x86)'), True);
  end;
end;

function ServiceInstallDir(var InstallDir: string): Boolean;
var
  ImagePath: string;
  CleanPath: string;
  ExePos: Integer;
begin
  Result := ServiceImagePath(ImagePath);
  if not Result then exit;
  CleanPath := Trim(ImagePath);
  if (Length(CleanPath) > 0) and (CleanPath[1] = '"') then begin
    Delete(CleanPath, 1, 1);
    ExePos := Pos('"', CleanPath);
    if ExePos > 0 then Delete(CleanPath, ExePos, Length(CleanPath));
  end else begin
    ExePos := Pos('.exe', LowerCase(CleanPath));
    if ExePos > 0 then SetLength(CleanPath, ExePos + 3);
  end;
  InstallDir := ExtractFileDir(CleanPath);
  Result := InstallDir <> '';
end;

function WaitForState(const Expected: string; Seconds: Integer): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to Seconds do begin
    if ServiceStateIs(Expected) then begin
      Result := True;
      exit;
    end;
    Sleep(1000);
  end;
end;

function ChangeServiceState(const Command: string; const Expected: string): Boolean;
begin
  WriteLog('service_' + Command + '=requested');
  Result := RunSc(Command + ' "' + ServiceName + '"') and WaitForState(Expected, 30);
  if Result then WriteLog('service_' + Command + '=ok')
  else WriteLog('service_' + Command + '=failed');
end;

function CheckInstallation(const InstallDir: string): Boolean;
begin
  Result := True;
  if not FileExists(InstallDir + '\MonitorTIAgent.exe') then begin
    MsgBox('Instalação inconsistente: MonitorTIAgent.exe não foi encontrado.', mbError, MB_OK);
    Result := False;
  end else if not FileExists(InstallDir + '\MonitorTI-Agent.exe') then begin
    MsgBox('Instalação inconsistente: MonitorTI-Agent.exe não foi encontrado.', mbError, MB_OK);
    Result := False;
  end else if not FileExists(InstallDir + '\MonitorTIAgent.xml') then begin
    MsgBox('Instalação inconsistente: MonitorTIAgent.xml não foi encontrado.', mbError, MB_OK);
    Result := False;
  end else if not FileExists(InstallDir + '\config.json') then begin
    MsgBox('Instalação inconsistente: config.json não foi encontrado.', mbError, MB_OK);
    Result := False;
  end else if not FileExists(InstallDir + '\MonitorTI-Notifier.exe') then begin
    MsgBox('Instalação inconsistente: MonitorTI-Notifier.exe não foi encontrado.', mbError, MB_OK);
    Result := False;
  end;
end;

function Rollback(const InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath: string): Boolean;
var
  FilesOk: Boolean;
  TaskOk: Boolean;
  ServiceOk: Boolean;
begin
  WriteLog('rollback=started');
  DeleteFile(InstallDir + '\MonitorTI-Agent.exe');
  FilesOk := FileCopy(BackupPath, InstallDir + '\MonitorTI-Agent.exe', False);
  if FilesOk then FilesOk := LowerCase(GetSHA256OfFile(InstallDir + '\MonitorTI-Agent.exe')) = LowerCase(GetSHA256OfFile(BackupPath));
  if FileExists(NotifierBackupPath) then begin
    DeleteFile(InstallDir + '\MonitorTI-Notifier.exe');
    FilesOk := FileCopy(NotifierBackupPath, InstallDir + '\MonitorTI-Notifier.exe', False) and FilesOk;
  end;
  if FileExists(IntegrityBackupPath) then begin
    DeleteFile(InstallDir + '\notifier-integrity.json');
    FilesOk := FileCopy(IntegrityBackupPath, InstallDir + '\notifier-integrity.json', False) and FilesOk;
  end;
  if FileExists(TaskBackupPath) then begin
    DeleteFile(InstallDir + '\notifier-companion-task.ps1');
    FilesOk := FileCopy(TaskBackupPath, InstallDir + '\notifier-companion-task.ps1', False) and FilesOk;
  end;
  if FilesOk then WriteLog('rollback_files_restored=true')
  else WriteLog('rollback_files_restored=false');
  TaskOk := True;
  if FileExists(InstallDir + '\notifier-companion-task.ps1') then
    TaskOk := RunTaskScript('install', InstallDir);
  ServiceOk := ChangeServiceState('start', 'RUNNING');
  if not ServiceOk then WriteLog('ROLLBACK_SERVICE_RESTART_FAILED');
  Result := FilesOk and TaskOk and ServiceOk;
  if Result then WriteLog('rollback=ok') else WriteLog('rollback=failed');
end;

procedure PerformUpdate;
var
  InstallDir: string;
  CurrentAgent: string;
  CurrentNotifier: string;
  CurrentIntegrity: string;
  CurrentTask: string;
  BackupPath: string;
  NotifierBackupPath: string;
  IntegrityBackupPath: string;
  TaskBackupPath: string;
  CurrentHash: string;
  BackupHash: string;
  InstalledHash: string;
begin
  if not ServiceImagePath(CurrentAgent) then
    AbortUpdate('HenriTech Control Agent não está instalado nesta máquina.');
  if not ServiceInstallDir(InstallDir) then
    AbortUpdate('Não foi possível descobrir o diretório da instalação.');
  if LowerCase(InstallDir) <> LowerCase(ExpandConstant('{pf32}\MonitorTI\Agent')) then
    AbortUpdate('O serviço não usa o diretório esperado do Agent.');
  if not CheckInstallation(InstallDir) then Abort;

  CurrentAgent := InstallDir + '\MonitorTI-Agent.exe';
  CurrentNotifier := InstallDir + '\MonitorTI-Notifier.exe';
  CurrentIntegrity := InstallDir + '\notifier-integrity.json';
  CurrentTask := InstallDir + '\notifier-companion-task.ps1';
  if not FileExists(PayloadPath) then AbortUpdate('Payload embutido não encontrado.');
  if LowerCase(GetSHA256OfFile(PayloadPath)) <> LowerCase(AgentHash) then
    AbortUpdate('Payload embutido inválido. A atualização foi cancelada.');
  if LowerCase(GetSHA256OfFile(NotifierPayloadPath)) <> LowerCase(NotifierHash) then
    AbortUpdate('Payload do Notifier inválido. A atualização foi cancelada.');
  if not FileExists(IntegrityPayloadPath) then
    AbortUpdate('Metadata do Notifier ausente. A atualização foi cancelada.');
  if LowerCase(GetSHA256OfFile(IntegrityPayloadPath)) <> LowerCase(MetadataHash) then
    AbortUpdate('Metadata do Notifier inválido. A atualização foi cancelada.');
  CurrentHash := LowerCase(GetSHA256OfFile(CurrentAgent));
  WriteLog('target_version=' + TargetVersion + ' current_hash=' + CurrentHash + ' new_hash=' + AgentHash);

  BackupPath := InstallDir + '\backup\agent-before-' + TargetVersion + '-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.exe';
  NotifierBackupPath := ChangeFileExt(BackupPath, '.notifier.exe');
  IntegrityBackupPath := ChangeFileExt(BackupPath, '.integrity.json');
  TaskBackupPath := ChangeFileExt(BackupPath, '.task.ps1');
  ForceDirectories(InstallDir + '\backup');
  if not FileCopy(CurrentAgent, BackupPath, False) then
    AbortUpdate('Não foi possível criar o backup do Agent atual.');
  BackupHash := LowerCase(GetSHA256OfFile(BackupPath));
  if BackupHash <> CurrentHash then
    AbortUpdate('A validação do backup falhou. A atualização foi cancelada.');
  WriteLog('backup=' + BackupPath + ' backup_hash=' + BackupHash);
  if not FileCopy(CurrentNotifier, NotifierBackupPath, False) then AbortUpdate('Não foi possível criar o backup do Notifier.');
  if FileExists(CurrentIntegrity) and not FileCopy(CurrentIntegrity, IntegrityBackupPath, False) then AbortUpdate('Não foi possível criar o backup da metadata.');
  if FileExists(CurrentTask) and not FileCopy(CurrentTask, TaskBackupPath, False) then AbortUpdate('Não foi possível criar o backup da task.');

  if not ChangeServiceState('stop', 'STOPPED') then
    AbortUpdate('Não foi possível parar o serviço MonitorTIAgent.');
  UpdateStarted := True;
  StopCompanion;
  if not WaitForNotifierState(InstallDir, False, 30) then
    AbortUpdate('Não foi possível encerrar o Notifier anterior.');
  DeleteFile(CurrentAgent);
  if not FileCopy(PayloadPath, CurrentAgent, False) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível substituir o Agent. A versão anterior foi restaurada.');
  end;
  InstalledHash := LowerCase(GetSHA256OfFile(CurrentAgent));
  if InstalledHash <> LowerCase(AgentHash) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('A validação do Agent falhou. A versão anterior foi restaurada.');
  end;
  DeleteFile(CurrentNotifier);
  if not FileCopy(NotifierPayloadPath, CurrentNotifier, False) or
     (LowerCase(GetSHA256OfFile(CurrentNotifier)) <> LowerCase(NotifierHash)) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível validar o Notifier. A versão anterior foi restaurada.');
  end;
  DeleteFile(CurrentIntegrity);
  if not FileCopy(IntegrityPayloadPath, CurrentIntegrity, False) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível instalar a metadata. A versão anterior foi restaurada.');
  end;
  DeleteFile(CurrentTask);
  if not FileCopy(TaskScriptPath, CurrentTask, False) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível instalar o script da task. A versão anterior foi restaurada.');
  end;
  if not RunTaskScript('install', InstallDir) then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível validar a Scheduled Task. A versão anterior foi restaurada.');
  end;
  if not ChangeServiceState('start', 'RUNNING') then begin
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível iniciar o serviço. A versão anterior foi restaurada.');
  end;
  WriteLog('notifier_validation=start');
  if not RunTaskScript('run', InstallDir) or not WaitForNotifierState(InstallDir, True, 30) then begin
    WriteLog('notifier_validation=failed');
    Rollback(InstallDir, BackupPath, NotifierBackupPath, IntegrityBackupPath, TaskBackupPath);
    AbortUpdate('Não foi possível validar o Notifier. A versão anterior foi restaurada.');
  end;
  WriteLog('notifier_validation=ok');
  WriteLog('replace=ok installed_hash=' + InstalledHash + ' result=SUCCESS');
  MsgBox('HenriTech Control Agent atualizado com sucesso.', mbInformation, MB_OK);
end;

procedure InitializeWizard;
begin
  PayloadPath := ExpandConstant('{tmp}\MonitorTI-Agent.exe');
  NotifierPayloadPath := ExpandConstant('{tmp}\MonitorTI-Notifier.exe');
  IntegrityPayloadPath := ExpandConstant('{tmp}\notifier-integrity.json');
  TaskScriptPath := ExpandConstant('{tmp}\notifier-companion-task.ps1');
  ExtractTemporaryFile('MonitorTI-Agent.exe');
  ExtractTemporaryFile('MonitorTI-Notifier.exe');
  ExtractTemporaryFile('notifier-integrity.json');
  ExtractTemporaryFile('notifier-companion-task.ps1');
  if not FileExists(PayloadPath) then AbortUpdate('Não foi possível extrair o payload embutido.');
  if LowerCase(GetSHA256OfFile(PayloadPath)) <> LowerCase(AgentHash) then
    AbortUpdate('O payload embutido não corresponde ao hash aprovado.');
  WizardForm.Caption := 'HenriTech Control';
  WizardForm.WelcomeLabel1.Caption := 'Atualização do Agent';
  WizardForm.WelcomeLabel2.Caption := 'Versão instalada: detectada no serviço' + #13#10 +
    'Nova versão: ' + TargetVersion + #13#10#13#10 + 'Clique em Atualizar para continuar.';
  WizardForm.NextButton.Caption := 'Atualizar';
  WriteLog('updater_started target_version=' + TargetVersion);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then PerformUpdate;
end;

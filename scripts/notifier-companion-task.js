const TASK_NAME = "MonitorTI-Notifier";
const EXECUTABLE = "C:\\Program Files (x86)\\MonitorTI\\Agent\\MonitorTI-Notifier.exe";
const WORKING_DIRECTORY = "C:\\Program Files (x86)\\MonitorTI\\Agent";
const ARGUMENTS = ["--companion"];

function buildTaskSpec() {
  return {
    taskName: TASK_NAME,
    trigger: "At log on of any user",
    runOnlyWhenUserIsLoggedOn: true,
    executable: EXECUTABLE,
    workingDirectory: WORKING_DIRECTORY,
    arguments: ARGUMENTS.slice(),
    elevation: "none"
  };
}

function buildCreateOrUpdateCommand() {
  return 'schtasks /create /tn "' + TASK_NAME + '" /tr "\\"' + EXECUTABLE + '\\" --companion" /sc onlogon /rl limited /f';
}

function buildInstallCommand() {
  return buildCreateOrUpdateCommand();
}

function buildUpdateCommand() {
  return buildCreateOrUpdateCommand();
}

function buildRemoveCommand() {
  return `schtasks /delete /tn "${TASK_NAME}" /f`;
}

function buildRunCommand() {
  return `schtasks /run /tn "${TASK_NAME}"`;
}

function buildQueryCommand() {
  return `schtasks /query /tn "${TASK_NAME}" /fo list /v`;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec inválido");
  if (spec.taskName !== TASK_NAME) throw new Error("taskName inválido");
  if (spec.trigger !== "At log on of any user") throw new Error("trigger inválido");
  if (!spec.runOnlyWhenUserIsLoggedOn) throw new Error("flag de logon inválida");
  if (spec.executable !== EXECUTABLE) throw new Error("executável inválido");
  if (spec.workingDirectory !== WORKING_DIRECTORY) throw new Error("diretório de trabalho inválido");
  if (!Array.isArray(spec.arguments) || spec.arguments.length !== 1 || spec.arguments[0] !== "--companion") {
    throw new Error("argumentos inválidos");
  }
  if (spec.elevation !== "none") throw new Error("elevação inválida");
  return true;
}

if (require.main === module) {
  const mode = String(process.argv[2] || "spec").toLowerCase();
  const spec = buildTaskSpec();
  try {
    validateSpec(spec);
    if (mode === "install" || mode === "create" || mode === "update") {
      console.log(buildCreateOrUpdateCommand());
    } else if (mode === "run") {
      console.log(buildRunCommand());
    } else if (mode === "query") {
      console.log(buildQueryCommand());
    } else if (mode === "remove") {
      console.log(buildRemoveCommand());
    } else if (mode === "test") {
      console.log(JSON.stringify({ ok: true, spec, install: buildInstallCommand(), update: buildUpdateCommand(), run: buildRunCommand(), query: buildQueryCommand(), remove: buildRemoveCommand() }, null, 2));
    } else {
      console.log(JSON.stringify(spec, null, 2));
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  TASK_NAME,
  EXECUTABLE,
  WORKING_DIRECTORY,
  ARGUMENTS,
  buildTaskSpec,
  buildCreateOrUpdateCommand,
  buildInstallCommand,
  buildUpdateCommand,
  buildRunCommand,
  buildQueryCommand,
  buildRemoveCommand,
  validateSpec
};

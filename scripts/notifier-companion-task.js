const task = require("../agent/src/notices/task");

function buildPowerShellCommand(mode) {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    `"${task.getTaskScriptPath()}"`,
    "-Mode",
    mode
  ].join(" ");
}

function buildCreateOrUpdateCommand() {
  return buildPowerShellCommand("install");
}

function buildInstallCommand() {
  return buildCreateOrUpdateCommand();
}

function buildUpdateCommand() {
  return buildCreateOrUpdateCommand();
}

function buildRunCommand() {
  return buildPowerShellCommand("run");
}

function buildQueryCommand() {
  return buildPowerShellCommand("query");
}

function buildRemoveCommand() {
  return buildPowerShellCommand("remove");
}

module.exports = {
  ...task,
  buildPowerShellCommand,
  buildCreateOrUpdateCommand,
  buildInstallCommand,
  buildUpdateCommand,
  buildRunCommand,
  buildQueryCommand,
  buildRemoveCommand
};

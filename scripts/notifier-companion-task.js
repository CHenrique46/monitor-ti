const task = require("../agent/src/notices/task");

function joinCommand(args) {
  return ["schtasks"].concat(args).join(" ");
}

function buildCreateOrUpdateCommand() {
  return joinCommand(task.buildCreateOrUpdateArgs());
}

function buildInstallCommand() {
  return buildCreateOrUpdateCommand();
}

function buildUpdateCommand() {
  return buildCreateOrUpdateCommand();
}

function buildRunCommand() {
  return joinCommand(task.buildRunArgs());
}

function buildQueryCommand() {
  return joinCommand(task.buildQueryArgs());
}

function buildRemoveCommand() {
  return joinCommand(task.buildRemoveArgs());
}

module.exports = {
  ...task,
  buildCreateOrUpdateCommand,
  buildInstallCommand,
  buildUpdateCommand,
  buildRunCommand,
  buildQueryCommand,
  buildRemoveCommand
};

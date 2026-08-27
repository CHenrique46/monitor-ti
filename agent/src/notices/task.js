const { execFileSync } = require("child_process");

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

function buildCreateOrUpdateArgs() {
  return [
    "/create",
    "/tn",
    TASK_NAME,
    "/tr",
    `"${EXECUTABLE}" --companion`,
    "/sc",
    "onlogon",
    "/rl",
    "limited",
    "/f"
  ];
}

function buildRunArgs() {
  return ["/run", "/tn", TASK_NAME];
}

function buildQueryArgs() {
  return ["/query", "/tn", TASK_NAME, "/fo", "list", "/v"];
}

function buildQueryXmlArgs() {
  return ["/query", "/tn", TASK_NAME, "/xml"];
}

function buildRemoveArgs() {
  return ["/delete", "/tn", TASK_NAME, "/f"];
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return false;
  return (
    spec.taskName === TASK_NAME &&
    spec.trigger === "At log on of any user" &&
    spec.runOnlyWhenUserIsLoggedOn === true &&
    spec.executable === EXECUTABLE &&
    spec.workingDirectory === WORKING_DIRECTORY &&
    Array.isArray(spec.arguments) &&
    spec.arguments.length === 1 &&
    spec.arguments[0] === "--companion" &&
    spec.elevation === "none"
  );
}

function createOrUpdateTask(execImpl = execFileSync) {
  execImpl("schtasks", buildCreateOrUpdateArgs(), { stdio: "ignore", timeout: 10000 });
  return true;
}

function runTask(execImpl = execFileSync) {
  execImpl("schtasks", buildRunArgs(), { stdio: "ignore", timeout: 10000 });
  return true;
}

function queryTask(execImpl = execFileSync) {
  return execImpl("schtasks", buildQueryArgs(), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
}

function queryTaskXml(execImpl = execFileSync) {
  return execImpl("schtasks", buildQueryXmlArgs(), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
}

function removeTask(execImpl = execFileSync) {
  execImpl("schtasks", buildRemoveArgs(), { stdio: "ignore", timeout: 10000 });
  return true;
}

module.exports = {
  TASK_NAME,
  EXECUTABLE,
  WORKING_DIRECTORY,
  ARGUMENTS,
  buildTaskSpec,
  buildCreateOrUpdateArgs,
  buildRunArgs,
  buildQueryArgs,
  buildQueryXmlArgs,
  buildRemoveArgs,
  validateSpec,
  createOrUpdateTask,
  runTask,
  queryTask,
  queryTaskXml,
  removeTask
};

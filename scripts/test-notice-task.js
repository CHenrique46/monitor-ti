const {
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
} = require("./notifier-companion-task");
const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function main() {
  const spec = buildTaskSpec();
  check("TASK-001 spec correta", validateSpec(spec) === true);
  check("TASK-002 create/update idempotente", buildCreateOrUpdateCommand() === buildInstallCommand() && buildUpdateCommand() === buildInstallCommand());
  check("TASK-003 command line --companion", /--companion/.test(buildCreateOrUpdateCommand()));
  check("TASK-004 sem elevation", spec.elevation === "none");
  check("TASK-005 workingDirectory correto", spec.workingDirectory === WORKING_DIRECTORY);
  check("TASK-006 remove correto", /schtasks \/delete/.test(buildRemoveCommand()) && buildRemoveCommand().includes(TASK_NAME));
  check("TASK-007 run/query helpers", /schtasks \/run/.test(buildRunCommand()) && /schtasks \/query/.test(buildQueryCommand()) && Array.isArray(ARGUMENTS) && ARGUMENTS[0] === "--companion" && spec.executable === EXECUTABLE);
  const iss = fs.readFileSync(path.join(__dirname, "..", "installer", "MonitorTI-Agent.iss"), "utf8");
  check("TASK-008 installer inclui Notifier", /MonitorTI-Notifier\.exe/.test(iss));
  check("TASK-009 installer cria task", /notifier-companion-task\.ps1/.test(iss) && /install/.test(iss) && /remove/.test(iss));

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();

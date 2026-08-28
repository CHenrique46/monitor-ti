const {
  TASK_NAME,
  EXECUTABLE,
  WORKING_DIRECTORY,
  ARGUMENTS,
  buildTaskSpec,
  buildPowerShellCommand,
  buildPowerShellScript,
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
  const script = buildPowerShellScript();
  check("TASK-002 normaliza SID", /Resolve-TaskSchedulerSid/.test(script) && /S-1-5-11/.test(script));
  check("TASK-003 normaliza trigger CIM", /CimClassName/.test(script) && /LogonTrigger\$/.test(script));
  check("TASK-004 normaliza logon/runlevel", /Normalize-TaskLogonType/.test(script) && /Normalize-TaskRunLevel/.test(script));
  check("TASK-005 script usa logon trigger", /New-ScheduledTaskTrigger\s+-AtLogOn/.test(script));
  check("TASK-006 script preserva working directory", /New-ScheduledTaskAction\s+-Execute\s+\$Executable\s+-Argument\s+\$Arguments\s+-WorkingDirectory\s+\$WorkingDirectory/.test(script));
  check("TASK-007 script registra tarefa", /Register-ScheduledTask/.test(script) && /Export-ScheduledTask/.test(script) && /Unregister-ScheduledTask/.test(script));
  check("TASK-008 command install usa powershell", /powershell\.exe/.test(buildPowerShellCommand("install")) && /-Mode install/.test(buildPowerShellCommand("install")));
  check("TASK-009 sem elevation", spec.elevation === "none");
  check("TASK-010 workingDirectory correto", spec.workingDirectory === WORKING_DIRECTORY);
  check("TASK-011 argumentos corretos", Array.isArray(ARGUMENTS) && ARGUMENTS[0] === "--companion" && spec.executable === EXECUTABLE);
  const iss = fs.readFileSync(path.join(__dirname, "..", "installer", "MonitorTI-Agent.iss"), "utf8");
  check("TASK-012 installer inclui Notifier", /MonitorTI-Notifier\.exe/.test(iss));
  check("TASK-013 installer cria task", /notifier-companion-task\.ps1/.test(iss) && /install/.test(iss) && /remove/.test(iss));

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();

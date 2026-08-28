process.env.MTI_NOTIFIER_TASK_NAME = "MonitorTI-Notifier-Test";

const task = require("./notifier-companion-task");

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

function cleanup() {
  try {
    task.removeTask();
  } catch (e) {
    console.log("WARN cleanup falhou: " + e.message);
  }
}

function main() {
  try {
    const first = String(task.createOrUpdateTask() || "").trim().toLowerCase();
    check("SEMANTIC-001 cria task temporaria", /created|updated|unchanged/.test(first), first);

    const second = String(task.createOrUpdateTask() || "").trim().toLowerCase();
    check("SEMANTIC-002 idempotente na segunda execucao", second === "unchanged", second);

    const state = task.queryTaskState();
    check("SEMANTIC-003 task existe", !!state && state.exists === true, JSON.stringify(state));
    check("SEMANTIC-004 groupId canonico", state && state.groupId === "S-1-5-11", JSON.stringify(state));
    check("SEMANTIC-005 logonType canonico", state && state.logonType === "Group", JSON.stringify(state));
    check("SEMANTIC-006 runLevel canonico", state && state.runLevel === "Limited", JSON.stringify(state));
    check("SEMANTIC-007 trigger canonical", state && state.triggerType === "AtLogOn", JSON.stringify(state));
    check("SEMANTIC-008 execute canonico", state && state.executable === task.EXECUTABLE, JSON.stringify(state));
    check("SEMANTIC-009 arguments canonicos", state && state.arguments === "--companion", JSON.stringify(state));
    check("SEMANTIC-010 workingDirectory canonico", state && state.workingDirectory === task.WORKING_DIRECTORY, JSON.stringify(state));

    const xml = String(task.queryTaskXml() || "");
    check("SEMANTIC-011 XML com LogonTrigger", /<LogonTrigger\b/i.test(xml), xml);
    check("SEMANTIC-012 XML com SID", /<GroupId>S-1-5-11<\/GroupId>/.test(xml), xml);
    check("SEMANTIC-013 XML com exec", /<Command>[\s\S]*MonitorTI-Notifier\.exe<\/Command>/i.test(xml) && /<Arguments>--companion<\/Arguments>/i.test(xml), xml);
  } finally {
    cleanup();
  }

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();

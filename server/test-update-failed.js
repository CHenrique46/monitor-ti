const agentServer = require("./src/ws/agentServer");

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

function state(deviceId) {
  return agentServer.getUpdateState(deviceId);
}

function main() {
  agentServer.resetUpdateStatesForTests();

  const H = "henrique-test-device";
  const A = "anderson-test-device";

  agentServer.applyUpdateStatusMessage({
    deviceId: H,
    status: "update_installing",
    version: "1.1.10",
    targetVersion: "1.1.10",
    currentVersion: "1.1.9"
  });
  check("UF-001 update_installing", state(H) && state(H).status === "update_installing", JSON.stringify(state(H)));

  agentServer.applyUpdateStatusMessage({
    deviceId: H,
    status: "update_failed",
    version: "1.1.10",
    targetVersion: "1.1.10",
    currentVersion: "1.1.9",
    stage: "ensure_task",
    error: "tarefa registrada, mas nao validada com a definicao esperada",
    rolledBack: true
  });
  check("UF-002 update_failed", state(H) && state(H).status === "update_failed", JSON.stringify(state(H)));
  check("UF-003 updateError preenchido", state(H) && /nao validada/.test(state(H).updateError || ""), JSON.stringify(state(H)));
  check("UF-004 rolledBack true", state(H) && state(H).rolledBack === true, JSON.stringify(state(H)));
  check("UF-005 stage preservado", state(H) && state(H).stage === "ensure_task", JSON.stringify(state(H)));

  agentServer.applyRegisterUpdateSuccess(H, "1.1.9");
  check("UF-006 reconexao na versao antiga nao limpa fail", state(H) && state(H).status === "update_failed", JSON.stringify(state(H)));

  agentServer.clearUpdateState(H);
  agentServer.applyUpdateStatusMessage({
    deviceId: H,
    status: "update_installing",
    version: "1.1.10",
    targetVersion: "1.1.10",
    currentVersion: "1.1.9"
  });
  agentServer.applyRegisterUpdateSuccess(H, "1.1.10");
  check("UF-007 sucesso quando agentVersion == targetVersion", state(H) && state(H).status === "update_success", JSON.stringify(state(H)));

  check("UF-008 Anderson nao afetado", state(A) === null, JSON.stringify(state(A)));

  agentServer.resetUpdateStatesForTests();

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();

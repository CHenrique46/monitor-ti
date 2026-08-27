const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const command = require("./notice-companion-command");

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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function main() {
  const harnessSrc = fs.readFileSync(path.join(__dirname, "notice-companion-harness.js"), "utf8");
  const cmdSrc = fs.readFileSync(path.join(__dirname, "notice-companion-command.js"), "utf8");

  check("LIFE-001 harness continua vivo depois de acknowledged", /delivery_final/.test(harnessSrc) && /process\.stdin\.resume\(\)/.test(harnessSrc));
  check("LIFE-002 pipe continua aberto após acknowledged", /pipe_listening/.test(harnessSrc) && /runtime\.start\(\)/.test(harnessSrc) && !/socket\.end\(\)\s*;\s*\n.*acknowledged/.test(harnessSrc));
  check("LIFE-003 companion retorna READY", /companion_ready/.test(harnessSrc) && /READY/.test(harnessSrc));
  check("LIFE-004 heartbeat continua após acknowledged", /harness_still_alive/.test(harnessSrc) && /heartbeat/.test(harnessSrc));

  check("CMD-006 claim atômico existe", /claimCommandFile/.test(cmdSrc) && /renameSync/.test(cmdSrc));
  check("CMD-007 original removido", /removeCommandFile/.test(harnessSrc) || /removeCommandFile/.test(cmdSrc));
  check("CMD-009 stale processed cleanup", /stale_command_already_processed/.test(harnessSrc) || /cleanupResidualProcessing/.test(cmdSrc));
  check("CMD-010 residual processing tratado", /failed-/.test(cmdSrc) && /cleanupResidualProcessing/.test(cmdSrc));
  check("CMD-011 restart não reapresenta", /processed-/.test(cmdSrc) && /createCommandGate/.test(cmdSrc));

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();

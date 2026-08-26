// Lógica pura de decisão de atualização (sem dependências de runtime).
// Testável de forma isolada.

function parseVersion(v) {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersion(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

// Decide o comando de atualização conforme a versão do Agent.
// - Agents < 1.1.0 (ex.: 1.0.1) NÃO conhecem pacotes: recebem o fluxo
//   legado de arquivo único (só o Agent). Após instalarem o 1.1.0, o novo
//   Agent obtém o Notifier sozinho no primeiro boot.
// - Agents >= 1.1.0 recebem o pacote (Agent + Notifier) com validação de hashes.
function buildUpdateCommand(agentVersion, release) {
  const supportsPackage =
    compareVersion(agentVersion, "1.1.0") >= 0 &&
    !!release.packageName &&
    !!release.packageSha256 &&
    release.packageSize != null;

  if (supportsPackage) {
    let notifierSha256 = null;
    if (release.manifest && Array.isArray(release.manifest.files)) {
      const f = release.manifest.files.find((x) => x.name === "MonitorTI-Notifier.exe");
      if (f) notifierSha256 = f.sha256;
    }
    return {
      type: "update_agent",
      version: release.version,
      sha256: release.packageSha256,
      size: release.packageSize,
      package: true,
      notifierSha256
    };
  }

  // Fluxo legado (arquivo único).
  return {
    type: "update_agent",
    version: release.version,
    sha256: release.sha256,
    size: release.size
  };
}

module.exports = { parseVersion, compareVersion, buildUpdateCommand };

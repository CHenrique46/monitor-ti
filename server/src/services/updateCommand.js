// Lógica pura de decisão de atualização (sem dependências de runtime).
// Testável de forma isolada.

function parseVersion(v) {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
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
// - Agents <= 1.1.0 recebem o fluxo legado de arquivo único (só o Agent).
//   Isso preserva a compatibilidade com o 1.1.0 publicado antes da correção.
// - Agents >= 1.1.1 recebem o pacote (Agent + Notifier) com validação de hashes.
function buildUpdateCommand(agentVersion, release) {
  const supportsPackage =
    compareVersion(agentVersion, "1.1.1") >= 0 &&
    !!release.packageName &&
    !!release.packageSha256 &&
    release.packageSize != null;

  if (supportsPackage) {
    const packageMode = release.packageMode || (release.manifest && release.manifest.packageMode);
    if (packageMode !== "full" && packageMode !== "agent-only") return null;
    const command = {
      type: "update_agent",
      currentVersion: agentVersion,
      version: release.version,
      sha256: release.packageSha256,
      size: release.packageSize,
      package: true,
      packageMode
    };
    if (packageMode === "full") {
      const f = release.manifest && Array.isArray(release.manifest.files)
        ? release.manifest.files.find((x) => x.name === "MonitorTI-Notifier.exe")
        : null;
      command.notifierSha256 = f ? f.sha256 : null;
    }
    return command;
  }

  // Fluxo legado (arquivo único).
  return {
    type: "update_agent",
    currentVersion: agentVersion,
    version: release.version,
    sha256: release.sha256,
    size: release.size
  };
}

module.exports = { parseVersion, compareVersion, buildUpdateCommand };

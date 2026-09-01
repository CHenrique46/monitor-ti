export function bytesToGB(bytes, decimals = 1) {
  if (bytes === null || bytes === undefined) return "-";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(decimals)} GB`;
}

export function gb(bytes) {
  if (bytes === null || bytes === undefined) return null;
  return bytes / 1024 ** 3;
}

export function formatUptime(seg) {
  if (seg === null || seg === undefined) return "-";
  if (!Number.isFinite(Number(seg)) || Number(seg) < 0) return "-";
  seg = Math.floor(seg);
  const d = Math.floor(seg / 86400);
  const h = Math.floor((seg % 86400) / 3600);
  const m = Math.floor((seg % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m} min`;
}

export function formatPercent(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value)}%`;
}

export function sistemaLabel(s) {
  if (s === "win32" || s === "Windows_NT") return "Windows";
  if (s === "darwin") return "macOS";
  if (s === "linux") return "Linux";
  return s || "-";
}

export function fmtDate(d) {
  if (!d) return "-";
  return new Date(d).toLocaleString("pt-BR");
}

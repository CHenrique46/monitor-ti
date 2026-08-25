export function bytesToGB(bytes, decimals = 1) {
  if (bytes === null || bytes === undefined) return "-";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(decimals)} GB`;
}

export function formatUptime(seg) {
  if (seg === null || seg === undefined) return "-";
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

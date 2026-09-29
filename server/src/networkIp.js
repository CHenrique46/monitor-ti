const net = require("net");

function canonicalIpv6(value) {
  const groups = String(value).toLowerCase().split("::");
  if (groups.length > 2) return null;
  const left = groups[0] ? groups[0].split(":") : [];
  const right = groups.length === 2 && groups[1] ? groups[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (groups.length === 1 && missing !== 0) return null;
  if (groups.length === 2 && missing < 1) return null;
  const expanded = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map((part) => parseInt(part, 16).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < expanded.length;) {
    if (expanded[index] !== "0") { index += 1; continue; }
    const start = index;
    while (index < expanded.length && expanded[index] === "0") index += 1;
    if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
  }
  if (bestLength < 2) return expanded.join(":");
  return `${expanded.slice(0, bestStart).join(":")}::${expanded.slice(bestStart + bestLength).join(":")}`;
}

function normalizeIp(value) {
  let ip = String(value || "").trim().toLowerCase();
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIP(ip) === 0) return null;
  if (ip === "::1") return "127.0.0.1";
  return net.isIP(ip) === 4 ? ip : canonicalIpv6(ip);
}

module.exports = { normalizeIp };

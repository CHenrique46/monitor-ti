import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== "1.1.30") throw new Error("build-agent-only exige package version 1.1.30");

const buildId = String(process.env.BUILD_ID || "build-a").replace(/[^a-z0-9-]/gi, "-");
const candidateBase = path.join(root, "..", "candidate", "v1.1.30");
const candidateRoot = path.join(candidateBase, buildId);
const dist = path.join(candidateRoot, "dist");
const outputExe = path.join(candidateRoot, "MonitorTI-Agent.exe");
const seaWork = path.join(candidateBase, "_sea-work");
const seaConfig = path.join(seaWork, "sea-config.json");
fs.rmSync(candidateRoot, { recursive: true, force: true });
fs.rmSync(seaWork, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(seaWork, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "index.js")],
  bundle: true,
  platform: "node",
  target: "node24",
  outfile: path.join(dist, "agent.bundle.js")
});

const bundleText = fs.readFileSync(path.join(dist, "agent.bundle.js"), "utf8");
for (const marker of ["createRegistry64Adapter", "browser_notification_policy_v1", "function createConnectionLifecycle"]) {
  if (!bundleText.includes(marker)) throw new Error(`Bundle invalido: marcador ausente: ${marker}`);
}

fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(seaWork, "agent.bundle.js"),
  output: path.join(seaWork, "sea-prep.blob"),
  disableExperimentalSEAWarning: true
}, null, 2));
fs.copyFileSync(path.join(dist, "agent.bundle.js"), path.join(seaWork, "agent.bundle.js"));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { cwd: root, stdio: "inherit" });
fs.copyFileSync(path.join(seaWork, "sea-prep.blob"), path.join(dist, "sea-prep.blob"));
fs.copyFileSync(process.execPath, outputExe);

const postjectCli = path.join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [
  postjectCli, outputExe, "NODE_SEA_BLOB", path.join(dist, "sea-prep.blob"),
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
], { cwd: root, stdio: "inherit" });

const bytes = fs.readFileSync(outputExe);
const agentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const packageManifest = {
  schemaVersion: 1,
  version: pkg.version,
  packageMode: "agent-only",
  files: [{
    name: "MonitorTI-Agent.exe",
    size: bytes.length,
    sha256: agentSha256
  }],
  notifierAction: "preserve",
  configAction: "preserve",
  serviceAction: "restart"
};
fs.writeFileSync(path.join(candidateRoot, "package-manifest.json"), JSON.stringify(packageManifest, null, 2) + "\n");
const zipPath = path.join(candidateRoot, `MonitorTI-Agent-${pkg.version}-agent-only.zip`);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const zipEntries = ["MonitorTI-Agent.exe", "package-manifest.json"].map((name) => ({
  name,
  data: fs.readFileSync(path.join(candidateRoot, name))
}));
const localRecords = [];
const centralRecords = [];
let localOffset = 0;
const dosTime = 0;
const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
for (const entry of zipEntries) {
  const name = Buffer.from(entry.name, "utf8");
  const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
  const crc = crc32(entry.data);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
  localRecords.push(local, compressed);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0x80000000, 38); central.writeUInt32LE(localOffset, 42); name.copy(central, 46);
  centralRecords.push(central);
  localOffset += local.length + compressed.length;
}
const centralBytes = Buffer.concat(centralRecords);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(zipEntries.length, 8); end.writeUInt16LE(zipEntries.length, 10);
end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(localOffset, 16);
fs.writeFileSync(zipPath, Buffer.concat([...localRecords, centralBytes, end]));
const zipBytes = fs.readFileSync(zipPath);
const release = {
  version: pkg.version,
  packageMode: "agent-only",
  packageName: path.basename(zipPath),
  packageSha256: crypto.createHash("sha256").update(zipBytes).digest("hex"),
  packageSize: zipBytes.length,
  manifest: packageManifest
};
fs.writeFileSync(path.join(candidateRoot, "release.json"), JSON.stringify(release, null, 2) + "\n");
console.log(`BUILD_ID=${buildId}`);
console.log(`AGENT_PATH=${outputExe}`);
console.log(`AGENT_SHA256=${agentSha256}`);
console.log(`ZIP_PATH=${zipPath}`);
console.log(`ZIP_SHA256=${release.packageSha256}`);

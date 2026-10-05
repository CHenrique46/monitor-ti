const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const MINIMUM_FILE_AGE_DAYS = 7;
const MAX_DEPTH = 32;
const MAX_ITEMS = 100000;
const GLOBAL_TIMEOUT_MS = 90000;
const SKIPPED_PROFILE_NAMES = new Set([
  "default",
  "default user",
  "public",
  "all users",
  "defaultuser0",
  "wsiaccount"
]);

function sameIdentity(expected, actual) {
  return Number.isFinite(Number(expected.dev)) && Number.isFinite(Number(expected.ino))
    && Number(expected.dev) > 0 && Number(expected.ino) > 0
    && Number(expected.dev) === Number(actual.dev) && Number(expected.ino) === Number(actual.ino);
}

function markCleanupWarning(result, warning) {
  result.status = "PARTIAL";
  if (!result.warnings.includes(warning) && result.warnings.length < 20) result.warnings.push(warning);
}

async function revalidateDeletionTarget(fsPromises, target, expectedInfo, expectedComponents, result, context, now, minimumAgeDays) {
  if (!Array.isArray(expectedComponents) || expectedComponents.length === 0) return null;
  for (const component of expectedComponents) {
    let current;
    try {
      current = await fsPromises.lstat(component.path);
    } catch (error) {
      current = { error };
    }
    if (current.error || !sameIdentity(component.info, current)) {
      markCleanupWarning(result, "file_changed_before_delete");
      context.cleanupStopped = true;
      return null;
    }
    if (component.path === target && (!current.isFile() || current.isSymbolicLink() || !sameIdentity(expectedInfo, current))) {
      markCleanupWarning(result, "file_changed_before_delete");
      context.cleanupStopped = true;
      return null;
    }
    if (component.path !== target && (!current.isDirectory() || current.isSymbolicLink())) {
      markCleanupWarning(result, "reparse_point_changed_before_delete");
      context.cleanupStopped = true;
      return null;
    }
  }
  let latest;
  try {
    latest = await fsPromises.lstat(target);
  } catch (error) {
    latest = { error };
  }
  if (latest.error || latest.mtimeMs > now() - minimumAgeDays * 24 * 60 * 60 * 1000) {
    markCleanupWarning(result, "file_not_old_enough_before_delete");
    context.cleanupStopped = true;
    return null;
  }
  return latest;
}

function createDiskCleanupAnalyzer(deps = {}) {
  const fsPromises = deps.fsPromises || fs.promises;
  const now = deps.now || (() => Date.now());
  const systemDrive = deps.systemDrive || process.env.SystemDrive || "C:";
  const windowsDir = deps.windowsDir || process.env.WINDIR || "C:\\Windows";
  const usersDir = deps.usersDir || path.join(systemDrive, "Users");
  const maxDepth = deps.maxDepth ?? MAX_DEPTH;
  const maxItems = deps.maxItems ?? MAX_ITEMS;
  const timeoutMs = deps.timeoutMs ?? GLOBAL_TIMEOUT_MS;
  const minimumAgeDays = deps.minimumFileAgeDays ?? MINIMUM_FILE_AGE_DAYS;
  const registryDiscovery = deps.registryDiscovery ?? process.platform === "win32";
  const environment = deps.environment || process.env;
  const systemRoot = /^[A-Za-z]:[\\/]$/.test(systemDrive) ? systemDrive : path.parse(systemDrive).root;
  const onEligibleFile = deps.onEligibleFile;
  const includeRecycleBin = deps.includeRecycleBin ?? true;

  function category(id) {
    return {
      id,
      scannedBytes: 0,
      eligibleBytes: 0,
      filesScanned: 0,
      eligibleFiles: 0,
      skippedItems: 0,
      skippedRecent: 0,
      skippedLocked: 0,
      deletedBytes: 0,
      failedBytes: 0,
      failedItems: 0,
      timedOutItems: 0,
      status: "OK",
      truncated: false,
      warnings: []
    };
  }

  function normalizePath(value, profileRoot = "") {
    let candidate = String(value || "").trim();
    if (!candidate) return null;
    candidate = candidate.replace(/%([^%]+)%/g, (_, name) => {
      if (name.toUpperCase() === "USERPROFILE" && profileRoot) return profileRoot;
      return environment[name] || environment[name.toUpperCase()] || `%${name}%`;
    });
    if (!path.isAbsolute(candidate) || candidate.startsWith("\\\\") || candidate.startsWith("//")) return null;
    const normalized = path.normalize(candidate);
    const root = path.parse(normalized).root;
    if (!root || normalized.toLowerCase() === root.toLowerCase()) return null;
    const lower = normalized.toLowerCase();
    const dangerous = [
      path.normalize(path.join(systemRoot, "Windows")).toLowerCase(),
      path.normalize(path.join(systemRoot, "Users")).toLowerCase(),
      path.normalize(path.join(systemRoot, "Program Files")).toLowerCase(),
      path.normalize(path.join(systemRoot, "Program Files (x86)")).toLowerCase()
    ];
    if (dangerous.some((rootPath) => lower === rootPath || lower.startsWith(rootPath + path.sep))) return null;
    return normalized;
  }

  function uniquePaths(paths) {
    const seen = new Set();
    return paths.filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function runRegistry(args) {
    return new Promise((resolve) => {
      execFile("reg.exe", args, { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve(error ? "" : String(stdout || ""));
      });
    });
  }

  function parseRegistryValues(output) {
    const values = {};
    for (const line of String(output || "").split(/\r?\n/)) {
      const match = line.match(/^\s+(TEMP|TMP)\s+REG_\w+\s+(.+?)\s*$/i);
      if (match) values[match[1].toUpperCase()] = match[2];
    }
    return values;
  }

  function parseRegistryValue(output, name) {
    const match = String(output || "").split(/\r?\n/).map((line) => line.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "i"))).find(Boolean);
    return match ? match[1] : "";
  }

  function parseProfileList(output) {
    return String(output || "").split(/\r?\n/)
      .map((line) => line.match(/^HKEY_LOCAL_MACHINE\\.*\\([^\\\s]+)\s*$/i))
      .filter(Boolean)
      .map((match) => match[1]);
  }

  async function configuredTempPaths() {
    const sources = [
      { values: environment, profileRoot: "" },
      { values: deps.machineEnvironment || {}, profileRoot: "" }
    ];
    if (registryDiscovery) {
      const machine = deps.machineEnvironment ? deps.machineEnvironment : parseRegistryValues(await runRegistry(["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]));
      sources[1] = { values: machine, profileRoot: "" };
      const profilesOutput = await runRegistry(["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList"]);
      for (const sid of parseProfileList(profilesOutput)) {
        const profileRoot = parseRegistryValue(await runRegistry(["query", `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`]), "ProfileImagePath");
        const profileName = path.basename(profileRoot);
        const userKey = deps.userEnvironmentKeys?.[profileName];
        const values = userKey || parseRegistryValues(await runRegistry(["query", `HKU\\${sid}\\Environment`]));
        sources.push({ values, profileRoot });
      }
    }
    for (const user of deps.userEnvironments || []) sources.push(user);
    return uniquePaths(sources.flatMap(({ values, profileRoot }) => [values.TEMP, values.TMP].map((item) => normalizePath(item, profileRoot)).filter(Boolean)));
  }

  function addWarning(result, warning) {
    if (!result.warnings.includes(warning) && result.warnings.length < 20) result.warnings.push(warning);
  }

  function markWarning(result, warning) {
    result.status = "PARTIAL";
    addWarning(result, warning);
  }

  function createContext() {
    return { startedAt: now(), items: 0, truncated: false };
  }

  function expired(context) {
    return now() - context.startedAt >= timeoutMs;
  }

  function canInspect(context, result) {
    if (context.truncated) return false;
    if (context.cleanupStopped) {
      context.truncated = true;
      result.truncated = true;
      markWarning(result, "cleanup_timeout");
      return false;
    }
    if (expired(context)) {
      context.truncated = true;
      result.truncated = true;
      markWarning(result, "timeout");
      return false;
    }
    if (context.items >= maxItems) {
      context.truncated = true;
      result.truncated = true;
      markWarning(result, "max_items_reached");
      return false;
    }
    context.items += 1;
    return true;
  }

  async function statEntry(target) {
    try {
      return await fsPromises.lstat(target);
    } catch (error) {
      return { error };
    }
  }

  async function capturePathComponents(target, targetInfo) {
    const volumeRoot = path.parse(target).root;
    const relative = path.relative(volumeRoot, target);
    const components = [];
    let current = volumeRoot;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const isTarget = path.normalize(current).toLowerCase() === path.normalize(target).toLowerCase();
      const info = isTarget ? targetInfo : await statEntry(current);
      if (info.error || info.isSymbolicLink()) return null;
      components.push({ path: current, info });
    }
    return components;
  }

  async function walkFiles(root, result, context, options = {}) {
    const rootInfo = await statEntry(root);
    if (rootInfo.error) {
      if (rootInfo.error.code !== "ENOENT") {
        result.skippedItems += 1;
        markWarning(result, rootInfo.error.code === "EACCES" || rootInfo.error.code === "EPERM" ? "access_denied" : "directory_unavailable");
      }
      return;
    }
    if (rootInfo.isSymbolicLink()) {
      result.skippedItems += 1;
      markWarning(result, "reparse_point_skipped");
      return;
    }
    const rootComponents = await capturePathComponents(root, rootInfo);

    if (rootInfo.isFile()) {
      if (!canInspect(context, result)) return;
      const size = Number(rootInfo.size) || 0;
      result.scannedBytes += size;
      result.filesScanned += 1;
      if (!options.includeFile || options.includeFile(root, null, rootInfo)) {
        if (options.ignoreAge || rootInfo.mtimeMs <= now() - minimumAgeDays * 24 * 60 * 60 * 1000) {
          result.eligibleBytes += size;
          result.eligibleFiles += 1;
          if (onEligibleFile && options.allowCleanup !== false) {
            const outcome = await onEligibleFile(root, rootInfo, result, context, rootComponents);
            result.deletedBytes += Number(outcome && outcome.deletedBytes) || 0;
            result.failedBytes += Number(outcome && outcome.failedBytes) || 0;
            result.failedItems += Number(outcome && outcome.failedItems) || 0;
            result.timedOutItems += Number(outcome && outcome.timedOutItems) || 0;
            result.skippedLocked += Number(outcome && outcome.skippedLocked) || 0;
          }
        } else {
          result.skippedRecent += 1;
        }
      }
      return;
    }

    const visit = async (directory, depth, components) => {
      if (!canInspect(context, result) || depth > maxDepth) {
        if (depth > maxDepth) {
          result.skippedItems += 1;
          markWarning(result, "max_depth_reached");
        }
        return;
      }

      let entries;
      try {
        entries = await fsPromises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        result.skippedItems += 1;
        markWarning(result, error && (error.code === "EACCES" || error.code === "EPERM") ? "access_denied" : "directory_unavailable");
        return;
      }

      for (const entry of entries) {
        if (!canInspect(context, result)) return;
        const target = path.join(directory, entry.name);
        const info = await statEntry(target);
        if (info.error) {
          result.skippedItems += 1;
          markWarning(result, info.error.code === "ENOENT" ? "item_disappeared" : "metadata_unavailable");
          continue;
        }
        if (info.isSymbolicLink()) {
          result.skippedItems += 1;
          markWarning(result, "reparse_point_skipped");
          continue;
        }
        if (info.isDirectory()) {
          await visit(target, depth + 1, components.concat({ path: target, info }));
          if (context.truncated) return;
          continue;
        }
        if (!info.isFile()) {
          result.skippedItems += 1;
          continue;
        }
        const size = Number(info.size) || 0;
        result.scannedBytes += size;
        result.filesScanned += 1;
        if (!options.includeFile || options.includeFile(target, entry, info)) {
          if (options.ignoreAge || info.mtimeMs <= now() - minimumAgeDays * 24 * 60 * 60 * 1000) {
            result.eligibleBytes += size;
            result.eligibleFiles += 1;
            if (onEligibleFile && options.allowCleanup !== false) {
              const outcome = await onEligibleFile(target, info, result, context, components.concat({ path: target, info }));
              result.deletedBytes += Number(outcome && outcome.deletedBytes) || 0;
              result.failedBytes += Number(outcome && outcome.failedBytes) || 0;
              result.failedItems += Number(outcome && outcome.failedItems) || 0;
              result.timedOutItems += Number(outcome && outcome.timedOutItems) || 0;
              result.skippedLocked += Number(outcome && outcome.skippedLocked) || 0;
            }
          } else {
            result.skippedRecent += 1;
          }
        }
      }
    };

    try {
      await visit(root, 0, rootComponents || []);
    } catch (error) {
      result.skippedItems += 1;
      markWarning(result, "enumeration_error");
    }
  }

  async function analyzeUserTemp(context) {
    const result = category("USER_TEMP");
    let profiles;
    try {
      profiles = await fsPromises.readdir(usersDir, { withFileTypes: true });
    } catch (error) {
      markWarning(result, "profiles_unavailable");
      result.skippedItems += 1;
      return result;
    }

    for (const profile of profiles) {
      if (context.truncated) break;
      if (!profile.isDirectory() || SKIPPED_PROFILE_NAMES.has(profile.name.toLowerCase()) || profile.name.toLowerCase().startsWith("defaultuser")) continue;
      const tempPath = path.join(usersDir, profile.name, "AppData", "Local", "Temp");
      const tempInfo = await statEntry(tempPath);
      if (tempInfo.error) {
        if (tempInfo.error.code !== "ENOENT") {
          result.skippedItems += 1;
          markWarning(result, "profile_temp_unavailable");
        }
        continue;
      }
      if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()) {
        result.skippedItems += 1;
        markWarning(result, "reparse_point_skipped");
        continue;
      }
      await walkFiles(tempPath, result, context);
    }
    return result;
  }

  async function analyzeOtherTemp(context, existingPaths) {
    const result = category("OTHER_TEMP");
    const discovered = [];
    for (const item of await configuredTempPaths()) {
      if (existingPaths.has(item.toLowerCase())) continue;
      const info = await statEntry(item);
      if (info.error) continue;
      if (info.isSymbolicLink()) {
        result.skippedItems += 1;
        markWarning(result, "reparse_point_skipped");
        continue;
      }
      if (!info.isDirectory()) continue;
      discovered.push(item);
    }
    result.additionalTempDirectoriesDetected = discovered.length;
    for (const tempPath of discovered) {
      if (context.truncated) break;
      await walkFiles(tempPath, result, context);
    }
    return result;
  }

  async function analyzeWindowsTemp(context) {
    const result = category("WINDOWS_TEMP");
    await walkFiles(path.join(windowsDir, "Temp"), result, context);
    return result;
  }

  async function analyzeRecycleBin(context) {
    const result = category("RECYCLE_BIN");
    const recycleRoot = path.join(systemDrive, "$Recycle.Bin");
    let containers;
    try {
      containers = await fsPromises.readdir(recycleRoot, { withFileTypes: true });
    } catch (error) {
      result.skippedItems += 1;
      markWarning(result, error && (error.code === "EACCES" || error.code === "EPERM") ? "access_denied" : "recycle_bin_unavailable");
      return result;
    }

    for (const container of containers) {
      if (context.truncated) break;
      if (!container.isDirectory() || container.isSymbolicLink()) continue;
      const containerPath = path.join(recycleRoot, container.name);
      let entries;
      try {
        entries = await fsPromises.readdir(containerPath, { withFileTypes: true });
      } catch (error) {
        result.skippedItems += 1;
        markWarning(result, "access_denied");
        continue;
      }
      for (const entry of entries) {
        if (!canInspect(context, result)) break;
        if (!entry.name.startsWith("$R")) continue;
        await walkFiles(path.join(containerPath, entry.name), result, context, { includeFile: () => true, ignoreAge: true, allowCleanup: false });
      }
    }
    return result;
  }

  async function freeBytes() {
    if (typeof fsPromises.statfs !== "function") return null;
    try {
      const stats = await fsPromises.statfs(systemDrive + path.sep);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      return null;
    }
  }

  return async function analyze() {
    const context = createContext();
    const categories = [];
    const freeBytesBefore = await freeBytes();
    const userTemp = await analyzeUserTemp(context);
    const existingPaths = new Set();
    for (const profile of await fsPromises.readdir(usersDir, { withFileTypes: true }).catch(() => [])) {
      if (!profile.isDirectory() || SKIPPED_PROFILE_NAMES.has(profile.name.toLowerCase()) || profile.name.toLowerCase().startsWith("defaultuser")) continue;
      existingPaths.add(path.normalize(path.join(usersDir, profile.name, "AppData", "Local", "Temp")).toLowerCase());
    }
    existingPaths.add(path.normalize(path.join(windowsDir, "Temp")).toLowerCase());
    categories.push(userTemp);
    categories.push(await analyzeWindowsTemp(context));
    categories.push(await analyzeOtherTemp(context, existingPaths));
    if (includeRecycleBin) categories.push(await analyzeRecycleBin(context));
    if (context.truncated) {
      categories.forEach((item) => {
        item.truncated = true;
        markWarning(item, "analysis_incomplete");
      });
    }
    const estimatedRecoverableBytes = categories.reduce((total, item) => total + item.eligibleBytes, 0);
    const warnings = [...new Set(categories.flatMap((item) => item.warnings))];
    return {
      analysisOnly: true,
      disk: systemDrive,
      freeBytesBefore,
      minimumFileAgeDays: minimumAgeDays,
      categories,
      additionalTempDirectoriesDetected: categories.find((item) => item.id === "OTHER_TEMP")?.additionalTempDirectoriesDetected || 0,
      estimatedRecoverableBytes,
      actualFreedBytes: null,
      durationMs: Math.max(0, now() - context.startedAt),
      truncated: context.truncated || categories.some((item) => item.truncated),
      warnings
    };
  };
}

function createSafeDiskCleanupExecutor(deps = {}) {
  const batchSize = deps.cleanupBatchSize ?? 50;
  const yieldMs = deps.cleanupYieldMs ?? 10;
  const fileTimeoutMs = deps.cleanupFileTimeoutMs ?? 5000;
  const fsPromises = deps.fsPromises || fs.promises;
  const secureRemoveFile = deps.secureRemoveFile;
  const secureRemovalAvailable = typeof secureRemoveFile === "function";
  let processed = 0;
  const sleep = () => new Promise((resolve) => setTimeout(resolve, yieldMs));
  const analyzer = createDiskCleanupAnalyzer({
    ...deps,
    includeRecycleBin: false,
    onEligibleFile: secureRemovalAvailable ? async (target, info, result, context, components) => {
      processed += 1;
      if (processed > 1 && processed % batchSize === 0) await sleep();
      const latest = await revalidateDeletionTarget(fsPromises, target, info, components, result, context, deps.now || (() => Date.now()), deps.minimumFileAgeDays ?? MINIMUM_FILE_AGE_DAYS);
      if (!latest) return { failedBytes: Number(info.size) || 0, failedItems: 1 };
      const startedAt = Date.now();
      try {
        await secureRemoveFile(target, latest, components);
        const timedOut = Date.now() - startedAt > fileTimeoutMs;
        if (timedOut) {
          context.cleanupStopped = true;
          result.truncated = true;
          markCleanupWarning(result, "cleanup_timeout");
        }
        return { deletedBytes: Number(latest.size) || 0, timedOutItems: timedOut ? 1 : 0 };
      } catch (error) {
        const locked = ["EACCES", "EBUSY", "EPERM", "ETIMEDOUT"].includes(error && error.code);
        if (Date.now() - startedAt > fileTimeoutMs || error && error.code === "ETIMEDOUT") {
          context.cleanupStopped = true;
          result.truncated = true;
          markCleanupWarning(result, "cleanup_timeout");
        }
        return {
          skippedLocked: locked ? 1 : 0,
          failedBytes: Number(info.size) || 0,
          failedItems: 1
        };
      }
    } : undefined
  });
  return async function executeSafeDiskCleanup() {
    const result = await analyzer();
    if (!secureRemovalAvailable) {
      return {
        ...result,
        analysisOnly: true,
        executionBlocked: true,
        executionBlockedReason: "SECURE_REMOVAL_UNAVAILABLE",
        actualFreedBytes: null,
        deletedBytes: null,
        failedBytes: null,
        failedItems: 0,
        timedOutItems: 0,
        skippedLocked: 0,
        roots: [],
        blocked: [],
        errors: [{ code: "SECURE_REMOVAL_UNAVAILABLE", message: "Limpeza destrutiva recusada: não há mecanismo seguro contra substituição concorrente." }],
        blockedCount: 0,
        errorsCount: 1
      };
    }
    const deletedBytes = result.categories.reduce((sum, item) => sum + (Number(item.deletedBytes) || 0), 0);
    const failedBytes = result.categories.reduce((sum, item) => sum + (Number(item.failedBytes) || 0), 0);
    const skippedLocked = result.categories.reduce((sum, item) => sum + (Number(item.skippedLocked) || 0), 0);
    return {
      ...result,
      analysisOnly: false,
      actualFreedBytes: deletedBytes,
      deletedBytes,
      failedBytes,
      failedItems: result.categories.reduce((sum, item) => sum + (Number(item.failedItems) || 0), 0),
      timedOutItems: result.categories.reduce((sum, item) => sum + (Number(item.timedOutItems) || 0), 0),
      skippedRecent: result.categories.reduce((sum, item) => sum + (Number(item.skippedRecent) || 0), 0),
      skippedLocked,
      roots: [],
      blocked: [],
      errors: [],
      blockedCount: skippedLocked,
      errorsCount: result.categories.reduce((sum, item) => sum + (Number(item.failedItems) || 0) - (Number(item.skippedLocked) || 0), 0)
    };
  };
}

module.exports = {
  MINIMUM_FILE_AGE_DAYS,
  MAX_DEPTH,
  MAX_ITEMS,
  GLOBAL_TIMEOUT_MS,
  createDiskCleanupAnalyzer,
  createSafeDiskCleanupExecutor
};

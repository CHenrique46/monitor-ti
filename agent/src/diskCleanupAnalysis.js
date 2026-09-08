const fs = require("fs");
const path = require("path");

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

  function category(id) {
    return {
      id,
      scannedBytes: 0,
      eligibleBytes: 0,
      filesScanned: 0,
      eligibleFiles: 0,
      skippedItems: 0,
      status: "OK",
      truncated: false,
      warnings: []
    };
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

    if (rootInfo.isFile()) {
      if (!canInspect(context, result)) return;
      const size = Number(rootInfo.size) || 0;
      result.scannedBytes += size;
      result.filesScanned += 1;
      if (!options.includeFile || options.includeFile(root, null, rootInfo)) {
        if (options.ignoreAge || rootInfo.mtimeMs <= now() - minimumAgeDays * 24 * 60 * 60 * 1000) {
          result.eligibleBytes += size;
          result.eligibleFiles += 1;
        }
      }
      return;
    }

    const visit = async (directory, depth) => {
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
          await visit(target, depth + 1);
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
          }
        }
      }
    };

    try {
      await visit(root, 0);
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
        await walkFiles(path.join(containerPath, entry.name), result, context, { includeFile: () => true, ignoreAge: true });
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
    categories.push(await analyzeUserTemp(context));
    categories.push(await analyzeWindowsTemp(context));
    categories.push(await analyzeRecycleBin(context));
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
      estimatedRecoverableBytes,
      actualFreedBytes: null,
      durationMs: Math.max(0, now() - context.startedAt),
      truncated: context.truncated || categories.some((item) => item.truncated),
      warnings
    };
  };
}

module.exports = {
  MINIMUM_FILE_AGE_DAYS,
  MAX_DEPTH,
  MAX_ITEMS,
  GLOBAL_TIMEOUT_MS,
  createDiskCleanupAnalyzer
};

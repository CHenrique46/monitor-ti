const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "MonitorTI-Notifier.cs"), "utf8");

assert.match(source, /wallpaper_apply/);
assert.match(source, /C:\\\\ProgramData|CommonApplicationData/);
assert.match(source, /SystemParametersInfo/);
assert.match(source, /DesktopWallpaperSetter/);
assert.match(source, /SPI_SETDESKWALLPAPER/);
assert.match(source, /FileMode\.CreateNew/);
assert.doesNotMatch(source, /F5D2B5A264D60A9FC3FA8D130C0D9412411C98F753C10F2D0F441A4326CFE69E/);
assert.doesNotMatch(source, /91F24BC54648E6C48CD16ECFF43951133105B15621CF4B3B9A2A494415D5ABA5/);
assert.match(source, /expectedSize/);
assert.match(source, /WALLPAPER_HASH_MISMATCH/);
assert.match(source, /WALLPAPER_SIZE_MISMATCH/);
assert.match(source, /errorCode/);
console.log("notifier wallpaper contract: ok");

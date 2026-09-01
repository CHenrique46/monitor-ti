const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "MonitorTI-Notifier.cs"), "utf8");

assert.match(source, /wallpaper_apply/);
assert.match(source, /C:\\\\ProgramData|CommonApplicationData/);
assert.match(source, /SystemParametersInfo/);
assert.match(source, /DesktopWallpaperSetter/);
assert.match(source, /SPI_SETDESKWALLPAPER/);
assert.match(source, /FileMode\.CreateNew/);
console.log("notifier wallpaper contract: ok");

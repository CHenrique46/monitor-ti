using System;
using System.IO;
using System.Security.Cryptography;

namespace MonitorTI
{
    public static class WallpaperValidationHarness
    {
        private static void Expect(string name, Action action, string code)
        {
            try
            {
                action();
                throw new Exception(name + " accepted");
            }
            catch (WallpaperValidationException ex)
            {
                if (ex.Code != code) throw new Exception(name + " code=" + ex.Code);
            }
        }

        private static string Sha(byte[] body)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(body)).Replace("-", "");
        }

        public static void Main()
        {
            string root = Path.Combine(Path.GetTempPath(), "mti-wallpaper-validation-harness");
            Directory.CreateDirectory(root);
            try
            {
                byte[] jpeg = new byte[32];
                jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff; jpeg[30] = 0xff; jpeg[31] = 0xd9;
                string path = Path.Combine(root, "WallPaperVava.jpg");
                File.WriteAllBytes(path, jpeg);
                string sha = Sha(jpeg);

                if (WallpaperValidation.ValidateFile(path, sha, jpeg.Length) != sha) throw new Exception("valid metadata failed");
                Expect("wrong hash", () => WallpaperValidation.ValidateFile(path, new string('A', 64), jpeg.Length), "WALLPAPER_HASH_MISMATCH");
                Expect("wrong size", () => WallpaperValidation.ValidateFile(path, sha, jpeg.Length + 1), "WALLPAPER_SIZE_MISMATCH");
                Expect("missing hash", () => WallpaperValidation.ValidateFile(path, null, jpeg.Length), "WALLPAPER_INVALID_METADATA");
                Expect("invalid hash", () => WallpaperValidation.ValidateFile(path, "bad", jpeg.Length), "WALLPAPER_INVALID_METADATA");
                Expect("missing size", () => WallpaperValidation.ValidateFile(path, sha, null), "WALLPAPER_INVALID_METADATA");
                Expect("zero size", () => WallpaperValidation.ValidateFile(path, sha, 0), "WALLPAPER_INVALID_METADATA");
                Expect("invalid jpeg", () => WallpaperValidation.ValidateFile(Path.Combine(root, "invalid.jpg"), Sha(new byte[] { 1, 2, 3, 4 }), 4), "WALLPAPER_FILE_NOT_FOUND");
                File.WriteAllBytes(Path.Combine(root, "invalid.jpg"), new byte[] { 1, 2, 3, 4 });
                Expect("invalid jpeg", () => WallpaperValidation.ValidateFile(Path.Combine(root, "invalid.jpg"), Sha(new byte[] { 1, 2, 3, 4 }), 4), "WALLPAPER_INVALID_JPEG");
                Expect("missing file", () => WallpaperValidation.ValidateFile(Path.Combine(root, "missing.jpg"), sha, jpeg.Length), "WALLPAPER_FILE_NOT_FOUND");

                byte[] other = new byte[33];
                other[0] = 0xff; other[1] = 0xd8; other[2] = 0xff; other[31] = 0xff; other[32] = 0xd9;
                string otherPath = Path.Combine(root, "other.jpg");
                File.WriteAllBytes(otherPath, other);
                string otherSha = Sha(other);
                if (WallpaperValidation.ValidateFile(otherPath, otherSha, other.Length) != otherSha) throw new Exception("dynamic replacement failed");

                string current = "C:\\DskBackground\\WallPaperVava.jpg";
                if (File.Exists(current))
                {
                    string currentSha = Sha(File.ReadAllBytes(current));
                    if (WallpaperValidation.ValidateFile(current, currentSha, new FileInfo(current).Length) != currentSha) throw new Exception("current asset failed");
                    Expect("old hash against current", () => WallpaperValidation.ValidateFile(current, "F5D2B5A264D60A9FC3FA8D130C0D9412411C98F753C10F2D0F441A4326CFE69E", new FileInfo(current).Length), "WALLPAPER_HASH_MISMATCH");
                    Console.WriteLine("CURRENT_ASSET_ACCEPTED sha=" + currentSha + " size=" + new FileInfo(current).Length);
                }
                Console.WriteLine("NOTIFIER_WALLPAPER_VALIDATION_HARNESS_OK");
            }
            finally
            {
                try { Directory.Delete(root, true); } catch { }
            }
        }
    }
}

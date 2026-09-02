using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Drawing;
using System.Windows.Forms;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace MonitorTI
{
    public sealed class WallpaperValidationException : InvalidOperationException
    {
        public string Code { get; private set; }

        public WallpaperValidationException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    public static class WallpaperValidation
    {
        public const long MAX_SIZE = 10 * 1024 * 1024;

        public static string NormalizeSha256(string expectedSha256)
        {
            string normalized = (expectedSha256 ?? "").Trim().ToUpperInvariant();
            if (normalized.Length != 64) throw new WallpaperValidationException("WALLPAPER_INVALID_METADATA", "SHA256 esperado inválido.");
            for (int i = 0; i < normalized.Length; i++)
            {
                char c = normalized[i];
                if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) throw new WallpaperValidationException("WALLPAPER_INVALID_METADATA", "SHA256 esperado inválido.");
            }
            return normalized;
        }

        public static string ValidateFile(string candidate, string expectedSha256, long? expectedSize)
        {
            string normalizedSha256 = NormalizeSha256(expectedSha256);
            if (!expectedSize.HasValue || expectedSize.Value <= 0 || expectedSize.Value > MAX_SIZE) throw new WallpaperValidationException("WALLPAPER_INVALID_METADATA", "Tamanho esperado inválido.");
            if (string.IsNullOrEmpty(candidate) || !File.Exists(candidate)) throw new WallpaperValidationException("WALLPAPER_FILE_NOT_FOUND", "Arquivo de wallpaper não encontrado.");
            FileInfo info = new FileInfo(candidate);
            if (info.Length != expectedSize.Value) throw new WallpaperValidationException("WALLPAPER_SIZE_MISMATCH", "Tamanho do wallpaper divergente.");
            byte[] body = File.ReadAllBytes(candidate);
            if (!IsJpeg(body)) throw new WallpaperValidationException("WALLPAPER_INVALID_JPEG", "Formato JPEG inválido.");
            string hash;
            using (var stream = File.OpenRead(candidate)) using (var sha = System.Security.Cryptography.SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
            if (!string.Equals(hash, normalizedSha256, StringComparison.OrdinalIgnoreCase)) throw new WallpaperValidationException("WALLPAPER_HASH_MISMATCH", "Hash do wallpaper divergente.");
            return normalizedSha256;
        }

        private static bool IsJpeg(byte[] body)
        {
            return body != null && body.Length >= 4 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff && body[body.Length - 2] == 0xff && body[body.Length - 1] == 0xd9;
        }
    }

    public class NoticePayload
    {
        public string noticeDeliveryId;
        public string title;
        public string message;
        public string level;
        public string scheduledAt;
        public string serverTime;
    }

    public class Program
    {
        private const int PROTOCOL_VERSION = 1;
        private const string PIPE_PREFIX = "MonitorTI-Notice-";
        private const int MAX_PAYLOAD_BYTES = 64 * 1024;

        private static string _pipeName;
        private static string _payloadFile;
        private static bool _autoAck;
        private static bool _promoted;
        private static bool _companionMode;
        private static NamedPipeClientStream _pipe;
        private static StreamWriter _pipeWriter;
        private static Task _connectTask;
        private static volatile bool _connected;
        private static volatile string _activeNoticeDeliveryId;

        private const string COMPANION_PIPE_NAME = "MonitorTI-Notifier";
        private const int COMPANION_HEARTBEAT_MS = 15000;
        private const int COMPANION_RECONNECT_MS = 2000;
        private const string COMPANION_VERSION = "1.1.18-dev";
        private const uint SPI_SETDESKWALLPAPER = 20;
        private const uint SPIF_UPDATEINIFILE = 0x01;
        private const uint SPIF_SENDCHANGE = 0x02;

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SystemParametersInfo(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
        internal static Func<string, bool> DesktopWallpaperSetter = path => SystemParametersInfo(SPI_SETDESKWALLPAPER, 0, path, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);

        private static string CompanionPipeName
        {
            get
            {
                try
                {
                    var raw = Environment.GetEnvironmentVariable("MTI_COMPANION_PIPE_NAME");
                    if (!string.IsNullOrWhiteSpace(raw)) return raw.Trim();
                }
                catch { }
                return COMPANION_PIPE_NAME;
            }
        }

        private static int CompanionHeartbeatMs
        {
            get
            {
                try
                {
                    var raw = Environment.GetEnvironmentVariable("MTI_COMPANION_HEARTBEAT_MS");
                    int value;
                    if (!string.IsNullOrWhiteSpace(raw) && int.TryParse(raw, out value) && value > 0)
                    {
                        return value;
                    }
                }
                catch { }
                return COMPANION_HEARTBEAT_MS;
            }
        }

        private static string ContextTag()
        {
            try
            {
                var p = Process.GetCurrentProcess();
                return "[pid=" + p.Id + " session=" + p.SessionId + "]";
            }
            catch
            {
                return "[pid=? session=?]";
            }
        }

        private static string LogPath
        {
            get
            {
                string baseDir = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                return Path.Combine(baseDir, "MonitorTI", "logs", "notifier.log");
            }
        }

        private static void Log(string message)
        {
            try
            {
                string line = "[" + DateTime.UtcNow.ToString("o") + "] " + ContextTag() + " " + message;
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                File.AppendAllText(LogPath, line + Environment.NewLine, Encoding.UTF8);
                if (string.Equals(Environment.GetEnvironmentVariable("MTI_PROMO_TRACE"), "1", StringComparison.OrdinalIgnoreCase))
                {
                    string tracePath = Path.Combine(Path.GetTempPath(), "MonitorTI-promo-trace.log");
                    File.AppendAllText(tracePath, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }

        private static int CurrentSessionId()
        {
            try { return Process.GetCurrentProcess().SessionId; }
            catch { return -1; }
        }

        [STAThread]
        public static void Main(string[] args)
        {
            try
            {
                if (HasArg(args, "--companion"))
                {
                    RunCompanionMode(args);
                    return;
                }

                Application.ThreadException += (s, e) => Log("ThreadException: " + e.Exception.GetType().FullName + ": " + e.Exception.Message + "\n" + e.Exception.StackTrace);
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    var ex = e.ExceptionObject as Exception;
                    if (ex != null) Log("UnhandledException: " + ex.GetType().FullName + ": " + ex.Message + "\n" + ex.StackTrace);
                    else Log("UnhandledException: " + e.ExceptionObject);
                };

                Log("processo iniciado; sessionId=" + CurrentSessionId());
                Log("args=" + string.Join(" | ", args));
                Log("executable=" + Application.ExecutablePath);
                Log("currentDirectory=" + Environment.CurrentDirectory);
                if (!ParseArgs(args) || !ValidatePipeName(_pipeName))
                {
                    Fail("Argumentos ou pipe invalidos.");
                    return;
                }
                Log("argumentos validados; pipe=" + _pipeName + "; payload=" + _payloadFile + "; promoted=" + _promoted);

                // Se estivermos em sessao 0 (servico/LocalSystem) ou como SYSTEM,
                // promovemos o processo para a sessao interativa do usuario via WTS.
                if (ShouldPromote())
                {
                    Log("Session 0 detectada; promovendo para sessao interativa");
                    if (TryPromoteToUserSession(args))
                    {
                        Environment.Exit(0); // processo promovido ja foi lancado
                    }
                    // Sem sessao interativa ativa ou falha: nao exibir (manter PENDENTE).
                    Environment.Exit(0);
                }

                NoticePayload payload = ReadPayload();
                if (payload == null || string.IsNullOrEmpty(payload.message))
                {
                    Fail("Conteudo do aviso invalido.");
                    return;
                }
                Log("payload carregado; noticeDeliveryId=" + payload.noticeDeliveryId + "; title=" + payload.title);

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using (var form = new NoticeForm(payload))
                {
                    form.Load += (s, e) => Log("Form.Load");
                    form.Shown += (s, e) =>
                    {
                        Log("Form.Shown");
                        _connectTask = Task.Run(() => ConnectAndSend("received"));
                        if (_autoAck)
                        {
                            var t = new System.Windows.Forms.Timer();
                            t.Interval = 800;
                            t.Tick += (ts, te) => { t.Stop(); form.TriggerAck(); };
                            t.Start();
                        }
                    };
                    form.Acked += () =>
                    {
                        Log("ENTENDI clicado");
                        Task.Run(() => SendAckThenExit());
                    };
                    Log("processo interativo iniciado; executando Application.Run");
                    Application.Run(form);
                }
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "MonitorTI-Notifier-error.log"), ex.ToString()); } catch { }
                Environment.Exit(1);
            }
        }

        private static void RunCompanionMode(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Log("companion mode iniciado; pipe=" + CompanionPipeName + "; sessionId=" + CurrentSessionId());
            Application.Run(new CompanionHostForm(args));
        }

        private static string JsonEscape(string value)
        {
            if (value == null) return "";
            var sb = new StringBuilder();
            foreach (char c in value)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (char.IsControl(c)) sb.Append("\\u" + ((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        private static string BuildJsonLine(params string[] pairs)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            for (int i = 0; i < pairs.Length; i += 2)
            {
                if (i > 0) sb.Append(",");
                sb.Append('"').Append(JsonEscape(pairs[i])).Append('"').Append(":").Append(pairs[i + 1]);
            }
            sb.Append("}");
            return sb.ToString();
        }

        private static string JsonStringLiteral(string value)
        {
            return '"' + JsonEscape(value ?? "") + '"';
        }

        private static NoticePayload ParseNoticePayloadFromJson(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var p = new NoticePayload();
            p.noticeDeliveryId = GetJsonString(json, "noticeDeliveryId");
            p.title = GetJsonString(json, "title");
            p.message = GetJsonString(json, "message");
            p.level = GetJsonString(json, "level");
            p.scheduledAt = GetJsonString(json, "scheduledAt");
            p.serverTime = GetJsonString(json, "serverTime");
            return p;
        }

        private static string GetPipeMessageType(string json)
        {
            return GetJsonString(json, "type");
        }

        private static bool CanCloseFromUi()
        {
            return string.Equals(Environment.GetEnvironmentVariable("MTI_COMPANION_ALLOW_CLOSE"), "1", StringComparison.OrdinalIgnoreCase);
        }

        private static void SendAckThenExit()
        {
            try
            {
                if (_connectTask != null) _connectTask.Wait(10000);
                if (_connected && _pipeWriter != null)
                {
                    _pipeWriter.WriteLine("acknowledged");
                    _pipeWriter.Flush();
                    Log("acknowledged enviado");
                }
            }
            catch { }
            finally
            {
                CleanupPipe();
                Environment.Exit(0);
            }
        }

        private static void ConnectAndSend(string message)
        {
            try
            {
                _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
                bool connected = _pipe.ConnectAsync(10000).Wait(11000);
                if (!connected) return;
                _pipeWriter = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
                _connected = true;
                _pipeWriter.WriteLine(message);
                _pipeWriter.Flush();
                if (string.Equals(message, "received", StringComparison.OrdinalIgnoreCase))
                {
                    Log("received enviado");
                }
            }
            catch
            {
                _connected = false;
                Log("erro de pipe ao enviar " + message);
            }
        }

        private static void CleanupPipe()
        {
            try { if (_pipeWriter != null) _pipeWriter.Dispose(); } catch { }
            try { if (_pipe != null) _pipe.Dispose(); } catch { }
        }

        private static NoticePayload ReadPayload()
        {
            if (string.IsNullOrEmpty(_payloadFile) || !File.Exists(_payloadFile)) return null;
            Log("lendo payload: " + _payloadFile);
            byte[] bytes = File.ReadAllBytes(_payloadFile);
            if (bytes.Length > MAX_PAYLOAD_BYTES) return null;
            string json = Encoding.UTF8.GetString(bytes);
            NoticePayload p = new NoticePayload();
            p.noticeDeliveryId = GetJsonString(json, "noticeDeliveryId");
            p.title = GetJsonString(json, "title");
            p.message = GetJsonString(json, "message");
            p.level = GetJsonString(json, "level");
            p.scheduledAt = GetJsonString(json, "scheduledAt");
            p.serverTime = GetJsonString(json, "serverTime");
            try { File.Delete(_payloadFile); } catch { }
            return p;
        }

        private static string GetJsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string needle = "\"" + key + "\"";
            int idx = json.IndexOf(needle, StringComparison.Ordinal);
            while (idx >= 0)
            {
                int after = idx + needle.Length;
                while (after < json.Length && (json[after] == ' ' || json[after] == ':' || json[after] == '\t' || json[after] == '\n' || json[after] == '\r')) after++;
                if (after < json.Length && json[after] == '"')
                {
                    int start = after + 1;
                    var sb = new StringBuilder();
                    int i = start;
                    while (i < json.Length)
                    {
                        char c = json[i];
                        if (c == '\\')
                        {
                            if (i + 1 < json.Length)
                            {
                                char n = json[i + 1];
                                if (n == '"') sb.Append('"');
                                else if (n == '\\') sb.Append('\\');
                                else if (n == '/') sb.Append('/');
                                else if (n == 'n') sb.Append('\n');
                                else if (n == 't') sb.Append('\t');
                                else if (n == 'r') sb.Append('\r');
                                else sb.Append(n);
                                i += 2;
                                continue;
                            }
                        }
                        else if (c == '"')
                        {
                            return sb.ToString();
                        }
                        sb.Append(c);
                        i++;
                    }
                    return sb.ToString();
                }
                idx = json.IndexOf(needle, idx + 1, StringComparison.Ordinal);
            }
            return null;
        }

        private static long? GetJsonInt64(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string needle = "\"" + key + "\"";
            int idx = json.IndexOf(needle, StringComparison.Ordinal);
            while (idx >= 0)
            {
                int after = idx + needle.Length;
                while (after < json.Length && (json[after] == ' ' || json[after] == ':' || json[after] == '\t' || json[after] == '\n' || json[after] == '\r')) after++;
                int start = after;
                if (start < json.Length && (json[start] == '-' || (json[start] >= '0' && json[start] <= '9')))
                {
                    int end = start + 1;
                    while (end < json.Length && json[end] >= '0' && json[end] <= '9') end++;
                    long value;
                    if (long.TryParse(json.Substring(start, end - start), out value)) return value;
                    return null;
                }
                idx = json.IndexOf(needle, idx + 1, StringComparison.Ordinal);
            }
            return null;
        }

        private static bool ValidatePipeName(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            if (!name.StartsWith(PIPE_PREFIX, StringComparison.OrdinalIgnoreCase)) return false;
            string id = name.Substring(PIPE_PREFIX.Length);
            if (id.Length != 36) return false;
            foreach (char c in id)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == '-')) return false;
            }
            return true;
        }

        private static bool ParseArgs(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--pipe", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                    _pipeName = args[++i].Trim();
                else if (string.Equals(args[i], "--payload", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                    _payloadFile = args[++i].Trim();
                else if (string.Equals(args[i], "--auto-ack", StringComparison.OrdinalIgnoreCase))
                    _autoAck = true;
                else if (string.Equals(args[i], "--promoted", StringComparison.OrdinalIgnoreCase))
                    _promoted = true;
                else if (string.Equals(args[i], "--companion", StringComparison.OrdinalIgnoreCase))
                    _companionMode = true;
            }
            bool ok = !string.IsNullOrEmpty(_pipeName) && !string.IsNullOrEmpty(_payloadFile);
            if (ok && _pipeName.StartsWith("\\\\.\\pipe\\", StringComparison.OrdinalIgnoreCase))
                _pipeName = _pipeName.Substring("\\\\.\\pipe\\".Length);
            return ok;
        }

        private static bool HasArg(string[] args, string name)
        {
            if (args == null) return false;
            foreach (var a in args)
            {
                if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static bool IsSystem()
        {
            try
            {
                using (var id = WindowsIdentity.GetCurrent())
                {
                    return id.IsSystem;
                }
            }
            catch { return false; }
        }

        private static bool ShouldPromote()
        {
            if (_promoted) return false;
            int session = Process.GetCurrentProcess().SessionId;
            return session == 0 || IsSystem();
        }

        private static string EscapeArg(string a)
        {
            if (string.IsNullOrEmpty(a)) return "\"\"";
            if (a.IndexOf(' ') < 0 && a.IndexOf('"') < 0) return a;
            return "\"" + a.Replace("\"", "\"\"") + "\"";
        }

        private static bool TryLaunchPromotedProcessFromToken(IntPtr sourceToken, string sourceLabel, string[] args)
        {
            IntPtr hPrimary = IntPtr.Zero;
            IntPtr env = IntPtr.Zero;
            IntPtr hProcess = IntPtr.Zero;
            IntPtr hThread = IntPtr.Zero;
            DateTime started = DateTime.UtcNow;

            try
            {
                const uint TOKEN_ALL_ACCESS = 0xF01FF;
                const int SecurityImpersonation = 2;
                const int TokenPrimary = 1;

                Log(sourceLabel + ": DuplicateTokenEx inicio");
                if (!WTS.DuplicateTokenEx(sourceToken, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out hPrimary))
                {
                    LogLastError(sourceLabel + ": DuplicateTokenEx");
                    return false;
                }
                LogSuccess(sourceLabel + ": DuplicateTokenEx");

                Log(sourceLabel + ": CreateEnvironmentBlock inicio");
                if (!WTS.CreateEnvironmentBlock(out env, hPrimary, false))
                {
                    LogLastError(sourceLabel + ": CreateEnvironmentBlock");
                    env = IntPtr.Zero;
                }
                else
                {
                    LogSuccess(sourceLabel + ": CreateEnvironmentBlock");
                }

                string owner = null;
                try
                {
                    using (var id = new WindowsIdentity(hPrimary))
                    {
                        owner = id.Name;
                    }
                }
                catch (Exception ex)
                {
                    owner = "<indisponivel: " + ex.Message + ">";
                }
                Log(sourceLabel + ": owner=" + owner);

                WTS.STARTUPINFO si = new WTS.STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(WTS.STARTUPINFO));
                si.lpDesktop = "winsta0\\default";
                si.dwFlags = 0x00000100;
                si.wShowWindow = 1;
                WTS.PROCESS_INFORMATION pi;

                var argList = new System.Collections.Generic.List<string>(args);
                argList.Add("--promoted");
                string cmdLine = "\"" + Application.ExecutablePath + "\" " + string.Join(" ", argList.ConvertAll(EscapeArg));
                string currentDir = Path.GetDirectoryName(Application.ExecutablePath);

                Log(sourceLabel + ": desktop=winsta0\\default; CreationFlags=0x400");
                Log(sourceLabel + ": applicationName=<null>; commandLine=" + cmdLine);
                Log(sourceLabel + ": currentDirectory=" + currentDir);
                Log(sourceLabel + ": CreateProcessAsUser inicio");
                if (!WTS.CreateProcessAsUser(hPrimary, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0x00000400, env, currentDir, ref si, out pi))
                {
                    LogLastError(sourceLabel + ": CreateProcessAsUser");
                    return false;
                }

                hProcess = pi.hProcess;
                hThread = pi.hThread;
                LogSuccess(sourceLabel + ": CreateProcessAsUser");
                Log(sourceLabel + ": processo filho criado; pid=" + pi.dwProcessId);
                try
                {
                    var child = Process.GetProcessById(pi.dwProcessId);
                    Log(sourceLabel + ": child session=" + child.SessionId);
                    try { Log(sourceLabel + ": child exe=" + child.MainModule.FileName); } catch (Exception ex) { Log(sourceLabel + ": child exe indisponivel: " + ex.Message); }
                }
                catch (Exception ex)
                {
                    Log(sourceLabel + ": child process lookup falhou: " + ex.Message);
                }

                try
                {
                    uint wait = WTS.WaitForSingleObject(hProcess, 1500);
                    if (wait == 0)
                    {
                        uint exitCode;
                        if (WTS.GetExitCodeProcess(hProcess, out exitCode))
                        {
                            Log(sourceLabel + ": child terminou rapido; ExitCode=" + exitCode + "; lifetimeMs=" + (int)(DateTime.UtcNow - started).TotalMilliseconds);
                        }
                        else
                        {
                            LogLastError(sourceLabel + ": GetExitCodeProcess");
                        }
                    }
                    else if (wait == 258)
                    {
                        Log(sourceLabel + ": child ainda em execucao apos 1500ms");
                    }
                    else
                    {
                        Log(sourceLabel + ": WaitForSingleObject retorno=" + wait);
                    }
                }
                catch (Exception ex)
                {
                    Log(sourceLabel + ": observacao do filho falhou: " + ex.Message);
                }
                return true;
            }
            finally
            {
                try { if (env != IntPtr.Zero) WTS.DestroyEnvironmentBlock(env); } catch { }
                try { if (hProcess != IntPtr.Zero) WTS.CloseHandle(hProcess); } catch { }
                try { if (hThread != IntPtr.Zero) WTS.CloseHandle(hThread); } catch { }
                try { if (hPrimary != IntPtr.Zero) WTS.CloseHandle(hPrimary); } catch { }
            }
        }

        private static bool TryLaunchFromExplorerSession(int sessionId, string[] args)
        {
            try
            {
                var explorers = Process.GetProcessesByName("explorer");
                foreach (var p in explorers)
                {
                    try
                    {
                        if (p.SessionId != sessionId) continue;
                        Log("explorer encontrado na sessao " + sessionId + ": pid=" + p.Id);
                        IntPtr hProcess = WTS.OpenProcess(0x1000, false, p.Id);
                        if (hProcess == IntPtr.Zero)
                        {
                            LogLastError("OpenProcess(explorer pid=" + p.Id + ")");
                            continue;
                        }

                        try
                        {
                            IntPtr hToken = IntPtr.Zero;
                            uint access = 0x0001 | 0x0002 | 0x0008 | 0x0080 | 0x0100;
                            Log("OpenProcessToken inicio; access=0x" + access.ToString("X"));
                            if (!WTS.OpenProcessToken(hProcess, access, out hToken))
                            {
                                LogLastError("OpenProcessToken(explorer pid=" + p.Id + ")");
                                continue;
                            }
                            LogSuccess("OpenProcessToken(explorer pid=" + p.Id + ")");
                            Log("token do explorer obtido: 0x" + hToken.ToString("X"));

                            if (TryLaunchPromotedProcessFromToken(hToken, "explorer token", args))
                            {
                                WTS.CloseHandle(hToken);
                                return true;
                            }
                            WTS.CloseHandle(hToken);
                        }
                        finally
                        {
                            WTS.CloseHandle(hProcess);
                        }
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Log("explorer token fallback falhou: " + ex.Message);
            }
            return false;
        }

        private static void LogLastError(string api)
        {
            try
            {
                int code = Marshal.GetLastWin32Error();
                var ex = new System.ComponentModel.Win32Exception(code);
                Log(api + ": falha; GetLastWin32Error=" + code + " " + ex.Message);
            }
            catch { }
        }

        private static void LogSuccess(string api)
        {
            Log(api + ": sucesso");
        }

        private static bool TryPromoteToUserSession(string[] args)
        {
            IntPtr ptr = IntPtr.Zero;
            int count = 0;
            if (!WTS.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out ptr, out count))
            {
                LogLastError("WTSEnumerateSessions");
                return false;
            }
            LogSuccess("WTSEnumerateSessions");
            int activeId = -1;
            try
            {
                int size = Marshal.SizeOf(typeof(WTS.WTS_SESSION_INFO));
                long baseAddr = ptr.ToInt64();
                for (int i = 0; i < count; i++)
                {
                    var info = (WTS.WTS_SESSION_INFO)Marshal.PtrToStructure(new IntPtr(baseAddr + i * size), typeof(WTS.WTS_SESSION_INFO));
                    if (info.State == 0) { activeId = info.SessionId; break; }
                }
            }
            finally
            {
                WTS.WTSFreeMemory(ptr);
            }
            if (activeId < 0) return false; // nenhuma sessao interativa ativa

            Log("sessao interativa selecionada: " + activeId);

            // Caminho primario: token do explorer.exe da sessao interativa.
            if (TryLaunchFromExplorerSession(activeId, args))
            {
                return true;
            }
            Log("fallback explorer token nao conseguiu promover; tentando WTSQueryUserToken");

            IntPtr hToken = IntPtr.Zero;
            Log("WTSQueryUserToken(session=" + activeId + "): inicio");
            if (!WTS.WTSQueryUserToken(activeId, out hToken))
            {
                LogLastError("WTSQueryUserToken(session=" + activeId + ")");
                return false;
            }
            LogSuccess("WTSQueryUserToken(session=" + activeId + ")");
            Log("token obtido: 0x" + hToken.ToString("X"));

            bool created = TryLaunchPromotedProcessFromToken(hToken, "WTSQueryUserToken", args);
            try { if (hToken != IntPtr.Zero) WTS.CloseHandle(hToken); } catch { }
            return created;
        }

        private sealed class CompanionHostForm : Form
        {
            private readonly string[] _args;
            private CompanionController _controller;

            public CompanionHostForm(string[] args)
            {
                _args = args ?? new string[0];
                ShowInTaskbar = false;
                FormBorderStyle = FormBorderStyle.FixedToolWindow;
                WindowState = FormWindowState.Minimized;
                Opacity = 0;
                Load += (s, e) => Hide();
                Shown += (s, e) =>
                {
                    if (_controller == null)
                    {
                        _controller = new CompanionController(this, _args);
                        _controller.Start();
                    }
                };
                FormClosing += (s, e) =>
                {
                    try { if (_controller != null) _controller.Dispose(); } catch { }
                };
            }
        }

        private sealed class CompanionController : IDisposable
        {
            private readonly Control _ui;
            private readonly string[] _args;
            private readonly object _sendLock = new object();
            private readonly CancellationTokenSource _cts = new CancellationTokenSource();
            private readonly System.Threading.Timer _heartbeatTimer;
            private readonly int _heartbeatIntervalMs;
            private NamedPipeClientStream _pipe;
            private StreamReader _reader;
            private StreamWriter _writer;
            private Task _readerTask;
            private NoticeForm _currentForm;
            private volatile bool _registered;
            private volatile bool _ready;
            private volatile bool _disposed;

            public CompanionController(Control ui, string[] args)
            {
                _ui = ui;
                _args = args ?? new string[0];
                _heartbeatIntervalMs = CompanionHeartbeatMs;
                _heartbeatTimer = new System.Threading.Timer(
                    _ =>
                    {
                        if (_disposed || !_registered || !_ready) return;
                        SendHeartbeat();
                    },
                    null,
                    Timeout.Infinite,
                    Timeout.Infinite);
            }

            public void Start()
            {
                Task.Run(() => ConnectLoop());
            }

            private async Task ConnectLoop()
            {
                while (!_cts.IsCancellationRequested)
                {
                    bool shouldDelay = false;
                    try
                    {
                        ConnectOnce();
                        await ReadLoop();
                    }
                    catch (Exception ex)
                    {
                        LogException("companion reconnect", ex);
                    }
                    finally
                    {
                        CleanupPipe();
                        shouldDelay = !_cts.IsCancellationRequested;
                    }

                    if (shouldDelay)
                    {
                        await Task.Delay(COMPANION_RECONNECT_MS);
                    }
                }
            }

            private void LogException(string prefix, Exception ex)
            {
                if (ex == null)
                {
                    Log(prefix + " exception=null");
                    return;
                }

                Log(prefix + " exception type=" + ex.GetType().FullName + " message=" + ex.Message + " hresult=" + ex.HResult);

                var agg = ex as AggregateException;
                if (agg != null)
                {
                    int idx = 0;
                    foreach (var inner in agg.Flatten().InnerExceptions)
                    {
                        Log(prefix + " inner[" + idx + "] type=" + inner.GetType().FullName + " message=" + inner.Message + " hresult=" + inner.HResult);
                        idx++;
                    }
                }

                var innerEx = ex.InnerException;
                int innerIndex = 0;
                while (innerEx != null)
                {
                    Log(prefix + " cause[" + innerIndex + "] type=" + innerEx.GetType().FullName + " message=" + innerEx.Message + " hresult=" + innerEx.HResult);
                    innerEx = innerEx.InnerException;
                    innerIndex++;
                }
            }

            private void ConnectOnce()
            {
                _pipe = new NamedPipeClientStream(".", CompanionPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                Log("companion_connecting " + CompanionPipeName);
                if (!_pipe.ConnectAsync(10000).Wait(11000))
                    throw new TimeoutException("timeout ao conectar no pipe");

                _reader = new StreamReader(_pipe, Encoding.UTF8, false, 1024, true);
                _writer = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true };
                _registered = false;
                _ready = false;
                SendRegister();
                _readerTask = Task.Run(() => ReadLoopBody());
            }

            private async Task ReadLoop()
            {
                if (_readerTask != null)
                {
                    await _readerTask;
                }
            }

            private void ReadLoopBody()
            {
                while (!_cts.IsCancellationRequested)
                {
                    string line;
                    try
                    {
                        line = _reader.ReadLine();
                    }
                    catch
                    {
                        break;
                    }

                    if (line == null) break;
                    HandleLine(line);
                }
            }

            private void HandleLine(string line)
            {
                var type = GetPipeMessageType(line);
                if (string.IsNullOrEmpty(type)) return;

                if (string.Equals(type, "register_ok", StringComparison.OrdinalIgnoreCase))
                {
                    _registered = true;
                    _ready = true;
                    Log("register_ok recebido");
                    _heartbeatTimer.Change(_heartbeatIntervalMs, _heartbeatIntervalMs);
                    SendHeartbeat();
                    return;
                }

                if (string.Equals(type, "notice_show", StringComparison.OrdinalIgnoreCase))
                {
                    var payload = ParseNoticePayloadFromJson(line);
                    if (payload == null || string.IsNullOrEmpty(payload.noticeDeliveryId) || string.IsNullOrEmpty(payload.message))
                    {
                        Log("notice_show invalido no companion");
                        SendError("INVALID_PAYLOAD", "Conteudo do aviso invalido");
                        return;
                    }

                    if (_currentForm != null && !_currentForm.IsDisposed)
                    {
                        Log("notice_show rejeitado: já existe janela aberta");
                        SendError("INVALID_STATE", "Já existe janela aberta");
                        return;
                    }

                    if (_ui.IsDisposed)
                    {
                        SendError("INVALID_STATE", "UI indisponivel");
                        return;
                    }

                    _ui.BeginInvoke((Action)(() => ShowNoticeOnUi(payload)));
                    return;
                }

                if (string.Equals(type, "wallpaper_apply", StringComparison.OrdinalIgnoreCase))
                {
                    var actionId = GetJsonString(line, "actionExecutionId");
                    var wallpaperPath = GetJsonString(line, "path");
                    var expectedSha256 = GetJsonString(line, "expectedSha256");
                    var expectedSize = GetJsonInt64(line, "expectedSize");
                    var assetId = GetJsonString(line, "assetId");
                    var style = GetJsonString(line, "style");
                    if (_ui.IsDisposed)
                    {
                        SendWallpaperResult(actionId, false, "WALLPAPER_APPLY_FAILED", "UI indisponível.", null, null, null, null);
                        return;
                    }
                    _ui.BeginInvoke((Action)(() => ApplyWallpaper(actionId, wallpaperPath, expectedSha256, expectedSize, assetId, style)));
                    return;
                }

                if (string.Equals(type, "error", StringComparison.OrdinalIgnoreCase))
                {
                    Log("error do Agent: " + (GetJsonString(line, "code") ?? "unknown") + " " + (GetJsonString(line, "message") ?? ""));
                    return;
                }

                if (string.Equals(type, "shutdown", StringComparison.OrdinalIgnoreCase))
                {
                    Log("shutdown recebido: " + (GetJsonString(line, "reason") ?? "unknown"));
                    SendRaw(BuildJsonLine(
                        "type", JsonStringLiteral("shutdown_ack"),
                        "protocolVersion", PROTOCOL_VERSION.ToString(),
                        "reason", JsonStringLiteral(GetJsonString(line, "reason") ?? "update"),
                        "sessionId", Process.GetCurrentProcess().SessionId.ToString(),
                        "pid", Process.GetCurrentProcess().Id.ToString(),
                        "ts", JsonStringLiteral(DateTime.UtcNow.ToString("o"))
                    ));
                    Log("shutdown_ack enviado");
                    try
                    {
                        if (_currentForm != null && !_currentForm.IsDisposed)
                        {
                            _currentForm.BeginInvoke((Action)(() => _currentForm.Close()));
                        }
                    }
                    catch { }
                    try
                    {
                        _ui.BeginInvoke((Action)(() => ((Form)_ui).Close()));
                    }
                    catch { }
                    return;
                }
            }

            private void ShowNoticeOnUi(NoticePayload payload)
            {
                if (_currentForm != null && !_currentForm.IsDisposed)
                {
                    SendError("INVALID_STATE", "Já existe janela aberta");
                    return;
                }

                _currentForm = new NoticeForm(payload);
                _currentForm.BlockWindowClose = true;
                _currentForm.Shown += (s, e) =>
                {
                    Log("Form.Shown");
                    SendReceived(payload.noticeDeliveryId);
                };
                _currentForm.Acked += () =>
                {
                    Log("ENTENDI clicado");
                    SendAcknowledged(payload.noticeDeliveryId);
                };
                _currentForm.FormClosed += (s, e) =>
                {
                    if (string.Equals(_activeNoticeDeliveryId, payload.noticeDeliveryId, StringComparison.OrdinalIgnoreCase))
                    {
                        _activeNoticeDeliveryId = null;
                    }
                    _currentForm = null;
                    _ready = true;
                };

                _activeNoticeDeliveryId = payload.noticeDeliveryId;
                _currentForm.StartPosition = FormStartPosition.CenterScreen;
                _currentForm.TopMost = true;
                _currentForm.ShowInTaskbar = true;
                _currentForm.Show();
            }

            private void SendRegister()
            {
                var username = WindowsIdentity.GetCurrent().Name;
                var msg = BuildJsonLine(
                    "type", JsonStringLiteral("register"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "notifierVersion", JsonStringLiteral(COMPANION_VERSION),
                    "sessionId", Process.GetCurrentProcess().SessionId.ToString(),
                    "pid", Process.GetCurrentProcess().Id.ToString(),
                    "username", JsonStringLiteral(username),
                    "activeNoticeDeliveryId", _activeNoticeDeliveryId == null ? "null" : JsonStringLiteral(_activeNoticeDeliveryId)
                );
                SendRaw(msg);
                Log("register enviado");
            }

            private void SendHeartbeat()
            {
                if (_disposed) return;
                var msg = BuildJsonLine(
                    "type", JsonStringLiteral("heartbeat"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "sessionId", Process.GetCurrentProcess().SessionId.ToString(),
                    "pid", Process.GetCurrentProcess().Id.ToString(),
                    "ts", JsonStringLiteral(DateTime.UtcNow.ToString("o"))
                );
                SendRaw(msg);
                _ready = true;
                Log("heartbeat enviado");
            }

            private void SendReceived(string noticeDeliveryId)
            {
                var msg = BuildJsonLine(
                    "type", JsonStringLiteral("received"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "noticeDeliveryId", JsonStringLiteral(noticeDeliveryId),
                    "sessionId", Process.GetCurrentProcess().SessionId.ToString(),
                    "pid", Process.GetCurrentProcess().Id.ToString(),
                    "ts", JsonStringLiteral(DateTime.UtcNow.ToString("o"))
                );
                SendRaw(msg);
                Log("received enviado");
            }

            private void SendAcknowledged(string noticeDeliveryId)
            {
                var msg = BuildJsonLine(
                    "type", JsonStringLiteral("acknowledged"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "noticeDeliveryId", JsonStringLiteral(noticeDeliveryId),
                    "sessionId", Process.GetCurrentProcess().SessionId.ToString(),
                    "pid", Process.GetCurrentProcess().Id.ToString(),
                    "ts", JsonStringLiteral(DateTime.UtcNow.ToString("o"))
                );
                SendRaw(msg);
                Log("acknowledged enviado");
            }

            private void SendError(string code, string message)
            {
                var msg = BuildJsonLine(
                    "type", JsonStringLiteral("error"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "code", JsonStringLiteral(code),
                    "message", JsonStringLiteral(message)
                );
                SendRaw(msg);
            }

            private void SendWallpaperResult(string actionId, bool applied, string errorCode, string error, string username, string sid, string sha256, long? size)
            {
                SendRaw(BuildJsonLine(
                    "type", JsonStringLiteral("wallpaper_result"),
                    "protocolVersion", PROTOCOL_VERSION.ToString(),
                    "actionExecutionId", JsonStringLiteral(actionId),
                    "status", JsonStringLiteral(applied ? "SUCCESS" : "FAILED"),
                    "applied", applied ? "true" : "false",
                    "username", username == null ? "null" : JsonStringLiteral(username),
                    "sid", sid == null ? "null" : JsonStringLiteral(sid),
                    "wallpaperPath", applied ? JsonStringLiteral(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MonitorTI", "wallpaper", "WallPaperVava.jpg")) : "null",
                    "sha256", applied && sha256 != null ? JsonStringLiteral(sha256) : "null",
                    "size", applied && size.HasValue ? size.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) : "null",
                    "style", applied ? JsonStringLiteral("fill") : "null",
                    "errorCode", errorCode == null ? "null" : JsonStringLiteral(errorCode),
                    "error", error == null ? "null" : JsonStringLiteral(error)
                ));
            }

            private void ApplyWallpaper(string actionId, string wallpaperPath, string expectedSha256, long? expectedSize, string assetId, string style)
            {
                try
                {
                    string root = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MonitorTI", "wallpaper"));
                    string candidate = Path.GetFullPath(wallpaperPath ?? "");
                    if (!candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Caminho de wallpaper não permitido.");
                    if (!string.Equals(Path.GetExtension(candidate), ".jpg", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Extensão de wallpaper não permitida.");
                    if (!string.Equals(assetId, "official-wallpaper-v1", StringComparison.Ordinal)) throw new WallpaperValidationException("WALLPAPER_INVALID_METADATA", "Asset de wallpaper inválido.");
                    string normalizedSha256 = WallpaperValidation.ValidateFile(candidate, expectedSha256, expectedSize);
                    if (!string.Equals(style, "fill", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Estilo de wallpaper não permitido.");

                    string username = WindowsIdentity.GetCurrent().Name;
                    string sid = WindowsIdentity.GetCurrent().User != null ? WindowsIdentity.GetCurrent().User.Value : null;
                    using (var key = Registry.CurrentUser.CreateSubKey("Control Panel\\Desktop"))
                    {
                        string previousWallpaper = key.GetValue("Wallpaper", "") as string;
                        string previousStyle = key.GetValue("WallpaperStyle", "") as string;
                        string previousTile = key.GetValue("TileWallpaper", "") as string;
                        SaveRollbackMetadata(username, sid, normalizedSha256, previousWallpaper, previousStyle, previousTile);
                    }
                    using (var key = Registry.CurrentUser.CreateSubKey("Control Panel\\Desktop"))
                    {
                        key.SetValue("WallpaperStyle", "10", RegistryValueKind.String);
                        key.SetValue("TileWallpaper", "0", RegistryValueKind.String);
                    }
                    if (!DesktopWallpaperSetter(candidate)) throw new InvalidOperationException("SystemParametersInfo falhou.");
                    SendWallpaperResult(actionId, true, null, null, username, sid, normalizedSha256, expectedSize);
                }
                catch (WallpaperValidationException ex)
                {
                    SendWallpaperResult(actionId, false, ex.Code, ex.Message, null, null, null, null);
                }
                catch (Exception ex)
                {
                    SendWallpaperResult(actionId, false, "WALLPAPER_APPLY_FAILED", ex.Message, null, null, null, null);
                }
            }

            private static void SaveRollbackMetadata(string username, string sid, string appliedSha256, string previousWallpaper = null, string previousStyle = null, string previousTile = null)
            {
                if (string.IsNullOrEmpty(sid)) throw new InvalidOperationException("SID do usuário não encontrado.");
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MonitorTI", "wallpaper", "rollback");
                Directory.CreateDirectory(dir);
                string target = Path.Combine(dir, sid + ".json");
                if (File.Exists(target)) return;
                string json = BuildJsonLine(
                    "username", JsonStringLiteral(username), "sid", JsonStringLiteral(sid),
                    "previousWallpaper", previousWallpaper == null ? "null" : JsonStringLiteral(previousWallpaper),
                    "previousWallpaperStyle", previousStyle == null ? "null" : JsonStringLiteral(previousStyle),
                    "previousTileWallpaper", previousTile == null ? "null" : JsonStringLiteral(previousTile),
                    "timestamp", JsonStringLiteral(DateTime.UtcNow.ToString("o")),
                    "appliedAssetSha256", JsonStringLiteral(appliedSha256)
                );
                using (var stream = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(json);
            }

            private void SendRaw(string line)
            {
                try
                {
                    lock (_sendLock)
                    {
                        if (_writer == null) return;
                        _writer.WriteLine(line);
                        _writer.Flush();
                    }
                }
                catch (Exception ex)
                {
                    Log("companion pipe write falhou: " + ex.Message);
                }
            }

            private void CleanupPipe()
            {
                try { _heartbeatTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { }
                try { if (_reader != null) _reader.Dispose(); } catch { }
                try { if (_writer != null) _writer.Dispose(); } catch { }
                try { if (_pipe != null) _pipe.Dispose(); } catch { }
                _reader = null;
                _writer = null;
                _pipe = null;
                _registered = false;
                _ready = false;
            }

            public void Dispose()
            {
                if (_disposed) return;
                _disposed = true;
                try { _cts.Cancel(); } catch { }
                CleanupPipe();
                try { _cts.Dispose(); } catch { }
                try { _heartbeatTimer.Dispose(); } catch { }
            }
        }

        private static void Fail(string reason)
        {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "MonitorTI-Notifier-fail.log"), reason); } catch { }
            Environment.Exit(2);
        }
    }

    internal static class WTS
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct WTS_SESSION_INFO
        {
            public int SessionId;
            public IntPtr pWinStationName;
            public int State;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSEnumerateSessions(IntPtr hServer, int Reserved, int Version, out IntPtr ppSessionInfo, out int pCount);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern void WTSFreeMemory(IntPtr pMemory);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    }

    public class NoticeForm : Form
    {
        public event Action Acked;
        public bool BlockWindowClose { get; set; }
        private bool _allowClose;
        public void TriggerAck()
        {
            _allowClose = true;
            if (Acked != null) Acked();
        }
        private readonly NoticePayload _payload;
        private const int FORM_WIDTH = 520;
        private const int MAX_FORM_HEIGHT = 640;

        public NoticeForm(NoticePayload payload)
        {
            _payload = payload;
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MinimizeBox = false;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.TopMost = true;
            this.ShowInTaskbar = true;
            this.Text = "HenriTech Control";
            this.BackColor = Color.FromArgb(10, 22, 40);
            this.Padding = new Padding(16);
            this.FormClosing += (s, e) =>
            {
                if (BlockWindowClose && !_allowClose)
                {
                    e.Cancel = true;
                    return;
                }
            };

            int contentWidth = FORM_WIDTH - 32;

            var accent = new Panel
            {
                BackColor = Color.FromArgb(48, 205, 218),
                Location = new Point(16, 14),
                Size = new Size(4, 62)
            };

            var brandMark = new Panel
            {
                BackColor = Color.FromArgb(31, 91, 155),
                Location = new Point(32, 16),
                Size = new Size(32, 28)
            };
            var markLabel = new Label
            {
                Text = "HT",
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                ForeColor = Color.White,
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Fill
            };
            brandMark.Controls.Add(markLabel);

            var brandLabel = new Label
            {
                Text = "HENRITECH CONTROL",
                Font = new Font("Segoe UI", 8, FontStyle.Bold),
                ForeColor = Color.FromArgb(91, 174, 255),
                AutoSize = true,
                Location = new Point(76, 14)
            };
            var brandSubtitle = new Label
            {
                Text = "Monitoramento e Gerenciamento de TI",
                Font = new Font("Segoe UI", 8),
                ForeColor = Color.FromArgb(157, 174, 196),
                AutoSize = true,
                Location = new Point(76, 30)
            };

            Color levelColor = Color.FromArgb(84, 205, 231);
            string levelText = "INFORMATIVO";
            if (!string.IsNullOrEmpty(this._payload.level))
            {
                string l = this._payload.level.ToUpperInvariant();
                if (l.Contains("URGENT")) { levelColor = Color.FromArgb(255, 126, 126); levelText = "URGENTE"; }
                else if (l.Contains("IMPORT")) { levelColor = Color.FromArgb(255, 190, 112); levelText = "IMPORTANTE"; }
            }
            var levelLabel = new Label
            {
                Text = levelText,
                Font = new Font("Segoe UI", 7, FontStyle.Bold),
                ForeColor = levelColor,
                BackColor = Color.FromArgb(20, 45, 72),
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Size = new Size(108, 22),
                Location = new Point(32, 64)
            };

            var titleLabel = new Label
            {
                Text = Sanitize(this._payload.title),
                Font = new Font("Segoe UI", 14, FontStyle.Bold),
                ForeColor = Color.FromArgb(242, 247, 252),
                AutoSize = false,
                Width = contentWidth - 32,
                Location = new Point(32, levelLabel.Bottom + 10)
            };
            titleLabel.Height = Math.Max(24, MeasureTextHeight(titleLabel.Text, titleLabel.Font, titleLabel.Width) + 2);

            var messageLabel = new Label
            {
                Text = Sanitize(this._payload.message),
                AutoSize = false,
                BackColor = Color.FromArgb(20, 42, 68),
                ForeColor = Color.FromArgb(232, 240, 248),
                Font = new Font("Segoe UI", 10),
                Location = new Point(16, 14),
                Width = contentWidth - 32,
                TabStop = false
            };

            int messageTop = titleLabel.Bottom + 24;
            int reserved = messageTop + 74;
            int availForMsg = MAX_FORM_HEIGHT - reserved;
            int measuredMessageHeight = MeasureTextHeight(messageLabel.Text, messageLabel.Font, messageLabel.Width);
            int messageLabelHeight = Math.Max(30, measuredMessageHeight + 4);
            messageLabel.Height = Math.Min(messageLabelHeight, Math.Max(30, availForMsg));
            int messageHeight = Math.Max(54, Math.Min(messageLabel.Height + 24, Math.Max(54, availForMsg)));
            var messagePanel = new Panel
            {
                BackColor = Color.FromArgb(20, 42, 68),
                BorderStyle = BorderStyle.None,
                Location = new Point(16, messageTop),
                Size = new Size(contentWidth, messageHeight + 28),
                TabStop = false
            };
            messagePanel.Controls.Add(messageLabel);

            string dateText = FormatDate(this._payload.scheduledAt) ?? FormatDate(this._payload.serverTime) ?? "";
            var dateLabel = new Label
            {
                Text = string.IsNullOrEmpty(dateText) ? "" : dateText,
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.FromArgb(137, 159, 184),
                AutoSize = true,
                Location = new Point(22, messagePanel.Bottom + 8)
            };

            var button = new Button
            {
                Text = "ENTENDI",
                Width = 120,
                Height = 34,
                BackColor = Color.FromArgb(31, 105, 174),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                FlatAppearance =
                {
                    BorderSize = 1,
                    BorderColor = Color.FromArgb(75, 166, 231),
                    MouseOverBackColor = Color.FromArgb(43, 126, 198),
                    MouseDownBackColor = Color.FromArgb(24, 81, 137)
                },
                Font = new Font("Segoe UI", 9, FontStyle.Bold),
                TabIndex = 0
            };
            button.Click += (s, e) =>
            {
                button.Enabled = false;
                TriggerAck();
                this.DialogResult = DialogResult.OK;
                this.Close();
            };

            int formHeight = messagePanel.Bottom + 6 + 18 + 10 + button.Height + 14;
            if (formHeight > MAX_FORM_HEIGHT)
            {
                int overflow = formHeight - MAX_FORM_HEIGHT;
                messagePanel.Height = Math.Max(78, messagePanel.Height - overflow);
                formHeight = MAX_FORM_HEIGHT;
            }
            button.Location = new Point(FORM_WIDTH - 22 - button.Width, formHeight - 14 - button.Height);
            dateLabel.Location = new Point(22, button.Top + (button.Height - dateLabel.Height) / 2);

            this.ClientSize = new Size(FORM_WIDTH, formHeight);
            this.Controls.Add(accent);
            this.Controls.Add(brandMark);
            this.Controls.Add(brandLabel);
            this.Controls.Add(brandSubtitle);
            this.Controls.Add(titleLabel);
            this.Controls.Add(levelLabel);
            this.Controls.Add(messagePanel);
            this.Controls.Add(dateLabel);
            this.Controls.Add(button);
            this.ActiveControl = button;
        }

        private int MeasureTextHeight(string text, Font font, int maxWidth)
        {
            if (string.IsNullOrEmpty(text)) return 20;
            using (var bmp = new Bitmap(1, 1))
            using (var g = Graphics.FromImage(bmp))
            {
                Size proposed = TextRenderer.MeasureText(g, text, font, new Size(maxWidth, int.MaxValue), TextFormatFlags.WordBreak);
                return proposed.Height;
            }
        }

        private static string FormatDate(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return null;
            DateTime dt;
            if (DateTime.TryParse(iso, out dt))
                return dt.ToString("dd/MM/yyyy HH:mm");
            return null;
        }

        private static string Sanitize(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\0", "").Trim();
        }
    }
}

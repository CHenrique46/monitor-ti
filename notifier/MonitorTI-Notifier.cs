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

namespace MonitorTI
{
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
        private const string PIPE_PREFIX = "MonitorTI-Notice-";
        private const int MAX_PAYLOAD_BYTES = 64 * 1024;

        private static string _pipeName;
        private static string _payloadFile;
        private static bool _autoAck;
        private static bool _promoted;
        private static NamedPipeClientStream _pipe;
        private static StreamWriter _pipeWriter;
        private static Task _connectTask;
        private static volatile bool _connected;

        [STAThread]
        public static void Main(string[] args)
        {
            try
            {
                if (!ParseArgs(args) || !ValidatePipeName(_pipeName))
                {
                    Fail("Argumentos ou pipe invalidos.");
                    return;
                }

                // Se estivermos em sessao 0 (servico/LocalSystem) ou como SYSTEM,
                // promovemos o processo para a sessao interativa do usuario via WTS.
                if (ShouldPromote())
                {
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

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using (var form = new NoticeForm(payload))
                {
                    form.Shown += (s, e) =>
                    {
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
                        Task.Run(() => SendAckThenExit());
                    };
                    Application.Run(form);
                }
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "MonitorTI-Notifier-error.log"), ex.ToString()); } catch { }
                Environment.Exit(1);
            }
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
            }
            catch
            {
                _connected = false;
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
            }
            bool ok = !string.IsNullOrEmpty(_pipeName) && !string.IsNullOrEmpty(_payloadFile);
            if (ok && _pipeName.StartsWith("\\\\.\\pipe\\", StringComparison.OrdinalIgnoreCase))
                _pipeName = _pipeName.Substring("\\\\.\\pipe\\".Length);
            return ok;
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

        private static bool TryPromoteToUserSession(string[] args)
        {
            IntPtr ptr = IntPtr.Zero;
            int count = 0;
            if (!WTS.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out ptr, out count)) return false;
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

            IntPtr hToken = IntPtr.Zero;
            if (!WTS.WTSQueryUserToken(activeId, out hToken)) return false;

            IntPtr hPrimary = IntPtr.Zero;
            if (!WTS.DuplicateTokenEx(hToken, 0x200FFFFF, IntPtr.Zero, 2, 1, out hPrimary))
            {
                WTS.CloseHandle(hToken);
                return false;
            }

            IntPtr env = IntPtr.Zero;
            WTS.CreateEnvironmentBlock(out env, hPrimary, false);

            WTS.STARTUPINFO si = new WTS.STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(WTS.STARTUPINFO));
            si.lpDesktop = "winsta0\\default";
            si.dwFlags = 0x00000100;
            si.wShowWindow = 1;
            WTS.PROCESS_INFORMATION pi;

            var argList = new System.Collections.Generic.List<string>(args);
            argList.Add("--promoted");
            string cmdLine = "\"" + Application.ExecutablePath + "\" " + string.Join(" ", argList.ConvertAll(EscapeArg));

            bool created = WTS.CreateProcessAsUser(hPrimary, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0x00000400, env, null, ref si, out pi);
            try { if (created) { WTS.CloseHandle(pi.hProcess); WTS.CloseHandle(pi.hThread); } }
            catch { }
            try { WTS.DestroyEnvironmentBlock(env); } catch { }
            try { WTS.CloseHandle(hPrimary); WTS.CloseHandle(hToken); } catch { }
            return created;
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

        [DllImport("wtsapi32.dll")]
        public static extern bool WTSEnumerateSessions(IntPtr hServer, int Reserved, int Version, out IntPtr ppSessionInfo, out int pCount);

        [DllImport("wtsapi32.dll")]
        public static extern void WTSFreeMemory(IntPtr pMemory);

        [DllImport("wtsapi32.dll")]
        public static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll")]
        public static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);

        [DllImport("userenv.dll")]
        public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll")]
        public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    }

    public class NoticeForm : Form
    {
        public event Action Acked;
        public void TriggerAck() { if (Acked != null) Acked(); }
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
            this.Text = Sanitize(this._payload.title);
            this.BackColor = SystemColors.Control;
            this.Padding = new Padding(16);

            int contentWidth = FORM_WIDTH - 32;

            var titleLabel = new Label
            {
                Text = Sanitize(this._payload.title),
                Font = new Font("Segoe UI", 12, FontStyle.Bold),
                ForeColor = Color.FromArgb(20, 20, 20),
                AutoSize = true,
                MaximumSize = new Size(contentWidth, 0),
                Location = new Point(16, 16)
            };

            Color levelColor = Color.FromArgb(0, 90, 160);
            string levelText = "INFORMATIVO";
            if (!string.IsNullOrEmpty(this._payload.level))
            {
                string l = this._payload.level.ToUpperInvariant();
                if (l.Contains("URGENT")) { levelColor = Color.FromArgb(192, 0, 0); levelText = "URGENTE"; }
                else if (l.Contains("IMPORT")) { levelColor = Color.FromArgb(197, 90, 0); levelText = "IMPORTANTE"; }
            }
            var levelLabel = new Label
            {
                Text = "NIVEL: " + levelText,
                Font = new Font("Segoe UI", 10, FontStyle.Bold),
                ForeColor = levelColor,
                AutoSize = true,
                Location = new Point(16, titleLabel.Bottom + 8)
            };

            var messageBox = new TextBox
            {
                Text = Sanitize(this._payload.message),
                ReadOnly = true,
                Multiline = true,
                WordWrap = true,
                BorderStyle = BorderStyle.None,
                BackColor = SystemColors.Control,
                Font = new Font("Segoe UI", 10),
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(16, levelLabel.Bottom + 8),
                Width = contentWidth
            };

            int msgHeight = MeasureTextHeight(Sanitize(this._payload.message), messageBox.Font, contentWidth - 4);
            int reserved = 16 + titleLabel.Height + 8 + levelLabel.Height + 8 + 8 + 36 + 56;
            int availForMsg = MAX_FORM_HEIGHT - reserved;
            messageBox.Height = Math.Max(40, Math.Min(msgHeight + 8, Math.Max(40, availForMsg)));

            string dateText = FormatDate(this._payload.scheduledAt) ?? FormatDate(this._payload.serverTime) ?? "";
            var dateLabel = new Label
            {
                Text = string.IsNullOrEmpty(dateText) ? "" : "Agendado para: " + dateText,
                Font = new Font("Segoe UI", 9),
                ForeColor = Color.Gray,
                AutoSize = true,
                Location = new Point(16, messageBox.Bottom + 8)
            };

            var button = new Button
            {
                Text = "ENTENDI",
                Width = 120,
                Height = 36,
                BackColor = Color.FromArgb(0, 90, 160),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Standard,
                Font = new Font("Segoe UI", 10, FontStyle.Bold)
            };
            button.Click += (s, e) =>
            {
                button.Enabled = false;
                TriggerAck();
                this.DialogResult = DialogResult.OK;
                this.Close();
            };

            int formHeight = messageBox.Bottom + 8 + 20 + 16 + button.Height + 16;
            if (formHeight > MAX_FORM_HEIGHT)
            {
                int overflow = formHeight - MAX_FORM_HEIGHT;
                messageBox.Height = Math.Max(40, messageBox.Height - overflow);
                formHeight = MAX_FORM_HEIGHT;
            }
            button.Location = new Point(FORM_WIDTH - 16 - button.Width, formHeight - 16 - button.Height);
            dateLabel.Location = new Point(16, button.Top + (button.Height - dateLabel.Height) / 2);

            this.ClientSize = new Size(FORM_WIDTH, formHeight);
            this.Controls.Add(titleLabel);
            this.Controls.Add(levelLabel);
            this.Controls.Add(messageBox);
            this.Controls.Add(dateLabel);
            this.Controls.Add(button);
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

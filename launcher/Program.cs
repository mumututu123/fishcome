using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Diagnostics;
using System.Security.Cryptography;

namespace Tide {
  sealed class Client {
    public string Id, Nick, Actor; public int Peers, Generation; public volatile bool Active; public DateTime Updated;
    public object[] Hints = new object[0];
    public readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
  }
  sealed class Request {
    public string Method, Path, Query, Origin, Host; public byte[] Body; public IPAddress Remote;
  }
  sealed class UpdateRecord {
    public string Phase = "idle", Id = "", SourceKind = "", SourceLabel = "", SourceInput = "", TargetVersion = "", TargetRulesVersion = "", StagingDir = "", Error = "";
    public long DownloadedBytes, TotalBytes = -1;
    public bool Prerelease;
    public CancellationTokenSource Cts;
  }
  static class Program {
    const long MaxPackageBytes = 64L * 1024L * 1024L;
    const long MaxExtractedBytes = 128L * 1024L * 1024L;
    const int MaxZipEntries = 1024;
    const int MaxStatusBytes = 256 * 1024;
    static int Port = 39241, HandoffParentPid = 0; static bool Loopback, Headless, NoOpen, PrintVersion;
    static string Root, BaseDir, Www, Token, Published, JoinUrl = "", HandoffTarget = "", HandoffNonce = "";
    static string[] Urls; static TcpListener Listener;
    static volatile bool Running = true, Updating = false, HandoffReady = true, HandoffFailed = false;
    static readonly ConcurrentDictionary<string, Client> Clients = new ConcurrentDictionary<string, Client>();
    static readonly object UpdateLock = new object();
    static readonly object ListenerLock = new object();
    static UpdateRecord UpdateState = new UpdateRecord();
    static NotifyIcon TrayIcon;
    static readonly object RulesObject = new JavaScriptSerializer().DeserializeObject(BuildInfo.RulesJson);
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 32 }; }
    static string Encode(object o) { return Json().Serialize(o); }
    static IDictionary<string, object> Parse(byte[] bytes) { return Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); }
    static string Str(IDictionary<string, object> d, string k) { return d != null && d.ContainsKey(k) ? Convert.ToString(d[k]) : ""; }
    static int Int(IDictionary<string, object> d, string k) { int n; return int.TryParse(Str(d, k), out n) ? n : 0; }
    static void ConfigureTls() {
      try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)3072; }
      catch { try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch { } }
    }
    static string RandomToken() {
      byte[] secret = new byte[32];
      using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(secret);
      return Convert.ToBase64String(secret).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
    static Mutex AcquireInstallMutex(string dir) {
      using (var sha = SHA256.Create()) {
        string key = "Local\\fishcome-install-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(dir.ToLowerInvariant()))).Replace("-", "").Substring(0, 24);
        var m = new Mutex(false, key);
        try {
          if (m.WaitOne(0)) return m;
        } catch (AbandonedMutexException) { return m; }
        m.Dispose();
        return null;
      }
    }
    [STAThread] static void Main(string[] args) {
      ConfigureTls();
      for (int i = 0; i < args.Length; i++) {
        if (args[i] == "--port" && i + 1 < args.Length) Port = int.Parse(args[++i]);
        else if (args[i] == "--loopback") Loopback = true;
        else if (args[i] == "--headless") Headless = true;
        else if (args[i] == "--no-open") NoOpen = true;
        else if (args[i] == "--print-version") PrintVersion = true;
        else if (args[i] == "--handoff-target" && i + 1 < args.Length) HandoffTarget = Path.GetFullPath(args[++i]);
        else if (args[i] == "--handoff-parent" && i + 1 < args.Length) HandoffParentPid = int.Parse(args[++i]);
        else if (args[i] == "--handoff-nonce" && i + 1 < args.Length) HandoffNonce = args[++i];
      }
      if (PrintVersion) {
        Console.WriteLine(Encode(new { version = BuildInfo.Version, rulesVersion = BuildInfo.RulesVersion }));
        return;
      }
      BaseDir = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
      bool isHandoff = !string.IsNullOrEmpty(HandoffTarget);
      Root = isHandoff ? HandoffTarget.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : BaseDir;
      Www = Path.Combine(BaseDir, "www");
      if (isHandoff) HandoffReady = false;
      LoadJoinConfig(Root, true);
      Token = RandomToken();
      var addresses = new List<string>();
      if (!Loopback) foreach (var nic in NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel)) {
        var props = nic.GetIPProperties(); if (!props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any))) continue;
        foreach (var ip in props.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)) addresses.Add("http://" + ip.Address + ":" + Port);
      }
      if (addresses.Count == 0 && !Loopback) foreach (var ip in Dns.GetHostAddresses(Dns.GetHostName()).Where(p => p.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(p))) addresses.Add("http://" + ip + ":" + Port);
      if (addresses.Count == 0) addresses.Add("http://127.0.0.1:" + Port);
      Urls = addresses.Distinct().ToArray(); Published = Urls[0];
      if (!StartListenerWithRetry(isHandoff ? 8000 : 0)) {
        if (!Headless) { MessageBox.Show("固定端口 " + Port + " 已被占用。如果鱼来已经启动，可直接打开本地网页。", "鱼来"); Open(); }
        Environment.Exit(2);
        return;
      }
      if (isHandoff) { var _ = Task.Run(() => CompleteHandoffInstall(BaseDir, Root, HandoffParentPid)); }
      else {
        var cleanLock = AcquireInstallMutex(Root);
        if (cleanLock != null) {
          try {
            RecoverPendingTransaction(Root);
            CleanupStaleUpdateDirs(Root, BaseDir);
            LoadJoinConfig(Root, false);
          } finally {
            try { cleanLock.ReleaseMutex(); } catch { }
            cleanLock.Dispose();
          }
        }
      }
      if (Headless) { while (Running) Thread.Sleep(100); return; }
      Application.EnableVisualStyles();
      using (var bitmap = new Bitmap(32, 32)) using (var graphics = Graphics.FromImage(bitmap)) {
        graphics.Clear(Color.FromArgb(11, 51, 86)); using (var font = new Font("Consolas", 16, FontStyle.Bold)) graphics.DrawString("o>", font, Brushes.Aquamarine, -1, 2);
        using (var tray = new NotifyIcon { Icon = Icon.FromHandle(bitmap.GetHicon()), Text = "鱼来 · 鱼元水世界", Visible = true }) {
          TrayIcon = tray;
          var menu = new ContextMenuStrip(); menu.Items.Add("打开鱼来", null, delegate { Open(); });
          menu.Items.Add("复制我的邀请码", null, delegate { Clipboard.SetText(PublishedInvite()); });
          menu.Items.Add("退出启动器", null, delegate {
            lock (ListenerLock) {
              if (Updating) return;
              Running = false;
              StopCurrentListenerLocked();
            }
            Application.Exit();
          });
          tray.ContextMenuStrip = menu; tray.DoubleClick += delegate { Open(); }; if (!NoOpen) Open(); Application.Run(); tray.Visible = false; TrayIcon = null;
        }
      }
    }
    static void LoadJoinConfig(string dir, bool readOnly) {
      try {
        string config = Path.Combine(dir, "join.json");
        if (File.Exists(config)) {
          var join = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(config, Encoding.UTF8));
          string value = Str(join, "invite"); if (value == "") value = Str(join, "url");
          JoinUrl = NormalizeInvite(value);
          if (!readOnly && JoinUrl != "" && join.ContainsKey("url")) File.WriteAllText(config, Encode(new { invite = JoinUrl }), new UTF8Encoding(false));
        }
      } catch { }
    }
    static bool StartListenerWithRetry(int retryMs) {
      var deadline = DateTime.UtcNow.AddMilliseconds(retryMs);
      while (true) {
        lock (ListenerLock) {
          if (!Running) return false;
          try {
            var listener = new TcpListener(Loopback ? IPAddress.Loopback : IPAddress.Any, Port);
            listener.Start(128);
            Listener = listener;
            var _ = Task.Run(() => Accept(listener));
            return true;
          } catch { }
        }
        if (DateTime.UtcNow >= deadline) return false;
        Thread.Sleep(100);
      }
    }
    static void StopCurrentListenerLocked() {
      var listener = Listener;
      Listener = null;
      if (listener != null) { try { listener.Stop(); } catch { } }
    }
    static void CleanupStaleUpdateDirs(string rootDir, string runningDir) {
      try {
        if (!Directory.Exists(rootDir)) return;
        foreach (var dir in Directory.GetDirectories(rootDir)) {
          string name = Path.GetFileName(dir);
          if (!name.StartsWith(".update-", StringComparison.OrdinalIgnoreCase) &&
              !name.StartsWith(".rollback-", StringComparison.OrdinalIgnoreCase) &&
              !name.StartsWith(".stage-", StringComparison.OrdinalIgnoreCase)) continue;
          string full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
          if (string.Equals(full, runningDir, StringComparison.OrdinalIgnoreCase)) continue;
          try { Directory.Delete(full, true); } catch { }
        }
      } catch { }
    }
    static void RecoverPendingTransaction(string targetRoot) {
      try {
        string txFile = Path.Combine(targetRoot, ".tx-pending.json");
        if (!File.Exists(txFile)) return;
        var tx = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(txFile, Encoding.UTF8));
        string rollbackDir = Str(tx, "rollbackDir");
        if (!string.IsNullOrEmpty(rollbackDir) && Directory.Exists(rollbackDir)) {
          string dstExe = Path.Combine(targetRoot, "鱼来.exe");
          string dstWww = Path.Combine(targetRoot, "www");
          string backupExe = Path.Combine(rollbackDir, "鱼来.exe");
          string backupWww = Path.Combine(rollbackDir, "www");
          string backupLegacy = Path.Combine(rollbackDir, "潮生.exe");
          string dstLegacy = Path.Combine(targetRoot, "潮生.exe");
          if (File.Exists(backupExe) && !File.Exists(dstExe)) { try { File.Move(backupExe, dstExe); } catch { } }
          if (Directory.Exists(backupWww) && !Directory.Exists(dstWww)) { try { Directory.Move(backupWww, dstWww); } catch { } }
          if (File.Exists(backupLegacy) && !File.Exists(dstLegacy)) { try { File.Move(backupLegacy, dstLegacy); } catch { } }
        }
        try { File.Delete(txFile); } catch { }
      } catch { }
    }
    static void CompleteHandoffInstall(string stagingDir, string targetRoot, int parentPid) {
      Mutex installMutex = null;
      string txFile = Path.Combine(targetRoot, ".tx-pending.json");
      try {
        if (parentPid > 0) {
          try {
            var parent = Process.GetProcessById(parentPid);
            if (!parent.WaitForExit(10000)) { HandoffFailed = true; return; }
          } catch { }
        }
        Thread.Sleep(200);
        for (int wait = 0; wait < 20 && installMutex == null; wait++) {
          installMutex = AcquireInstallMutex(targetRoot);
          if (installMutex == null) Thread.Sleep(150);
        }
        if (installMutex == null) { HandoffFailed = true; return; }
        string srcExe = Path.Combine(stagingDir, "鱼来.exe");
        string srcWww = Path.Combine(stagingDir, "www");
        if (!File.Exists(srcExe) || !Directory.Exists(srcWww)) { HandoffFailed = true; return; }
        string txId = Guid.NewGuid().ToString("N");
        string dstExe = Path.Combine(targetRoot, "鱼来.exe");
        string dstLegacy = Path.Combine(targetRoot, "潮生.exe");
        string dstWww = Path.Combine(targetRoot, "www");
        string stageWww = Path.Combine(targetRoot, ".stage-" + txId);
        string stageExe = Path.Combine(targetRoot, ".stage-exe-" + txId);
        string stageLegacy = Path.Combine(targetRoot, ".stage-legacy-" + txId);
        string rollbackDir = Path.Combine(targetRoot, ".rollback-" + txId);
        string backupExe = Path.Combine(rollbackDir, "鱼来.exe");
        string backupLegacy = Path.Combine(rollbackDir, "潮生.exe");
        string backupWww = Path.Combine(rollbackDir, "www");
        bool hasLegacy = File.Exists(dstLegacy);
        bool createdStageExe = false, createdStageLegacy = false, createdStageWww = false, movedOldExe = false, movedOldLegacy = false, movedOldWww = false, placedNewExe = false, placedNewLegacy = false, placedNewWww = false;
        try {
          File.Copy(srcExe, stageExe, true); createdStageExe = true;
          if (hasLegacy) { File.Copy(srcExe, stageLegacy, true); createdStageLegacy = true; }
          CopyDirectory(srcWww, stageWww); createdStageWww = true;
          Directory.CreateDirectory(rollbackDir);
          File.WriteAllText(txFile, Encode(new { rollbackDir }), new UTF8Encoding(false));
          if (File.Exists(dstExe)) { MoveFileWithRetry(dstExe, backupExe); movedOldExe = true; }
          if (hasLegacy && File.Exists(dstLegacy)) { MoveFileWithRetry(dstLegacy, backupLegacy); movedOldLegacy = true; }
          if (Directory.Exists(dstWww)) { MoveDirectoryWithRetry(dstWww, backupWww); movedOldWww = true; }
          MoveFileWithRetry(stageExe, dstExe); createdStageExe = false; placedNewExe = true;
          if (hasLegacy) { MoveFileWithRetry(stageLegacy, dstLegacy); createdStageLegacy = false; placedNewLegacy = true; }
          MoveDirectoryWithRetry(stageWww, dstWww); createdStageWww = false; placedNewWww = true;
          Www = dstWww;
          Root = targetRoot;
          HandoffReady = true;
          try { File.Delete(txFile); } catch { }
          try { Directory.Delete(rollbackDir, true); } catch { }
        } catch {
          if (placedNewWww) { try { Directory.Delete(dstWww, true); } catch { } }
          if (placedNewLegacy) { try { File.Delete(dstLegacy); } catch { } }
          if (placedNewExe) { try { File.Delete(dstExe); } catch { } }
          if (movedOldWww && Directory.Exists(backupWww) && !Directory.Exists(dstWww)) { try { Directory.Move(backupWww, dstWww); } catch { } }
          if (movedOldLegacy && File.Exists(backupLegacy) && !File.Exists(dstLegacy)) { try { File.Move(backupLegacy, dstLegacy); } catch { } }
          if (movedOldExe && File.Exists(backupExe) && !File.Exists(dstExe)) { try { File.Move(backupExe, dstExe); } catch { } }
          if (createdStageWww) { try { Directory.Delete(stageWww, true); } catch { } }
          if (createdStageLegacy) { try { File.Delete(stageLegacy); } catch { } }
          if (createdStageExe) { try { File.Delete(stageExe); } catch { } }
          try { File.Delete(txFile); } catch { }
          HandoffFailed = true;
          // If original installation was restored, restart it on the local port and exit this failed handoff process.
          if (File.Exists(dstExe) && Directory.Exists(dstWww)) {
            lock (ListenerLock) { Running = false; StopCurrentListenerLocked(); }
            try {
              var args = new List<string> { "--no-open", "--port", Port.ToString() };
              if (Loopback) args.Add("--loopback");
              if (Headless) args.Add("--headless");
              Process.Start(new ProcessStartInfo { FileName = dstExe, Arguments = string.Join(" ", args), WorkingDirectory = targetRoot, UseShellExecute = false, CreateNoWindow = Headless });
            } catch { }
            Environment.Exit(1);
          }
        }
      } catch {
        HandoffFailed = true;
      } finally {
        if (installMutex != null) { try { installMutex.ReleaseMutex(); installMutex.Dispose(); } catch { } }
      }
    }
    static void MoveFileWithRetry(string from, string to) {
      for (int attempt = 0; attempt < 25; attempt++) {
        try { File.Move(from, to); return; }
        catch { if (attempt == 24) throw; Thread.Sleep(200); }
      }
    }
    static void MoveDirectoryWithRetry(string from, string to) {
      for (int attempt = 0; attempt < 25; attempt++) {
        try { Directory.Move(from, to); return; }
        catch { if (attempt == 24) throw; Thread.Sleep(200); }
      }
    }
    static void CopyDirectory(string sourceDir, string targetDir) {
      Directory.CreateDirectory(targetDir);
      foreach (var dir in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories)) {
        Directory.CreateDirectory(Path.Combine(targetDir, dir.Substring(sourceDir.Length + 1)));
      }
      foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories)) {
        string dest = Path.Combine(targetDir, file.Substring(sourceDir.Length + 1));
        File.Copy(file, dest, true);
      }
    }
    static void Open() { try { Process.Start("http://127.0.0.1:" + Port + (JoinUrl == "" ? "" : "/?join=" + Uri.EscapeDataString(JoinUrl))); } catch { } }
    static void Dispatch(TcpClient socket) { Task.Run(() => Handle(socket)); }
    static async Task Accept(TcpListener listener) {
      while (Running && listener == Listener) {
        try { var socket = await listener.AcceptTcpClientAsync(); Dispatch(socket); }
        catch { if (!Running || listener != Listener) break; }
      }
    }
    static async Task<Request> Read(TcpClient socket, NetworkStream stream, IPAddress remote) {
      var data = new List<byte>(); int match = 0; var one = new byte[1];
      using (var deadline = new CancellationTokenSource(15000))
      using (deadline.Token.Register(() => { try { socket.Close(); } catch { } })) {
        while (data.Count < 16384) { int got = await stream.ReadAsync(one, 0, 1, deadline.Token); if (got == 0) throw new IOException(); data.Add(one[0]); byte expected = new byte[] { 13, 10, 13, 10 }[match]; match = one[0] == expected ? match + 1 : (one[0] == 13 ? 1 : 0); if (match == 4) break; }
        if (match != 4) throw new IOException(); var lines = Encoding.ASCII.GetString(data.ToArray()).Split(new string[] { "\r\n" }, StringSplitOptions.None); var first = lines[0].Split(' '); if (first.Length != 3) throw new IOException();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); foreach (var line in lines.Skip(1)) { int colon = line.IndexOf(':'); if (colon > 0) headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim(); }
        int length = 0; if (headers.ContainsKey("Content-Length") && (!int.TryParse(headers["Content-Length"], out length) || length < 0 || length > 65536)) throw new IOException();
        if (headers.ContainsKey("Transfer-Encoding")) throw new IOException(); var body = new byte[length]; int offset = 0;
        while (offset < length) { int n = await stream.ReadAsync(body, offset, length - offset, deadline.Token); if (n == 0) throw new IOException(); offset += n; }
        int q = first[1].IndexOf('?');
        return new Request {
          Method = first[0],
          Path = Uri.UnescapeDataString(q < 0 ? first[1] : first[1].Substring(0, q)),
          Query = q < 0 ? "" : first[1].Substring(q + 1),
          Origin = headers.ContainsKey("Origin") ? headers["Origin"] : "",
          Host = headers.ContainsKey("Host") ? headers["Host"] : "",
          Body = body,
          Remote = remote
        };
      }
    }
    static async Task Reply(NetworkStream stream, int status, byte[] bytes, string type = "application/json; charset=utf-8", string extra = "") {
      string reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : status == 503 ? "Service Unavailable" : "Bad Request";
      var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n" + extra + "\r\n"); await stream.WriteAsync(header, 0, header.Length); await stream.WriteAsync(bytes, 0, bytes.Length);
    }
    static Task J(NetworkStream stream, int status, object value, string extra = "") { return Reply(stream, status, Encoding.UTF8.GetBytes(Encode(value)), "application/json; charset=utf-8", extra); }
    static bool ValidLocalHost(string host) {
      if (string.IsNullOrEmpty(host)) return false;
      return string.Equals(host, "127.0.0.1:" + Port, StringComparison.OrdinalIgnoreCase) ||
             string.Equals(host, "localhost:" + Port, StringComparison.OrdinalIgnoreCase);
    }
    static bool Local(Request r) {
      return IPAddress.IsLoopback(r.Remote) && ValidLocalHost(r.Host) &&
             (r.Origin == "" || r.Origin == "http://127.0.0.1:" + Port || r.Origin == "http://localhost:" + Port);
    }
    static bool Authorized(Request r, IDictionary<string, object> body) { return Local(r) && Str(body, "token") == Token; }
    static bool Private(IPAddress ip) { byte[] b = ip.GetAddressBytes(); return IPAddress.IsLoopback(ip) || (b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] >= 64 && b[1] <= 127))); }
    static string B64(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    static string CanonicalEndpoint(string text) { Uri uri; if (text == null || text.Length > 512 || !Uri.TryCreate(text, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Port < 1024 || uri.Port > 65535 || uri.UserInfo != "") throw new Exception("邀请码中的接入信息无效"); return uri.GetLeftPart(UriPartial.Authority); }
    static string Invite(string url, string actor = "") { string canonical = CanonicalEndpoint(url); if (actor != "" && !Regex.IsMatch(actor, "^[0-9a-f]{64}$")) throw new Exception("邀请码的发码账号无效"); string payload = actor == "" ? canonical : Encode(new { url = canonical, actor }); using (var sha = SHA256.Create()) return "YL1." + B64(Encoding.UTF8.GetBytes(payload)) + "." + B64(sha.ComputeHash(Encoding.UTF8.GetBytes("fish-invite-v1:" + payload)).Take(8).ToArray()); }
    static string PublishedInvite() { var client = Clients.Values.Where(c => c.Active && !string.IsNullOrEmpty(c.Actor)).OrderBy(c => c.Id).FirstOrDefault(); return Invite(Published, client == null ? "" : client.Actor); }
    static string DecodeInvite(string code) {
      try { if (code == null || code.Length > 1024) throw new Exception(); code = new string(code.Where(c => !char.IsWhiteSpace(c)).ToArray()); string[] parts = code.Split('.'); if (parts.Length != 3 || parts[0] != "YL1" || parts[1].Any(c => !(char.IsLetterOrDigit(c) && c < 128) && c != '-' && c != '_')) throw new Exception(); string payload = parts[1].Replace('-', '+').Replace('_', '/'); payload += new string('=', (4 - payload.Length % 4) % 4); string raw = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(payload)), url = raw, actor = ""; if (raw.StartsWith("{", StringComparison.Ordinal)) { var data = Json().Deserialize<Dictionary<string, object>>(raw); url = Str(data, "url"); actor = Str(data, "actor"); if (actor == "" || raw != Encode(new { url, actor })) throw new Exception(); } if (CanonicalEndpoint(url) != url || Invite(url, actor) != code) throw new Exception(); return url; }
      catch { throw new Exception("邀请码无效或不完整，请重新复制"); }
    }
    static string NormalizeInvite(string value) { if (string.IsNullOrWhiteSpace(value)) return ""; value = value.Trim(); if (!value.StartsWith("YL1.", StringComparison.Ordinal)) return Invite(value); DecodeInvite(value); return new string(value.Where(c => !char.IsWhiteSpace(c)).ToArray()); }
    static string RequestInvite(Request request) { string value = System.Web.HttpUtility.ParseQueryString(request.Query)["invite"]; if (string.IsNullOrWhiteSpace(value)) return PublishedInvite(); string code = NormalizeInvite(value); if (!Urls.Contains(DecodeInvite(code))) throw new Exception("邀请码不属于此入口"); return code; }
    static object[] InviteHints(object[] hints) { var result = new List<object>(); foreach (var value in (hints ?? new object[0]).Take(20)) { var hint = value as IDictionary<string, object>; if (hint == null) continue; try { string code = NormalizeInvite(Str(hint, "url")); if (code != "") result.Add(new Dictionary<string, object> { { "id", Str(hint, "id") }, { "url", code } }); } catch { } } return result.ToArray(); }
    static async Task<Uri> PeerUri(string text) {
      string address = text != null && text.Trim().StartsWith("YL1.", StringComparison.Ordinal) ? DecodeInvite(text) : text;
      var uri = new Uri(CanonicalEndpoint(address));
      var ips = await Dns.GetHostAddressesAsync(uri.Host);
      if (ips.Length == 0 || ips.Any(ip => !Private(ip))) throw new Exception("邀请码只支持内网或本机直连");
      var pinned = ips.FirstOrDefault(ip => ip.AddressFamily == AddressFamily.InterNetwork) ?? ips[0];
      return new Uri("http://" + pinned + ":" + uri.Port);
    }
    static async Task<object> Fetch(Uri peer, string path, object data) {
      var request = (HttpWebRequest)WebRequest.Create(new Uri(peer, path)); request.Proxy = null; request.AllowAutoRedirect = false; request.Timeout = 15000; request.ReadWriteTimeout = 15000;
      using (var deadline = new CancellationTokenSource(15000)) using (deadline.Token.Register(() => request.Abort())) {
        if (data != null) { request.Method = "POST"; request.ContentType = "application/json"; var bytes = Encoding.UTF8.GetBytes(Encode(data)); request.ContentLength = bytes.Length; using (var output = await request.GetRequestStreamAsync()) await output.WriteAsync(bytes, 0, bytes.Length); }
        WebResponse reply;
        try { reply = await request.GetResponseAsync(); }
        catch (WebException ex) { if (ex.Response == null) throw; reply = ex.Response; }
        using (var response = reply)
        using (var input = response.GetResponseStream())
        using (var ms = new MemoryStream()) {
          var buf = new byte[8192];
          int n;
          while ((n = await input.ReadAsync(buf, 0, buf.Length, deadline.Token)) > 0) {
            if (ms.Length + n > MaxStatusBytes) throw new Exception("对端响应体积过大");
            ms.Write(buf, 0, n);
          }
          return Json().DeserializeObject(Encoding.UTF8.GetString(ms.ToArray()));
        }
      }
    }
    static string RouteUrl(Uri peer) { try { var ip = Dns.GetHostAddresses(peer.Host).First(a => a.AddressFamily == AddressFamily.InterNetwork); using (var route = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) { route.Connect(new IPEndPoint(ip, peer.Port)); return "http://" + ((IPEndPoint)route.LocalEndPoint).Address + ":" + Port; } } catch { return Published; } }
    static object Status() { return new { ok = true, version = BuildInfo.Version, rulesVersion = BuildInfo.RulesVersion, rules = RulesObject, clients = Clients.Values.Where(c => c.Active).Select(c => new { id = c.Id, nick = c.Nick, peers = c.Peers, url = Invite(Published) }).ToArray(), hints = InviteHints(Clients.Values.Where(c => c.Active).SelectMany(c => c.Hints).Take(20).ToArray()) }; }

    static readonly Regex SemverRegex = new Regex(@"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$", RegexOptions.Compiled);
    static readonly Regex NumericRegex = new Regex(@"^[0-9]+$", RegexOptions.Compiled);
    static bool TryParseSemver(string version, out string major, out string minor, out string patch, out string[] pre) {
      major = minor = patch = ""; pre = new string[0];
      if (string.IsNullOrWhiteSpace(version)) return false;
      var m = SemverRegex.Match(version.Trim());
      if (!m.Success) return false;
      major = m.Groups[1].Value; minor = m.Groups[2].Value; patch = m.Groups[3].Value;
      if (m.Groups[4].Success) pre = m.Groups[4].Value.Split('.');
      return true;
    }
    static bool IsPrerelease(string version) {
      string a, b, c; string[] pre;
      return TryParseSemver(version, out a, out b, out c, out pre) && pre.Length > 0;
    }
    static int CompareNumericString(string x, string y) {
      if (x.Length != y.Length) return x.Length.CompareTo(y.Length);
      return string.CompareOrdinal(x, y);
    }
    static int CompareSemver(string left, string right) {
      string a1, a2, a3, b1, b2, b3; string[] ap, bp;
      if (!TryParseSemver(left, out a1, out a2, out a3, out ap) || !TryParseSemver(right, out b1, out b2, out b3, out bp)) throw new Exception("发行版本号无效");
      int c1 = CompareNumericString(a1, b1); if (c1 != 0) return c1;
      int c2 = CompareNumericString(a2, b2); if (c2 != 0) return c2;
      int c3 = CompareNumericString(a3, b3); if (c3 != 0) return c3;
      if (ap.Length == 0 && bp.Length == 0) return 0;
      if (ap.Length == 0) return 1;
      if (bp.Length == 0) return -1;
      int len = Math.Max(ap.Length, bp.Length);
      for (int i = 0; i < len; i++) {
        if (i >= ap.Length) return -1;
        if (i >= bp.Length) return 1;
        string x = ap[i], y = bp[i];
        if (x == y) continue;
        bool xn = NumericRegex.IsMatch(x), yn = NumericRegex.IsMatch(y);
        if (xn && yn) { int c = CompareNumericString(x, y); if (c != 0) return c; continue; }
        if (xn != yn) return xn ? -1 : 1;
        return string.CompareOrdinal(x, y);
      }
      return 0;
    }

    static object UpdateDto(UpdateRecord u) {
      return new {
        phase = u.Phase, id = u.Id, sourceKind = u.SourceKind, sourceLabel = u.SourceLabel, sourceInput = u.SourceInput,
        currentVersion = BuildInfo.Version, targetVersion = u.TargetVersion, targetRulesVersion = u.TargetRulesVersion,
        prerelease = u.Prerelease, error = u.Error,
        downloadedBytes = u.DownloadedBytes, totalBytes = u.TotalBytes
      };
    }
    static void SafeDeleteDirectory(string path) {
      if (string.IsNullOrEmpty(path)) return;
      try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
    }
    static bool IsAllowedGithubDownloadHost(string host) {
      if (string.IsNullOrEmpty(host)) return false;
      string h = host.ToLowerInvariant();
      return h == "github.com" || h.EndsWith(".githubusercontent.com", StringComparison.Ordinal);
    }
    static void ParseGithubRelease(string input, out Uri downloadUri, out string targetVersion, out string sourceLabel, out bool isLocalTest) {
      if (string.IsNullOrWhiteSpace(input)) throw new Exception("请粘贴 GitHub Release 链接");
      Uri uri;
      if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out uri)) throw new Exception("GitHub Release 链接格式无效");
      if (!string.IsNullOrEmpty(uri.UserInfo)) throw new Exception("发行版链接不能包含认证信息");
      isLocalTest = Loopback && uri.Scheme == "http" && uri.Host == "127.0.0.1";
      if (!isLocalTest) {
        if (uri.Scheme != "https") throw new Exception("发行版链接必须使用 HTTPS 地址");
        if (!string.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase) || (!uri.IsDefaultPort && uri.Port != 443)) {
          throw new Exception("仅支持 https://github.com 的发行版链接");
        }
      }
      string cleanPath = uri.AbsolutePath.TrimEnd('/');
      var tagMatch = Regex.Match(cleanPath, @"^/([^/]+)/([^/]+)/releases/tag/([vV]([^/]+))$");
      if (tagMatch.Success) {
        string owner = tagMatch.Groups[1].Value, repo = tagMatch.Groups[2].Value, tag = tagMatch.Groups[3].Value, ver = tagMatch.Groups[4].Value;
        string a, b, c; string[] pre;
        if (!TryParseSemver(ver, out a, out b, out c, out pre) || ver.Contains("+")) throw new Exception("发行版链接中的版本号无效");
        targetVersion = ver;
        sourceLabel = uri.GetLeftPart(UriPartial.Authority) + cleanPath;
        downloadUri = new Uri(uri.GetLeftPart(UriPartial.Authority) + "/" + owner + "/" + repo + "/releases/download/" + tag + "/fishcome-" + ver + "-windows.zip");
        return;
      }
      var assetMatch = Regex.Match(cleanPath, @"^/([^/]+)/([^/]+)/releases/download/([vV]([^/]+))/fishcome-([^/]+)-windows\.zip$");
      if (assetMatch.Success) {
        string tagVer = assetMatch.Groups[4].Value, fileVer = assetMatch.Groups[5].Value;
        string a, b, c; string[] pre;
        if (!TryParseSemver(fileVer, out a, out b, out c, out pre) || fileVer.Contains("+") || tagVer != fileVer) {
          throw new Exception("发布包链接中的标签版本与文件名版本不一致或无效");
        }
        targetVersion = fileVer;
        downloadUri = new Uri(uri.GetLeftPart(UriPartial.Authority) + cleanPath);
        sourceLabel = downloadUri.AbsoluteUri;
        return;
      }
      throw new Exception("请粘贴具体的 GitHub Release 页面链接（/releases/tag/vX.Y.Z）或 Windows 便携包直链");
    }
    static async Task<byte[]> DownloadBytes(Uri url, bool allowRedirects, bool enforceGithubHost, CancellationToken ct, Action<long, long> onProgress = null) {
      Uri current = url;
      using (var timeoutCts = new CancellationTokenSource(120000))
      using (var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token)) {
        for (int hops = 0; hops <= (allowRedirects ? 5 : 0); hops++) {
          linked.Token.ThrowIfCancellationRequested();
          if (enforceGithubHost) {
            if (current.Scheme != "https") throw new Exception("更新包下载仅允许 HTTPS 地址");
            if (!string.IsNullOrEmpty(current.UserInfo) || (!current.IsDefaultPort && current.Port != 443)) throw new Exception("更新包下载重定向地址无效");
            if (!IsAllowedGithubDownloadHost(current.Host)) throw new Exception("更新包重定向到了非 GitHub 域名：" + current.Host);
            var ips = await Dns.GetHostAddressesAsync(current.Host);
            if (ips.Length == 0 || ips.Any(ip => Private(ip))) throw new Exception("更新包下载目标不能指向内网地址");
          }
          var req = (HttpWebRequest)WebRequest.Create(current);
          req.AllowAutoRedirect = false;
          req.Timeout = 120000;
          req.ReadWriteTimeout = 120000;
          req.UserAgent = "fishcome-launcher/" + BuildInfo.Version;
          if (!allowRedirects) req.Proxy = null;
          using (linked.Token.Register(() => req.Abort())) {
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)await req.GetResponseAsync(); }
            catch (WebException ex) {
              if (linked.IsCancellationRequested) throw new OperationCanceledException();
              if (ex.Response is HttpWebResponse) resp = (HttpWebResponse)ex.Response;
              else throw new Exception("下载更新包失败，请检查网络连接");
            }
            using (resp) {
              int code = (int)resp.StatusCode;
              if (allowRedirects && (code == 301 || code == 302 || code == 303 || code == 307 || code == 308)) {
                string loc = resp.Headers["Location"];
                if (string.IsNullOrWhiteSpace(loc)) throw new Exception("下载重定向缺少目标地址");
                current = new Uri(current, loc);
                continue;
              }
              if (code != 200) throw new Exception("更新包下载失败（HTTP " + code + "）");
              long contentLength = resp.ContentLength;
              if (contentLength > MaxPackageBytes) throw new Exception("更新包体积超过限制");
              if (onProgress != null) onProgress(0, contentLength);
              using (var input = resp.GetResponseStream())
              using (var ms = new MemoryStream()) {
                var buf = new byte[65536];
                long total = 0;
                int n;
                while ((n = await input.ReadAsync(buf, 0, buf.Length, linked.Token)) > 0) {
                  total += n;
                  if (total > MaxPackageBytes) throw new Exception("更新包体积超过限制");
                  ms.Write(buf, 0, n);
                  if (onProgress != null) onProgress(total, contentLength);
                }
                return ms.ToArray();
              }
            }
          }
        }
      }
      throw new Exception("更新包下载重定向次数过多");
    }
    static void PrecheckZipEntryCount(byte[] zipBytes) {
      if (zipBytes.Length < 22) throw new Exception("更新包格式无效");
      int minOffset = Math.Max(0, zipBytes.Length - 65557);
      for (int i = zipBytes.Length - 22; i >= minOffset; i--) {
        if (zipBytes[i] == 0x50 && zipBytes[i + 1] == 0x4B && zipBytes[i + 2] == 0x05 && zipBytes[i + 3] == 0x06) {
          ushort totalEntries = BitConverter.ToUInt16(zipBytes, i + 10);
          if (totalEntries > MaxZipEntries) throw new Exception("更新包文件数量超过限制");
          return;
        }
      }
      throw new Exception("更新包缺少有效的压缩目录结构");
    }
    static void ExtractPackageSafely(byte[] zipBytes, string stagingDir) {
      PrecheckZipEntryCount(zipBytes);
      Directory.CreateDirectory(stagingDir);
      string fullStaging = Path.GetFullPath(stagingDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
      string fullWww = Path.GetFullPath(Path.Combine(stagingDir, "www")) + Path.DirectorySeparatorChar;
      long extractedBytes = 0;
      int entryCount = 0;
      var seenFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var seenDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      using (var ms = new MemoryStream(zipBytes))
      using (var archive = new ZipArchive(ms, ZipArchiveMode.Read)) {
        if (archive.Entries.Count > MaxZipEntries) throw new Exception("更新包文件数量超过限制");
        foreach (var entry in archive.Entries) {
          entryCount++;
          if (entryCount > MaxZipEntries) throw new Exception("更新包文件数量超过限制");
          string norm = entry.FullName.Replace('\\', '/');
          if (string.IsNullOrEmpty(norm)) continue;
          string trimmed = norm.TrimEnd('/');
          string[] segments = trimmed.Split('/');
          if (trimmed.StartsWith("/", StringComparison.Ordinal) || trimmed.Contains("\0") || trimmed.Contains(":") ||
              segments.Any(seg => seg == "" || seg == ".." || seg == "." || seg.EndsWith(" ", StringComparison.Ordinal) || seg.EndsWith(".", StringComparison.Ordinal))) {
            throw new Exception("更新包包含非法路径条目");
          }
          if (norm.EndsWith("/", StringComparison.Ordinal)) continue;
          bool isRootExe = string.Equals(norm, "鱼来.exe", StringComparison.OrdinalIgnoreCase);
          bool isWwwFile = norm.StartsWith("www/", StringComparison.OrdinalIgnoreCase);
          if (!isRootExe && !isWwwFile) continue;
          if (!seenFiles.Add(norm)) throw new Exception("更新包包含重复或大小写冲突的文件条目");
          string prefix = "";
          for (int i = 0; i < segments.Length - 1; i++) {
            prefix = i == 0 ? segments[i] : prefix + "/" + segments[i];
            if (seenFiles.Contains(prefix)) throw new Exception("更新包存在文件与目录同名冲突");
            seenDirs.Add(prefix);
          }
          if (seenDirs.Contains(norm)) throw new Exception("更新包存在文件与目录同名冲突");
          string destPath = Path.GetFullPath(Path.Combine(stagingDir, norm.Replace('/', Path.DirectorySeparatorChar)));
          if (isRootExe) {
            if (!string.Equals(destPath, Path.Combine(stagingDir, "鱼来.exe"), StringComparison.OrdinalIgnoreCase)) throw new Exception("更新包程序路径越界");
          } else {
            if (!destPath.StartsWith(fullWww, StringComparison.OrdinalIgnoreCase)) throw new Exception("更新包资源路径越界");
          }
          if (!destPath.StartsWith(fullStaging, StringComparison.OrdinalIgnoreCase)) throw new Exception("更新包条目越界");
          Directory.CreateDirectory(Path.GetDirectoryName(destPath));
          using (var input = entry.Open())
          using (var output = new FileStream(destPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            var buf = new byte[65536];
            int n;
            while ((n = input.Read(buf, 0, buf.Length)) > 0) {
              extractedBytes += n;
              if (extractedBytes > MaxExtractedBytes) throw new Exception("更新包解压体积超过限制");
              output.Write(buf, 0, n);
            }
          }
        }
      }
      string[] requiredFiles = new string[] {
        "鱼来.exe", "www/index.html", "www/app.js", "www/rules.js", "www/update.js", "www/network.js", "www/storage.js", "www/style.css"
      };
      foreach (var reqFile in requiredFiles) {
        if (!File.Exists(Path.Combine(stagingDir, reqFile.Replace('/', Path.DirectorySeparatorChar)))) {
          throw new Exception("更新包缺少必需文件：" + reqFile);
        }
      }
    }
    static void VerifyExtractedPackageStatic(string stagingDir, string expectedVersion, out string rulesVersion) {
      rulesVersion = "";
      string exePath = Path.Combine(stagingDir, "鱼来.exe");
      // Verify full PE header ("MZ" + e_lfanew -> "PE\0\0") without executing the binary before user confirmation.
      using (var fs = File.OpenRead(exePath)) {
        if (fs.Length < 64) throw new Exception("更新包内的鱼来.exe不是有效的可执行程序");
        var dos = new byte[64];
        if (fs.Read(dos, 0, 64) != 64 || dos[0] != 'M' || dos[1] != 'Z') throw new Exception("更新包内的鱼来.exe不是有效的可执行程序");
        int peOffset = BitConverter.ToInt32(dos, 60);
        if (peOffset < 64 || peOffset + 4 > fs.Length) throw new Exception("更新包内的鱼来.exe缺少有效PE头");
        fs.Seek(peOffset, SeekOrigin.Begin);
        var peSig = new byte[4];
        if (fs.Read(peSig, 0, 4) != 4 || peSig[0] != 'P' || peSig[1] != 'E' || peSig[2] != 0 || peSig[3] != 0) throw new Exception("更新包内的鱼来.exe缺少有效PE签名");
      }
      var fvi = FileVersionInfo.GetVersionInfo(exePath);
      string actualVersion = (fvi.ProductVersion ?? "").Trim();
      if (actualVersion != expectedVersion) {
        throw new Exception("更新包内程序版本（" + (actualVersion == "" ? "未知" : actualVersion) + "）与声明版本（" + expectedVersion + "）不一致");
      }
      if (CompareSemver(actualVersion, BuildInfo.Version) <= 0) throw new Exception("目标版本不高于当前版本");
      string rulesFile = Path.Combine(stagingDir, "www", "rules.js");
      if (File.Exists(rulesFile)) {
        try {
          string text = File.ReadAllText(rulesFile, Encoding.UTF8);
          var m = Regex.Match(text, @"Object\.freeze\((\{[\s\S]*?\})\)");
          if (m.Success) {
            var dict = Json().Deserialize<Dictionary<string, object>>(m.Groups[1].Value);
            rulesVersion = string.Join(".", dict.Values.Select(v => Convert.ToString(v)));
          }
        } catch { }
      }
    }
    static async Task<object> PrepareUpdate(string kind, string input) {
      if (!HandoffReady) throw new InvalidOperationException("上次更新正在收尾，请稍后再试");
      string taskId = Guid.NewGuid().ToString("N");
      var cts = new CancellationTokenSource();
      string oldStaging = "";
      lock (UpdateLock) {
        if (UpdateState.Phase == "checking" || UpdateState.Phase == "downloading" || UpdateState.Phase == "applying") {
          cts.Dispose();
          throw new InvalidOperationException("当前已有更新任务正在进行");
        }
        oldStaging = UpdateState.StagingDir;
        UpdateState = new UpdateRecord { Phase = "checking", Id = taskId, SourceKind = kind, SourceInput = input, Cts = cts };
      }
      SafeDeleteDirectory(oldStaging);
      string stagingDir = "";
      try {
        Uri downloadUri;
        string targetVersion, sourceLabel;
        bool allowRedirects, enforceGithubHost;
        if (kind == "github") {
          bool isLocalTest;
          ParseGithubRelease(input, out downloadUri, out targetVersion, out sourceLabel, out isLocalTest);
          allowRedirects = true;
          enforceGithubHost = !isLocalTest;
        } else if (kind == "peer") {
          var peerUri = await PeerUri(input);
          var statusObj = await Fetch(peerUri, "/status", null) as IDictionary<string, object>;
          if (statusObj == null || !Convert.ToBoolean(statusObj.ContainsKey("ok") ? statusObj["ok"] : false)) throw new Exception("无法读取同事的版本信息");
          targetVersion = Str(statusObj, "version");
          if (string.IsNullOrEmpty(targetVersion)) throw new Exception("同事版本过旧，不支持热更新");
          var nicks = new List<string>();
          var clientList = statusObj.ContainsKey("clients") && !(statusObj["clients"] is string) ? statusObj["clients"] as System.Collections.IEnumerable : null;
          if (clientList != null) {
            foreach (var item in clientList) {
              var dict = item as IDictionary<string, object>;
              string nick = Str(dict, "nick").Trim();
              if (!string.IsNullOrEmpty(nick) && !nicks.Contains(nick)) nicks.Add(nick);
            }
          }
          string inviteRef = (input ?? "").Trim();
          if (!inviteRef.StartsWith("YL1.", StringComparison.OrdinalIgnoreCase)) inviteRef = Invite(peerUri.GetLeftPart(UriPartial.Authority));
          string codeTail = inviteRef.Length > 6 ? inviteRef.Substring(inviteRef.Length - 6) : inviteRef;
          if (nicks.Count == 1) sourceLabel = "局域网同事（" + nicks[0] + " · 码尾 …" + codeTail + "）";
          else if (nicks.Count > 1) sourceLabel = "局域网同事（" + nicks[0] + " 等 " + nicks.Count + " 人 · 码尾 …" + codeTail + "）";
          else sourceLabel = "局域网同事（码尾 …" + codeTail + "）";
          downloadUri = new Uri(peerUri, "/download.zip");
          allowRedirects = false;
          enforceGithubHost = false;
        } else {
          throw new Exception("不支持的更新来源");
        }
        if (CompareSemver(targetVersion, BuildInfo.Version) <= 0) {
          throw new Exception("来源版本 " + targetVersion + " 不高于当前版本 " + BuildInfo.Version + "，无需更新");
        }
        lock (UpdateLock) {
          if (UpdateState.Id != taskId) throw new OperationCanceledException();
          UpdateState.Phase = "downloading";
          UpdateState.SourceLabel = sourceLabel;
          UpdateState.TargetVersion = targetVersion;
          UpdateState.Prerelease = IsPrerelease(targetVersion);
          UpdateState.DownloadedBytes = 0;
          UpdateState.TotalBytes = -1;
        }
        byte[] zipBytes = await DownloadBytes(downloadUri, allowRedirects, enforceGithubHost, cts.Token, (done, total) => {
          lock (UpdateLock) {
            if (UpdateState.Id == taskId) {
              UpdateState.DownloadedBytes = done;
              UpdateState.TotalBytes = total;
            }
          }
        });
        cts.Token.ThrowIfCancellationRequested();
        stagingDir = Path.Combine(Root, ".update-" + taskId);
        ExtractPackageSafely(zipBytes, stagingDir);
        string rulesVersion;
        VerifyExtractedPackageStatic(stagingDir, targetVersion, out rulesVersion);
        lock (UpdateLock) {
          if (UpdateState.Id != taskId) {
            SafeDeleteDirectory(stagingDir);
            throw new OperationCanceledException("更新任务已取消");
          }
          UpdateState.Phase = "ready";
          UpdateState.StagingDir = stagingDir;
          UpdateState.TargetRulesVersion = rulesVersion;
          UpdateState.Error = "";
          UpdateState.Cts = null;
          return UpdateDto(UpdateState);
        }
      } catch (OperationCanceledException) {
        SafeDeleteDirectory(stagingDir);
        throw new Exception("更新已取消");
      } catch (Exception ex) {
        SafeDeleteDirectory(stagingDir);
        lock (UpdateLock) {
          if (UpdateState.Id == taskId) {
            UpdateState.Phase = "failed";
            UpdateState.StagingDir = "";
            UpdateState.Error = ex.Message;
            UpdateState.Cts = null;
          }
        }
        throw;
      } finally {
        cts.Dispose();
      }
    }
    static void PerformHandoff(UpdateRecord record) {
      Process child = null;
      string nonce = RandomToken();
      try {
        Thread.Sleep(150);
        lock (ListenerLock) {
          Updating = true;
          StopCurrentListenerLocked();
        }
        string newExe = Path.Combine(record.StagingDir, "鱼来.exe");
        var args = new List<string> { "--no-open", "--port", Port.ToString() };
        if (Loopback) args.Add("--loopback");
        if (Headless) args.Add("--headless");
        args.Add("--handoff-target"); args.Add("\"" + Root + "\"");
        args.Add("--handoff-parent"); args.Add(Process.GetCurrentProcess().Id.ToString());
        args.Add("--handoff-nonce"); args.Add(nonce);
        var psi = new ProcessStartInfo {
          FileName = newExe,
          Arguments = string.Join(" ", args),
          WorkingDirectory = record.StagingDir,
          UseShellExecute = false,
          CreateNoWindow = Headless
        };
        child = Process.Start(psi);
        bool ready = false;
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline) {
          if (child == null || child.HasExited) break;
          try {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/health");
            req.Proxy = null; req.Timeout = 1000; req.ReadWriteTimeout = 1000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8)) {
              var info = Json().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
              bool ok = info != null && info.ContainsKey("ok") && Convert.ToBoolean(info["ok"]);
              if (ok && Str(info, "version") == record.TargetVersion && Str(info, "handoffNonce") == nonce) { ready = true; break; }
            }
          } catch { }
          Thread.Sleep(200);
        }
        if (ready) {
          Running = false;
          try { if (TrayIcon != null) TrayIcon.Visible = false; } catch { }
          Environment.Exit(0);
          return;
        }
        throw new Exception("新版本未能按时接管本地地址");
      } catch (Exception ex) {
        try {
          if (child != null && !child.HasExited) {
            child.Kill();
            child.WaitForExit(3000);
          }
        } catch { }
        SafeDeleteDirectory(record.StagingDir);
        Updating = false;
        bool restored = StartListenerWithRetry(5000);
        lock (UpdateLock) {
          if (UpdateState.Id == record.Id) {
            UpdateState.Phase = "failed";
            UpdateState.StagingDir = "";
            UpdateState.Error = restored ? ("新版本启动失败，已恢复旧版本：" + ex.Message) : ("新版本启动失败且旧版本端口恢复失败：" + ex.Message);
          }
        }
      }
    }

    static async Task Handle(TcpClient socket) {
      using (socket) using (var stream = socket.GetStream()) try {
        var r = await Read(socket, stream, ((IPEndPoint)socket.Client.RemoteEndPoint).Address);
        if (r.Path == "/health" && r.Method == "GET") {
          await J(stream, 200, new { ok = true, name = "tide", version = BuildInfo.Version, rulesVersion = BuildInfo.RulesVersion, rules = RulesObject, handoffNonce = HandoffNonce, handoffReady = HandoffReady, handoffFailed = HandoffFailed }, "Cache-Control: no-store\r\n");
          return;
        }
        if (r.Path == "/status" && r.Method == "GET") { await J(stream, 200, Status()); return; }
        if (r.Path == "/invite" && r.Method == "GET") { await J(stream, 200, new { invite = RequestInvite(r) }); return; }
        if (r.Path == "/local/meta" && r.Method == "GET") {
          if (!Local(r)) { await J(stream, 403, new { ok = false }); return; }
          await J(stream, 200, new { token = Token, url = Invite(Published), urls = Urls.Select(url => Invite(url)).ToArray(), joinUrl = JoinUrl, version = BuildInfo.Version, rulesVersion = BuildInfo.RulesVersion, rules = RulesObject }, "Cache-Control: no-store\r\n");
          return;
        }
        if (r.Path == "/local/events" && r.Method == "GET") {
          var query = System.Web.HttpUtility.ParseQueryString(r.Query); Client client;
          if (!Local(r) || query["token"] != Token || !Clients.TryGetValue(query["node"], out client)) { await J(stream, 403, new { ok = false }); return; }
          int generation = Interlocked.Increment(ref client.Generation); client.Active = true;
          var header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: ready\n\n"); await stream.WriteAsync(header, 0, header.Length);
          try { int loops = 0; while (Running && !Updating && generation == client.Generation && client.Active) { string message; if (client.Queue.TryDequeue(out message)) { var bytes = Encoding.UTF8.GetBytes("data: " + message + "\n\n"); await stream.WriteAsync(bytes, 0, bytes.Length); } else if (++loops % 60 == 0) { var ping = Encoding.ASCII.GetBytes(": heartbeat\n\n"); await stream.WriteAsync(ping, 0, ping.Length); } await Task.Delay(250); } } finally { if (generation == client.Generation) client.Active = false; } return;
        }
        if (r.Path.StartsWith("/local/") && r.Method == "POST") {
          var body = Parse(r.Body); if (!Authorized(r, body)) { await J(stream, 403, new { ok = false, error = "本地通道未授权" }); return; }
          string id = Str(body, "node"); Client client;
          if (r.Path == "/local/register") { string actor = Str(body, "actor"); if (id.Length != 36 || Str(body, "nick").Length > 30 || (actor != "" && (!Regex.IsMatch(actor, "^[0-9a-f]{64}$") || !id.StartsWith(actor.Substring(0, 16) + "-", StringComparison.Ordinal)))) throw new Exception("标识无效"); Clients[id] = new Client { Id = id, Nick = Str(body, "nick"), Actor = actor, Updated = DateTime.UtcNow }; await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/presence") { if (Clients.TryGetValue(id, out client)) { client.Peers = Math.Max(0, Math.Min(16, Int(body, "peers"))); client.Updated = DateTime.UtcNow; if (body.ContainsKey("hints")) { var list = body["hints"] as System.Collections.IEnumerable; if (list != null && !(body["hints"] is string)) client.Hints = InviteHints(list.Cast<object>().Take(12).ToArray()); } } await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/unregister") { if (Clients.TryGetValue(id, out client)) { Interlocked.Increment(ref client.Generation); client.Active = false; } await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/probe") { var uri = await PeerUri(Str(body, "url")); await J(stream, 200, await Fetch(uri, "/status", null)); return; }
          if (r.Path == "/local/relay") { var uri = await PeerUri(Str(body, "url")); var signal = body["signal"] as IDictionary<string, object>; if (signal == null || Str(signal, "from") != id) throw new Exception("信令无效"); signal["fromUrl"] = Invite(RouteUrl(uri)); await J(stream, 200, await Fetch(uri, "/signal", signal)); return; }
          if (r.Path == "/local/update/status") { object dto; lock (UpdateLock) dto = UpdateDto(UpdateState); await J(stream, 200, new { ok = true, update = dto }); return; }
          if (r.Path == "/local/update/cancel") {
            string cancelId = Str(body, "id");
            string toDelete = ""; object dto = null; bool busy = false; CancellationTokenSource toCancel = null;
            lock (UpdateLock) {
              if (UpdateState.Phase == "applying") busy = true;
              else if (cancelId != "" && UpdateState.Id != "" && UpdateState.Id != cancelId) {
                dto = UpdateDto(UpdateState);
              } else {
                toDelete = UpdateState.StagingDir;
                toCancel = UpdateState.Cts;
                UpdateState = new UpdateRecord();
                dto = UpdateDto(UpdateState);
              }
            }
            if (busy) { await J(stream, 409, new { ok = false, error = "更新正在切换中，无法取消" }); return; }
            if (toCancel != null) { try { toCancel.Cancel(); } catch { } }
            SafeDeleteDirectory(toDelete);
            await J(stream, 200, new { ok = true, update = dto }); return;
          }
          if (r.Path == "/local/update/prepare") {
            object dto = null; string conflict = null;
            try { dto = await PrepareUpdate(Str(body, "kind"), Str(body, "input")); }
            catch (InvalidOperationException ex) { conflict = ex.Message; }
            if (conflict != null) { await J(stream, 409, new { ok = false, error = conflict }); return; }
            await J(stream, 200, new { ok = true, update = dto });
            return;
          }
          if (r.Path == "/local/update/apply") {
            string updateId = Str(body, "id");
            UpdateRecord snapshot = null;
            lock (UpdateLock) {
              if (HandoffReady && UpdateState.Phase == "ready" && UpdateState.Id == updateId && !string.IsNullOrEmpty(UpdateState.StagingDir) && File.Exists(Path.Combine(UpdateState.StagingDir, "鱼来.exe"))) {
                UpdateState.Phase = "applying";
                snapshot = new UpdateRecord {
                  Phase = "applying", Id = UpdateState.Id, SourceKind = UpdateState.SourceKind, SourceLabel = UpdateState.SourceLabel,
                  SourceInput = UpdateState.SourceInput, TargetVersion = UpdateState.TargetVersion, TargetRulesVersion = UpdateState.TargetRulesVersion,
                  Prerelease = UpdateState.Prerelease, StagingDir = UpdateState.StagingDir
                };
              }
            }
            if (snapshot == null) { await J(stream, 409, new { ok = false, error = "更新包未就绪或已过期，请重新检查更新" }); return; }
            var handoff = Task.Run(() => PerformHandoff(snapshot));
            try {
              await J(stream, 200, new { ok = true, id = snapshot.Id, targetVersion = snapshot.TargetVersion });
              await stream.FlushAsync();
            } catch { }
            return;
          }
          await J(stream, 404, new { ok = false }); return;
        }
        if (r.Path == "/signal" && r.Method == "POST") {
          var signal = Parse(r.Body); var sender = await PeerUri(Str(signal, "fromUrl")); var addresses = await Dns.GetHostAddressesAsync(sender.Host);
          if (!addresses.Any(ip => ip.Equals(r.Remote) || (IPAddress.IsLoopback(ip) && IPAddress.IsLoopback(r.Remote)))) { await J(stream, 403, new { ok = false, error = "信令地址不匹配" }); return; }
          string to = Str(signal, "to"), type = Str(signal, "type"); Client destination = null;
          if (to != "") Clients.TryGetValue(to, out destination);
          else destination = Clients.Values.Where(c => c.Active && c.Peers < 8).OrderBy(c => c.Peers).ThenBy(c => c.Id).FirstOrDefault();
          if (destination == null || !destination.Active || (type == "offer" && destination.Peers >= 8) || destination.Queue.Count >= 32) { await J(stream, 409, new { ok = false, error = "此入口暂时没有配对空位", hints = Clients.Values.Where(c => c.Active).SelectMany(c => c.Hints).Take(20).ToArray() }); return; }
          if (!new string[] { "offer", "answer", "reject" }.Contains(type) || Str(signal, "connection").Length != 36 || Str(signal, "from").Length != 36) throw new Exception("信令格式无效");
          signal["fromUrl"] = Invite(sender.GetLeftPart(UriPartial.Authority)); destination.Queue.Enqueue(Encode(signal)); await J(stream, 200, new { ok = true, to = destination.Id }); return;
        }
        if (r.Path == "/download.zip" && r.Method == "GET") {
          if (!HandoffReady || Updating) { await J(stream, 503, new { ok = false, error = "启动器正在更新交接中，请稍后再试" }); return; }
          await Reply(stream, 200, MakePackage(RequestInvite(r)), "application/zip", "Content-Disposition: attachment; filename=" + BuildInfo.PackageName + "\r\n");
          return;
        }
        if (r.Method != "GET" || r.Path.Contains("\\") || r.Path.Contains("\0")) { await J(stream, 400, new { ok = false }); return; }
        string requested = r.Path == "/" ? (IPAddress.IsLoopback(r.Remote) ? "index.html" : "welcome.html") : r.Path.TrimStart('/'); var file = Path.GetFullPath(Path.Combine(Www, requested));
        if (!file.StartsWith(Path.GetFullPath(Www) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) { await J(stream, 404, new { ok = false }); return; }
        string ext = Path.GetExtension(file).ToLowerInvariant(); var types = new Dictionary<string, string> { { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" }, { ".svg", "image/svg+xml" }, { ".json", "application/json; charset=utf-8" } };
        await Reply(stream, 200, File.ReadAllBytes(file), types.ContainsKey(ext) ? types[ext] : "application/octet-stream", "Cache-Control: no-cache\r\n");
      } catch (Exception ex) { try { J(stream, 400, new { ok = false, error = ex is WebException || ex is SocketException ? "邀请码暂时无法连接，请确认同事在线且网络可达" : ex.Message }).GetAwaiter().GetResult(); } catch { } }
    }
    static byte[] MakePackage(string invitation) {
      using (var memory = new MemoryStream()) { using (var archive = new ZipArchive(memory, ZipArchiveMode.Create, true)) {
        var join = archive.CreateEntry("join.json"); using (var writer = new StreamWriter(join.Open(), new UTF8Encoding(false))) writer.Write(Encode(new { invite = invitation }));
        // Always package from this process's own executable and matching www directory to avoid mixing versions.
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string ownWww = Path.Combine(BaseDir, "www");
        string wwwDir = Directory.Exists(ownWww) ? ownWww : Www;
        var entry = archive.CreateEntry("鱼来.exe"); using (var stream = entry.Open()) { var bytes = File.ReadAllBytes(exe); stream.Write(bytes, 0, bytes.Length); }
        foreach (var file in Directory.GetFiles(wwwDir, "*", SearchOption.AllDirectories)) { var item = archive.CreateEntry("www/" + file.Substring(wwwDir.Length + 1).Replace('\\', '/'), CompressionLevel.Optimal); using (var stream = item.Open()) { var bytes = File.ReadAllBytes(file); stream.Write(bytes, 0, bytes.Length); } }
        var readme = archive.CreateEntry("使用说明.txt"); using (var writer = new StreamWriter(readme.Open(), new UTF8Encoding(true))) writer.Write("鱼来 " + BuildInfo.Version + "\r\n解压整个文件夹，双击 鱼来.exe。\r\n浏览器进入固定本地地址 http://127.0.0.1:39241。\r\n支持 Chrome、Edge 和 Firefox。\r\n包内带有下载者的邀请码，自动尝试配对；也可在游戏中粘贴同事的邀请码。\r\n关闭游戏页即退出世界，托盘右键可退出启动器。\r\n世界数据仅保存在浏览器，请按需导出身份和记忆备份。\r\n");
      } return memory.ToArray(); }
    }
  }
}

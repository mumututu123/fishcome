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
    public string Method, Path, Query, Origin; public byte[] Body; public IPAddress Remote;
  }
  static class Program {
    static int Port = 39241; static bool Loopback, Headless, NoOpen;
    static string Root, Www, Token, Published, JoinUrl = "";
    static string[] Urls; static TcpListener Listener; static volatile bool Running = true;
    static readonly ConcurrentDictionary<string, Client> Clients = new ConcurrentDictionary<string, Client>();
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 32 }; }
    static string Encode(object o) { return Json().Serialize(o); }
    static IDictionary<string, object> Parse(byte[] bytes) { return Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(bytes)); }
    static string Str(IDictionary<string, object> d, string k) { return d.ContainsKey(k) ? Convert.ToString(d[k]) : ""; }
    static int Int(IDictionary<string, object> d, string k) { int n; return int.TryParse(Str(d, k), out n) ? n : 0; }
    [STAThread] static void Main(string[] args) {
      for (int i = 0; i < args.Length; i++) { if (args[i] == "--port" && i + 1 < args.Length) Port = int.Parse(args[++i]); else if (args[i] == "--loopback") Loopback = true; else if (args[i] == "--headless") Headless = true; else if (args[i] == "--no-open") NoOpen = true; }
      Root = AppDomain.CurrentDomain.BaseDirectory; Www = Path.Combine(Root, "www");
      try { string config = Path.Combine(Root, "join.json"); if (File.Exists(config)) { var join = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(config, Encoding.UTF8)); string value = Str(join, "invite"); if (value == "") value = Str(join, "url"); JoinUrl = NormalizeInvite(value); if (JoinUrl != "" && join.ContainsKey("url")) File.WriteAllText(config, Encode(new { invite = JoinUrl }), new UTF8Encoding(false)); } } catch { }
      byte[] secret = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(secret); Token = Convert.ToBase64String(secret).TrimEnd('=').Replace('+', '-').Replace('/', '_');
      var addresses = new List<string>();
      if (!Loopback) foreach (var nic in NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel)) {
        var props = nic.GetIPProperties(); if (!props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any))) continue;
        foreach (var ip in props.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)) addresses.Add("http://" + ip.Address + ":" + Port);
      }
      if (addresses.Count == 0 && !Loopback) foreach (var ip in Dns.GetHostAddresses(Dns.GetHostName()).Where(p => p.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(p))) addresses.Add("http://" + ip + ":" + Port);
      if (addresses.Count == 0) addresses.Add("http://127.0.0.1:" + Port);
      Urls = addresses.Distinct().ToArray(); Published = Urls[0];
      try { Listener = new TcpListener(Loopback ? IPAddress.Loopback : IPAddress.Any, Port); Listener.Start(128); }
      catch (Exception) { if (!Headless) { MessageBox.Show("固定端口 " + Port + " 已被占用。如果鱼来已经启动，可直接打开本地网页。", "鱼来"); Open(); } return; }
      Task.Run((Func<Task>)Accept);
      if (Headless) { while (Running) Thread.Sleep(100); return; }
      Application.EnableVisualStyles();
      using (var bitmap = new Bitmap(32, 32)) using (var graphics = Graphics.FromImage(bitmap)) {
        graphics.Clear(Color.FromArgb(11, 51, 86)); using (var font = new Font("Consolas", 16, FontStyle.Bold)) graphics.DrawString("o>", font, Brushes.Aquamarine, -1, 2);
        using (var tray = new NotifyIcon { Icon = Icon.FromHandle(bitmap.GetHicon()), Text = "鱼来 · 字符水世界", Visible = true }) {
          var menu = new ContextMenuStrip(); menu.Items.Add("打开鱼来", null, delegate { Open(); });
          menu.Items.Add("复制我的邀请码", null, delegate { Clipboard.SetText(PublishedInvite()); });
          menu.Items.Add("退出启动器", null, delegate { Running = false; Listener.Stop(); Application.Exit(); });
          tray.ContextMenuStrip = menu; tray.DoubleClick += delegate { Open(); }; if (!NoOpen) Open(); Application.Run(); tray.Visible = false;
        }
      }
    }
    static void Open() { try { Process.Start("http://127.0.0.1:" + Port + (JoinUrl == "" ? "" : "/?join=" + Uri.EscapeDataString(JoinUrl))); } catch { } }
    static void Dispatch(TcpClient socket) { Task.Run(() => Handle(socket)); }
    static async Task Accept() { while (Running) { try { var socket = await Listener.AcceptTcpClientAsync(); Dispatch(socket); } catch { if (!Running) break; } } }
    static async Task<Request> Read(NetworkStream stream, IPAddress remote) {
      var data = new List<byte>(); int match = 0; var one = new byte[1]; using (var deadline = new CancellationTokenSource(15000)) {
        while (data.Count < 16384) { int got = await stream.ReadAsync(one, 0, 1, deadline.Token); if (got == 0) throw new IOException(); data.Add(one[0]); byte expected = new byte[] { 13, 10, 13, 10 }[match]; match = one[0] == expected ? match + 1 : (one[0] == 13 ? 1 : 0); if (match == 4) break; }
        if (match != 4) throw new IOException(); var lines = Encoding.ASCII.GetString(data.ToArray()).Split(new string[] { "\r\n" }, StringSplitOptions.None); var first = lines[0].Split(' '); if (first.Length != 3) throw new IOException();
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); foreach (var line in lines.Skip(1)) { int colon = line.IndexOf(':'); if (colon > 0) headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim(); }
        int length = 0; if (headers.ContainsKey("Content-Length") && (!int.TryParse(headers["Content-Length"], out length) || length < 0 || length > 65536)) throw new IOException();
        if (headers.ContainsKey("Transfer-Encoding")) throw new IOException(); var body = new byte[length]; int offset = 0;
        while (offset < length) { int n = await stream.ReadAsync(body, offset, length - offset, deadline.Token); if (n == 0) throw new IOException(); offset += n; }
        int q = first[1].IndexOf('?'); return new Request { Method = first[0], Path = Uri.UnescapeDataString(q < 0 ? first[1] : first[1].Substring(0, q)), Query = q < 0 ? "" : first[1].Substring(q + 1), Origin = headers.ContainsKey("Origin") ? headers["Origin"] : "", Body = body, Remote = remote };
      }
    }
    static async Task Reply(NetworkStream stream, int status, byte[] bytes, string type = "application/json; charset=utf-8", string extra = "") {
      string reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : "Bad Request";
      var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n" + extra + "\r\n"); await stream.WriteAsync(header, 0, header.Length); await stream.WriteAsync(bytes, 0, bytes.Length);
    }
    static Task J(NetworkStream stream, int status, object value) { return Reply(stream, status, Encoding.UTF8.GetBytes(Encode(value))); }
    static bool Local(Request r) { return IPAddress.IsLoopback(r.Remote) && (r.Origin == "" || r.Origin == "http://127.0.0.1:" + Port); }
    static bool Authorized(Request r, IDictionary<string, object> body) { return Local(r) && Str(body, "token") == Token; }
    static bool Private(IPAddress ip) { byte[] b = ip.GetAddressBytes(); return IPAddress.IsLoopback(ip) || (b.Length == 4 && (b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) || (b[0] == 100 && b[1] >= 64 && b[1] <= 127))); }
    static string B64(byte[] bytes) { return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    static string CanonicalEndpoint(string text) { Uri uri; if (text == null || text.Length > 512 || !Uri.TryCreate(text, UriKind.Absolute, out uri) || uri.Scheme != "http" || uri.Port < 1024 || uri.Port > 65535 || uri.UserInfo != "") throw new Exception("邀请码中的接入信息无效"); return uri.GetLeftPart(UriPartial.Authority); }
    static string Invite(string url, string actor = "") { string canonical = CanonicalEndpoint(url); if (actor != "" && !System.Text.RegularExpressions.Regex.IsMatch(actor, "^[0-9a-f]{64}$")) throw new Exception("邀请码的发码账号无效"); string payload = actor == "" ? canonical : Encode(new { url = canonical, actor }); using (var sha = SHA256.Create()) return "YL1." + B64(Encoding.UTF8.GetBytes(payload)) + "." + B64(sha.ComputeHash(Encoding.UTF8.GetBytes("fish-invite-v1:" + payload)).Take(8).ToArray()); }
    static string PublishedInvite() { var client = Clients.Values.Where(c => c.Active && !string.IsNullOrEmpty(c.Actor)).OrderBy(c => c.Id).FirstOrDefault(); return Invite(Published, client == null ? "" : client.Actor); }
    static string DecodeInvite(string code) {
      try { if (code == null || code.Length > 1024) throw new Exception(); code = new string(code.Where(c => !char.IsWhiteSpace(c)).ToArray()); string[] parts = code.Split('.'); if (parts.Length != 3 || parts[0] != "YL1" || parts[1].Any(c => !(char.IsLetterOrDigit(c) && c < 128) && c != '-' && c != '_')) throw new Exception(); string payload = parts[1].Replace('-', '+').Replace('_', '/'); payload += new string('=', (4 - payload.Length % 4) % 4); string raw = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(payload)), url = raw, actor = ""; if (raw.StartsWith("{", StringComparison.Ordinal)) { var data = Json().Deserialize<Dictionary<string, object>>(raw); url = Str(data, "url"); actor = Str(data, "actor"); if (actor == "" || raw != Encode(new { url, actor })) throw new Exception(); } if (CanonicalEndpoint(url) != url || Invite(url, actor) != code) throw new Exception(); return url; }
      catch { throw new Exception("邀请码无效或不完整，请重新复制"); }
    }
    static string NormalizeInvite(string value) { if (string.IsNullOrWhiteSpace(value)) return ""; value = value.Trim(); if (!value.StartsWith("YL1.", StringComparison.Ordinal)) return Invite(value); DecodeInvite(value); return new string(value.Where(c => !char.IsWhiteSpace(c)).ToArray()); }
    static string RequestInvite(Request request) { string value = System.Web.HttpUtility.ParseQueryString(request.Query)["invite"]; if (string.IsNullOrWhiteSpace(value)) return PublishedInvite(); string code = NormalizeInvite(value); if (!Urls.Contains(DecodeInvite(code))) throw new Exception("邀请码不属于此入口"); return code; }
    static object[] InviteHints(object[] hints) { var result = new List<object>(); foreach (var value in (hints ?? new object[0]).Take(20)) { var hint = value as IDictionary<string, object>; if (hint == null) continue; try { string code = NormalizeInvite(Str(hint, "url")); if (code != "") result.Add(new Dictionary<string, object> { { "id", Str(hint, "id") }, { "url", code } }); } catch { } } return result.ToArray(); }
    static async Task<Uri> PeerUri(string text) { string address = text != null && text.Trim().StartsWith("YL1.", StringComparison.Ordinal) ? DecodeInvite(text) : text; var uri = new Uri(CanonicalEndpoint(address)); var ips = await Dns.GetHostAddressesAsync(uri.Host); if (ips.Length == 0 || ips.Any(ip => !Private(ip))) throw new Exception("邀请码只支持内网或本机直连"); return uri; }
    static async Task<object> Fetch(Uri peer, string path, object data) {
      var request = (HttpWebRequest)WebRequest.Create(new Uri(peer, path)); request.Proxy = null; request.AllowAutoRedirect = false; request.Timeout = 15000; request.ReadWriteTimeout = 15000;
      using (var deadline = new CancellationTokenSource(15000)) using (deadline.Token.Register(() => request.Abort())) {
      if (data != null) { request.Method = "POST"; request.ContentType = "application/json"; var bytes = Encoding.UTF8.GetBytes(Encode(data)); request.ContentLength = bytes.Length; using (var output = await request.GetRequestStreamAsync()) await output.WriteAsync(bytes, 0, bytes.Length); }
      WebResponse reply;
      try { reply = await request.GetResponseAsync(); }
      catch (WebException ex) { if (ex.Response == null) throw; reply = ex.Response; }
      using (var response = reply) using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Json().DeserializeObject(await reader.ReadToEndAsync());
      }
    }
    static string RouteUrl(Uri peer) { try { var ip = Dns.GetHostAddresses(peer.Host).First(a => a.AddressFamily == AddressFamily.InterNetwork); using (var route = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)) { route.Connect(new IPEndPoint(ip, peer.Port)); return "http://" + ((IPEndPoint)route.LocalEndPoint).Address + ":" + Port; } } catch { return Published; } }
    static object Status() { return new { ok = true, version = "0.1.0", clients = Clients.Values.Where(c => c.Active).Select(c => new { id = c.Id, nick = c.Nick, peers = c.Peers, url = Invite(Published) }).ToArray(), hints = InviteHints(Clients.Values.Where(c => c.Active).SelectMany(c => c.Hints).Take(20).ToArray()) }; }
    static async Task Handle(TcpClient socket) {
      using (socket) using (var stream = socket.GetStream()) try {
        var r = await Read(stream, ((IPEndPoint)socket.Client.RemoteEndPoint).Address);
        if (r.Path == "/health" && r.Method == "GET") { await J(stream, 200, new { ok = true, name = "tide", version = "0.1.0" }); return; }
        if (r.Path == "/status" && r.Method == "GET") { await J(stream, 200, Status()); return; }
        if (r.Path == "/invite" && r.Method == "GET") { await J(stream, 200, new { invite = RequestInvite(r) }); return; }
        if (r.Path == "/local/meta" && r.Method == "GET") { if (!Local(r)) { await J(stream, 403, new { ok = false }); return; } await J(stream, 200, new { token = Token, url = Invite(Published), urls = Urls.Select(url => Invite(url)).ToArray(), joinUrl = JoinUrl, version = "0.1.0" }); return; }
        if (r.Path == "/local/events" && r.Method == "GET") {
          var query = System.Web.HttpUtility.ParseQueryString(r.Query); Client client;
          if (!Local(r) || query["token"] != Token || !Clients.TryGetValue(query["node"], out client)) { await J(stream, 403, new { ok = false }); return; }
          int generation = Interlocked.Increment(ref client.Generation); client.Active = true;
          var header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n"); await stream.WriteAsync(header, 0, header.Length);
          try { int loops = 0; while (Running && generation == client.Generation && client.Active) { string message; if (client.Queue.TryDequeue(out message)) { var bytes = Encoding.UTF8.GetBytes("data: " + message + "\n\n"); await stream.WriteAsync(bytes, 0, bytes.Length); } else if (++loops % 60 == 0) { var ping = Encoding.ASCII.GetBytes(": heartbeat\n\n"); await stream.WriteAsync(ping, 0, ping.Length); } await Task.Delay(250); } } finally { if (generation == client.Generation) client.Active = false; } return;
        }
        if (r.Path.StartsWith("/local/") && r.Method == "POST") {
          var body = Parse(r.Body); if (!Authorized(r, body)) { await J(stream, 403, new { ok = false, error = "本地通道未授权" }); return; }
          string id = Str(body, "node"); Client client;
          if (r.Path == "/local/register") { string actor = Str(body, "actor"); if (id.Length != 36 || Str(body, "nick").Length > 30 || (actor != "" && (!System.Text.RegularExpressions.Regex.IsMatch(actor, "^[0-9a-f]{64}$") || !id.StartsWith(actor.Substring(0, 16) + "-", StringComparison.Ordinal)))) throw new Exception("标识无效"); Clients[id] = new Client { Id = id, Nick = Str(body, "nick"), Actor = actor, Updated = DateTime.UtcNow }; await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/presence") { if (Clients.TryGetValue(id, out client)) { client.Peers = Math.Max(0, Math.Min(16, Int(body, "peers"))); client.Updated = DateTime.UtcNow; if (body.ContainsKey("hints")) { var list = body["hints"] as System.Collections.IEnumerable; if (list != null && !(body["hints"] is string)) client.Hints = InviteHints(list.Cast<object>().Take(12).ToArray()); } } await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/unregister") { if (Clients.TryGetValue(id, out client)) { Interlocked.Increment(ref client.Generation); client.Active = false; } await J(stream, 200, new { ok = true }); return; }
          if (r.Path == "/local/probe") { var uri = await PeerUri(Str(body, "url")); await J(stream, 200, await Fetch(uri, "/status", null)); return; }
          if (r.Path == "/local/relay") { var uri = await PeerUri(Str(body, "url")); var signal = body["signal"] as IDictionary<string, object>; if (signal == null || Str(signal, "from") != id) throw new Exception("信令无效"); signal["fromUrl"] = Invite(RouteUrl(uri)); await J(stream, 200, await Fetch(uri, "/signal", signal)); return; }
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
        if (r.Path == "/download.zip" && r.Method == "GET") { await Reply(stream, 200, MakePackage(RequestInvite(r)), "application/zip", "Content-Disposition: attachment; filename=Tide-0.1.0.zip\r\n"); return; }
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
        var exe = Process.GetCurrentProcess().MainModule.FileName; var entry = archive.CreateEntry("鱼来.exe"); using (var stream = entry.Open()) { var bytes = File.ReadAllBytes(exe); stream.Write(bytes, 0, bytes.Length); }
        foreach (var file in Directory.GetFiles(Www, "*", SearchOption.AllDirectories)) { var item = archive.CreateEntry("www/" + file.Substring(Www.Length + 1).Replace('\\', '/'), CompressionLevel.Optimal); using (var stream = item.Open()) { var bytes = File.ReadAllBytes(file); stream.Write(bytes, 0, bytes.Length); } }
        var readme = archive.CreateEntry("使用说明.txt"); using (var writer = new StreamWriter(readme.Open(), new UTF8Encoding(true))) writer.Write("鱼来 0.1.0\r\n解压整个文件夹，双击 鱼来.exe。\r\n浏览器进入固定本地地址 http://127.0.0.1:39241。\r\n支持 Chrome、Edge 和 Firefox。\r\n包内带有下载者的邀请码，自动尝试配对；也可在游戏中粘贴同事的邀请码。\r\n关闭游戏页即退出世界，托盘右键可退出启动器。\r\n世界数据仅保存在浏览器，请按需导出身份和记忆备份。\r\n");
      } return memory.ToArray(); }
    }
  }
}

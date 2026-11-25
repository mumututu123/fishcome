package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type hint struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

type client struct {
	id, nick, actor string
	peers           int
	hints           []hint
	queue           chan []byte
	stream          chan struct{}
}

type clientStatus struct {
	ID    string `json:"id"`
	Nick  string `json:"nick"`
	Peers int    `json:"peers"`
	URL   string `json:"url"`
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func failure(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]any{"ok": false, "error": message})
}

func stringField(body map[string]any, key string) string {
	result, _ := body[key].(string)
	return result
}

func parseBody(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	if len(r.TransferEncoding) != 0 {
		return nil, errors.New("不支持分块请求")
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
	if err != nil {
		return nil, errors.New("请求体积过大或读取失败")
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil || body == nil {
		return nil, errors.New("请求内容无效")
	}
	return body, nil
}

func remoteIP(r *http.Request) net.IP {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return net.ParseIP(host)
}

func (app *launcher) local(r *http.Request) bool {
	port := strconv.Itoa(app.cfg.port)
	address := "127.0.0.1:" + port
	localhost := "localhost:" + port
	origin := r.Header.Get("Origin")
	return remoteIP(r).IsLoopback() &&
		(strings.EqualFold(r.Host, address) || strings.EqualFold(r.Host, localhost)) &&
		(origin == "" || origin == "http://"+address || origin == "http://"+localhost)
}

func (app *launcher) authorized(r *http.Request, token string) bool {
	return app.local(r) && subtle.ConstantTimeCompare([]byte(token), []byte(app.token)) == 1
}

func (app *launcher) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.URL.Path != "/local/events" || r.Method != http.MethodGet {
		w.Header().Set("Connection", "close")
	}
	switch {
	case r.Method == http.MethodGet:
		app.get(w, r)
	case r.Method == http.MethodPost && (strings.HasPrefix(r.URL.Path, "/local/") || r.URL.Path == "/signal"):
		body, err := parseBody(w, r)
		if err != nil {
			failure(w, http.StatusBadRequest, err.Error())
			return
		}
		if r.URL.Path == "/signal" {
			app.signal(w, r, body)
			return
		}
		if !app.authorized(r, stringField(body, "token")) {
			failure(w, http.StatusForbidden, "本地通道未授权")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/local/update/") {
			app.update.handle(w, r, body)
			return
		}
		app.localAction(w, r, body)
	default:
		failure(w, http.StatusBadRequest, "请求无效")
	}
}

func (app *launcher) get(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health":
		nonce, ready, failed := app.update.health()
		w.Header().Set("Cache-Control", "no-store")
		respond(w, http.StatusOK, map[string]any{
			"ok": true, "name": "tide", "version": version, "rulesVersion": app.rulesVersion,
			"rules": app.rules, "handoffNonce": nonce, "handoffReady": ready, "handoffFailed": failed,
		})
	case "/status":
		app.status(w)
	case "/local/meta":
		if !app.local(r) {
			failure(w, http.StatusForbidden, "本地通道未授权")
			return
		}
		urls := make([]string, 0, len(app.urls))
		for _, address := range app.urls {
			code, _ := encodeInvite(address, "")
			urls = append(urls, code)
		}
		w.Header().Set("Cache-Control", "no-store")
		respond(w, http.StatusOK, map[string]any{
			"token": app.token, "url": urls[0], "urls": urls, "joinUrl": app.joinURL,
			"version": version, "rulesVersion": app.rulesVersion, "rules": app.rules, "assetSuffix": assetSuffix(),
		})
	case "/local/events":
		app.events(w, r)
	case "/invite", "/download.zip":
		if r.URL.Path == "/download.zip" && !app.update.available() {
			failure(w, http.StatusServiceUnavailable, "启动器正在更新交接中，请稍后再试")
			return
		}
		code, err := app.requestInvite(r.URL.Query().Get("invite"))
		if err != nil {
			failure(w, http.StatusBadRequest, err.Error())
			return
		}
		if r.URL.Path == "/invite" {
			respond(w, http.StatusOK, map[string]string{"invite": code, "assetSuffix": assetSuffix()})
			return
		}
		data, err := app.downloadPackage(code)
		if err != nil {
			failure(w, http.StatusBadRequest, "暂时无法创建启动包")
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename="+packageName(version))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
	default:
		app.static(w, r)
	}
}

func (app *launcher) static(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if r.URL.Path == "/" {
		name = "welcome.html"
		if remoteIP(r).IsLoopback() {
			name = "index.html"
		}
	}
	if !filepath.IsLocal(name) || strings.ContainsAny(name, "\\:\x00") {
		failure(w, http.StatusBadRequest, "路径无效")
		return
	}
	file, err := os.OpenInRoot(app.www, filepath.FromSlash(name))
	if err != nil {
		failure(w, http.StatusNotFound, "找不到网页资源")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		failure(w, http.StatusNotFound, "找不到网页资源")
		return
	}
	contentType := map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
	}[strings.ToLower(filepath.Ext(name))]
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func (app *launcher) publishedInvite() string {
	app.clientsMu.Lock()
	var selected *client
	for _, candidate := range app.clients {
		if candidate.stream != nil && candidate.actor != "" && (selected == nil || candidate.id < selected.id) {
			selected = candidate
		}
	}
	actor := ""
	if selected != nil {
		actor = selected.actor
	}
	app.clientsMu.Unlock()
	code, _ := encodeInvite(app.published, actor)
	return code
}

func (app *launcher) requestInvite(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return app.publishedInvite(), nil
	}
	code, err := normalizeInvite(raw)
	if err != nil {
		return "", err
	}
	endpoint, err := decodeInvite(code)
	if err != nil {
		return "", err
	}
	if !slices.Contains(app.urls, endpoint) {
		return "", errors.New("邀请码不属于此入口")
	}
	return code, nil
}

func (app *launcher) collectStatus() ([]clientStatus, []hint) {
	app.clientsMu.Lock()
	defer app.clientsMu.Unlock()
	return app.collectStatusLocked()
}

func (app *launcher) collectStatusLocked() ([]clientStatus, []hint) {
	code, _ := encodeInvite(app.published, "")
	clients := make([]clientStatus, 0, len(app.clients))
	hints := make([]hint, 0)
	for _, client := range app.clients {
		if client.stream == nil {
			continue
		}
		clients = append(clients, clientStatus{ID: client.id, Nick: client.nick, Peers: client.peers, URL: code})
		count := min(20-len(hints), len(client.hints))
		hints = append(hints, client.hints[:count]...)
	}
	return clients, hints
}

func (app *launcher) status(w http.ResponseWriter) {
	clients, hints := app.collectStatus()
	respond(w, http.StatusOK, map[string]any{
		"ok": true, "version": version, "rulesVersion": app.rulesVersion, "rules": app.rules,
		"clients": clients, "hints": hints, "assetSuffix": assetSuffix(),
	})
}

func (client *client) closeStream() {
	if client.stream != nil {
		close(client.stream)
		client.stream = nil
	}
}

func (app *launcher) events(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	if !app.authorized(r, query.Get("token")) {
		failure(w, http.StatusForbidden, "本地通道未授权")
		return
	}
	app.clientsMu.Lock()
	client := app.clients[query.Get("node")]
	if client == nil {
		app.clientsMu.Unlock()
		failure(w, http.StatusForbidden, "本地通道未授权")
		return
	}
	client.closeStream()
	stream := make(chan struct{})
	client.stream = stream
	app.clientsMu.Unlock()
	defer func() {
		app.clientsMu.Lock()
		defer app.clientsMu.Unlock()
		if client.stream == stream {
			client.closeStream()
		}
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	controller := http.NewResponseController(w)
	send := func(message string) error {
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		defer controller.SetWriteDeadline(time.Time{})
		if _, err := io.WriteString(w, message); err != nil {
			return err
		}
		return controller.Flush()
	}
	if send(": ready\n\n") != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-stream:
			return
		case data := <-client.queue:
			if send("data: "+string(data)+"\n\n") != nil {
				return
			}
		case <-heartbeat.C:
			if send(": heartbeat\n\n") != nil {
				return
			}
		}
	}
}

func nicknameLength(nick string) int {
	return len(utf16.Encode([]rune(nick)))
}

func normalizeHints(values any) []hint {
	entries, _ := values.([]any)
	result := make([]hint, 0)
	for _, item := range entries[:min(12, len(entries))] {
		raw, _ := item.(map[string]any)
		code, err := normalizeInvite(stringField(raw, "url"))
		if err == nil && code != "" {
			result = append(result, hint{ID: stringField(raw, "id"), URL: code})
		}
	}
	return result
}

func (app *launcher) localAction(w http.ResponseWriter, r *http.Request, body map[string]any) {
	id := stringField(body, "node")
	switch r.URL.Path {
	case "/local/register":
		actor, nick := stringField(body, "actor"), stringField(body, "nick")
		if len(id) != 36 || nicknameLength(nick) > 30 ||
			(actor != "" && (!actorID.MatchString(actor) || !strings.HasPrefix(id, actor[:16]+"-"))) {
			failure(w, http.StatusBadRequest, "标识无效")
			return
		}
		app.clientsMu.Lock()
		if old := app.clients[id]; old != nil {
			old.closeStream()
		}
		app.clients[id] = &client{id: id, actor: actor, nick: nick, queue: make(chan []byte, 32)}
		app.clientsMu.Unlock()
	case "/local/presence":
		peers, _ := body["peers"].(float64)
		app.clientsMu.Lock()
		if client := app.clients[id]; client != nil {
			client.peers = int(max(0, min(16, peers)))
			if hints, ok := body["hints"]; ok {
				client.hints = normalizeHints(hints)
			}
		}
		app.clientsMu.Unlock()
	case "/local/unregister":
		app.clientsMu.Lock()
		if client := app.clients[id]; client != nil {
			client.closeStream()
			delete(app.clients, id)
		}
		app.clientsMu.Unlock()
	case "/local/probe", "/local/relay":
		app.contactPeer(w, r, body, id)
		return
	default:
		failure(w, http.StatusNotFound, "找不到本地接口")
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (app *launcher) contactPeer(w http.ResponseWriter, r *http.Request, body map[string]any, id string) {
	peer, err := resolvePeer(r.Context(), stringField(body, "url"))
	if err != nil {
		failure(w, http.StatusBadRequest, err.Error())
		return
	}
	route := "/status"
	var data any
	if r.URL.Path == "/local/relay" {
		signal, _ := body["signal"].(map[string]any)
		if signal == nil || stringField(signal, "from") != id {
			failure(w, http.StatusBadRequest, "信令无效")
			return
		}
		signal["fromUrl"], _ = encodeInvite(app.routeURL(peer), "")
		route, data = "/signal", signal
	}
	result, err := peer.fetch(r.Context(), route, data)
	if err != nil {
		failure(w, http.StatusBadRequest, err.Error())
		return
	}
	respond(w, http.StatusOK, result)
}

func (app *launcher) signal(w http.ResponseWriter, r *http.Request, body map[string]any) {
	sender, err := resolvePeer(r.Context(), stringField(body, "fromUrl"))
	if err != nil {
		failure(w, http.StatusBadRequest, err.Error())
		return
	}
	remote := remoteIP(r)
	if !sender.IP.Equal(remote) && !(sender.IP.IsLoopback() && remote.IsLoopback()) {
		failure(w, http.StatusForbidden, "信令地址不匹配")
		return
	}
	to, kind := stringField(body, "to"), stringField(body, "type")
	app.clientsMu.Lock()
	client := app.clients[to]
	if to == "" {
		for _, candidate := range app.clients {
			if candidate.stream != nil && candidate.peers < 8 &&
				(client == nil || candidate.peers < client.peers || (candidate.peers == client.peers && candidate.id < client.id)) {
				client = candidate
			}
		}
	}
	if client == nil || client.stream == nil || (kind == "offer" && client.peers >= 8) || len(client.queue) == cap(client.queue) {
		_, hints := app.collectStatusLocked()
		app.clientsMu.Unlock()
		respond(w, http.StatusConflict, map[string]any{"ok": false, "error": "此入口暂时没有配对空位", "hints": hints})
		return
	}
	if (kind != "offer" && kind != "answer" && kind != "reject") ||
		len(stringField(body, "connection")) != 36 || len(stringField(body, "from")) != 36 {
		app.clientsMu.Unlock()
		failure(w, http.StatusBadRequest, "信令格式无效")
		return
	}
	body["fromUrl"], _ = encodeInvite(sender.URL.String(), "")
	data, _ := json.Marshal(body)
	client.queue <- data
	app.clientsMu.Unlock()
	respond(w, http.StatusOK, map[string]any{"ok": true, "to": client.id})
}

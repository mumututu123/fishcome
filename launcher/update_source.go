package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func numericCompare(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

func compareVersions(a, b string) (int, error) {
	x, y := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	if x == nil || y == nil {
		return 0, errors.New("发行版本号无效")
	}
	for i := 1; i <= 3; i++ {
		if c := numericCompare(x[i], y[i]); c != 0 {
			return c, nil
		}
	}
	if x[4] == y[4] {
		return 0, nil
	}
	if x[4] == "" {
		return 1, nil
	}
	if y[4] == "" {
		return -1, nil
	}
	left, right := strings.Split(x[4], "."), strings.Split(y[4], ".")
	for i := 0; i < len(left) && i < len(right); i++ {
		l, r := left[i], right[i]
		if l == r {
			continue
		}
		ln, rn := strings.Trim(l, "0123456789") == "", strings.Trim(r, "0123456789") == ""
		switch {
		case ln && rn:
			return numericCompare(l, r), nil
		case ln:
			return -1, nil
		case rn:
			return 1, nil
		default:
			return strings.Compare(l, r), nil
		}
	}
	return len(left) - len(right), nil
}

type updateSource struct {
	kind, version, label string
	url                  *url.URL
	loopback             bool
}

func githubSource(input string, loopback bool) (updateSource, error) {
	u, err := url.Parse(strings.TrimSpace(input))
	if err != nil || u.Host == "" || u.User != nil {
		return updateSource{}, errors.New("GitHub Release 链接格式无效")
	}
	local := loopback && u.Scheme == "http" && u.Hostname() == "127.0.0.1"
	if !local && !(u.Scheme == "https" && strings.EqualFold(u.Hostname(), "github.com") && (u.Port() == "" || u.Port() == "443")) {
		return updateSource{}, errors.New("仅支持 https://github.com 的发行版链接")
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(u.Path, "/"), "/"), "/")
	if len(parts) < 5 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." || parts[2] != "releases" {
		return updateSource{}, errors.New("请粘贴具体的 GitHub Release 页面链接或本平台便携包直链")
	}
	tag := parts[4]
	if len(tag) < 2 || (tag[0] != 'v' && tag[0] != 'V') || !versionPattern.MatchString(tag[1:]) || strings.Contains(tag, "+") {
		return updateSource{}, errors.New("发行版链接中的版本号无效")
	}
	v := tag[1:]
	u.RawPath, u.RawQuery, u.Fragment = "", "", ""
	u.Path = "/" + strings.Join(parts, "/")
	src := updateSource{kind: "github", version: v, label: u.String(), url: u, loopback: local}
	switch {
	case parts[3] == "tag" && len(parts) == 5:
		u.Path = fmt.Sprintf("/%s/%s/releases/download/%s/%s", parts[0], parts[1], tag, packageName(v))
	case parts[3] == "download" && len(parts) == 6 && parts[5] == packageName(v):
	default:
		return updateSource{}, errors.New("发布包的版本或平台与当前启动器不一致")
	}
	return src, nil
}

func (u *updater) source(ctx context.Context, kind, input string) (updateSource, error) {
	if kind == "github" {
		return githubSource(input, u.app.cfg.loopback)
	}
	if kind != "peer" {
		return updateSource{}, errors.New("不支持的更新来源")
	}
	peer, err := resolvePeer(ctx, input)
	if err != nil {
		return updateSource{}, err
	}
	status, err := peer.fetch(ctx, "/status", nil)
	if err != nil {
		return updateSource{}, err
	}
	if status["ok"] != true {
		return updateSource{}, errors.New("无法读取同事的版本信息")
	}
	v := stringField(status, "version")
	if v == "" {
		return updateSource{}, errors.New("同事版本过旧，不支持热更新")
	}
	target := stringField(status, "assetSuffix")
	if target == "" {
		target = "windows"
	}
	if target != assetSuffix() {
		return updateSource{}, errors.New("同事的便携包不适用于本机平台")
	}
	inv := strings.TrimSpace(input)
	if !strings.HasPrefix(strings.ToUpper(inv), "YL1.") {
		inv, _ = encodeInvite(peer.URL.String(), "")
	}
	tail := inv
	if len(tail) > 6 {
		tail = tail[len(tail)-6:]
	}
	nicks := make(map[string]bool)
	var nick string
	clients, _ := status["clients"].([]any)
	for _, c := range clients {
		client, _ := c.(map[string]any)
		name := strings.TrimSpace(stringField(client, "nick"))
		if name != "" {
			nicks[name] = true
			if nick == "" {
				nick = name
			}
		}
	}
	if len(nicks) > 1 {
		nick += fmt.Sprintf(" 等 %d 人", len(nicks))
	}
	if nick != "" {
		nick += " · "
	}
	label := "局域网同事（" + nick + "码尾 …" + tail + "）"
	download := &url.URL{Scheme: "http", Host: net.JoinHostPort(peer.IP.String(), peer.URL.Port()), Path: "/download.zip"}
	return updateSource{kind: "peer", version: v, label: label, url: download}, nil
}

const maxUpdateBytes = 64 << 20
const maxExtractBytes = 128 << 20

func (src updateSource) download(ctx context.Context, progress func(int64, int64)) ([]byte, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	defer tr.CloseIdleConnections()
	if src.kind == "peer" || src.loopback {
		tr.Proxy = nil
	} else {
		tr.Proxy = func(req *http.Request) (*url.URL, error) {
			proxy, err := http.ProxyFromEnvironment(req)
			if err == nil && proxy != nil {
				_, err = publicReleaseIPs(req.Context(), req.URL.Hostname())
			}
			return proxy, err
		}
		tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if !githubDownloadHost(host) {
				return (&net.Dialer{}).DialContext(ctx, network, addr)
			}
			ips, err := publicReleaseIPs(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				var c net.Conn
				c, err = (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				if err == nil {
					return c, nil
				}
			}
			return nil, err
		}
	}
	client := http.Client{Transport: tr, Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		switch {
		case src.kind == "peer":
			return http.ErrUseLastResponse
		case len(via) > 5:
			return errors.New("更新包下载重定向次数过多")
		case src.loopback && req.URL.Scheme == "http" && req.URL.Host == src.url.Host && req.URL.User == nil:
			return nil
		case !src.loopback && req.URL.Scheme == "https" && (req.URL.Port() == "" || req.URL.Port() == "443") && req.URL.User == nil && githubDownloadHost(req.URL.Hostname()):
			return nil
		default:
			return errors.New("更新包下载重定向地址无效")
		}
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", src.url.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "fishcome-launcher/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载更新包失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("更新包下载失败（HTTP " + strconv.Itoa(resp.StatusCode) + "）")
	}
	if resp.ContentLength > maxUpdateBytes {
		return nil, errors.New("更新包体积超过限制")
	}
	var data bytes.Buffer
	progress(0, resp.ContentLength)
	buf := make([]byte, 64<<10)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if data.Len()+n > maxUpdateBytes {
				return nil, errors.New("更新包体积超过限制")
			}
			data.Write(buf[:n])
			progress(int64(data.Len()), resp.ContentLength)
		}
		if readErr == io.EOF {
			return data.Bytes(), nil
		}
		if readErr != nil {
			return nil, readErr
		}
	}
}

func githubDownloadHost(host string) bool {
	host = strings.ToLower(host)
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func publicReleaseIPs(ctx context.Context, host string) ([]net.IPAddr, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("无法解析 GitHub 下载地址")
	}
	for _, ip := range ips {
		if !ip.IP.IsGlobalUnicast() || ip.IP.IsPrivate() || localPeerIP(ip.IP) {
			return nil, errors.New("更新包下载目标不能指向内网地址")
		}
	}
	return ips, nil
}

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var actorID = regexp.MustCompile("^[a-f0-9]{64}$")
var inviteInvalid = errors.New("邀请码无效或不完整，请重新复制")
var inviteEndpointInvalid = errors.New("邀请码中的接入信息无效")
var peerUnavailable = errors.New("邀请码暂时无法连接，请确认同事在线且网络可达")

type inviteData struct {
	URL   string `json:"url"`
	Actor string `json:"actor"`
}

func newToken() string {
	var secret [32]byte
	rand.Read(secret[:])
	return base64.RawURLEncoding.EncodeToString(secret[:])
}

func canonicalEndpoint(text string) (*url.URL, error) {
	if len(text) > 512 {
		return nil, inviteEndpointInvalid
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Hostname() == "" {
		return nil, inviteEndpointInvalid
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1024 || port > 65535 {
		return nil, inviteEndpointInvalid
	}
	return &url.URL{Scheme: "http", Host: net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(port))}, nil
}

func encodeInvite(raw, actor string) (string, error) {
	endpoint, err := canonicalEndpoint(raw)
	if err != nil {
		return "", err
	}
	address := endpoint.String()
	payload := []byte(address)
	if actor != "" {
		if !actorID.MatchString(actor) {
			return "", errors.New("邀请码的发码账号无效")
		}
		payload, _ = json.Marshal(inviteData{URL: address, Actor: actor})
	}
	sum := sha256.Sum256(append([]byte("fish-invite-v1:"), payload...))
	return "YL1." + base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sum[:8]), nil
}

func withoutSpace(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, text)
}

func decodeInvite(code string) (string, error) {
	if len(code) > 1024 {
		return "", inviteInvalid
	}
	code = withoutSpace(code)
	parts := strings.Split(code, ".")
	if len(parts) != 3 || parts[0] != "YL1" {
		return "", inviteInvalid
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !utf8.Valid(data) {
		return "", inviteInvalid
	}
	raw, actor := string(data), ""
	if strings.HasPrefix(raw, "{") {
		var parsed inviteData
		if err := json.Unmarshal(data, &parsed); err != nil || parsed.Actor == "" {
			return "", inviteInvalid
		}
		raw, actor = parsed.URL, parsed.Actor
	}
	reencoded, err := encodeInvite(raw, actor)
	if err != nil || reencoded != code {
		return "", inviteInvalid
	}
	return raw, nil
}

func normalizeInvite(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if !strings.HasPrefix(raw, "YL1.") {
		return encodeInvite(raw, "")
	}
	if _, err := decodeInvite(raw); err != nil {
		return "", err
	}
	return withoutSpace(raw), nil
}

func loadJoin(root string, readOnly bool) string {
	path := filepath.Join(root, "join.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var data map[string]any
	if json.Unmarshal(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}), &data) != nil {
		return ""
	}
	value := stringField(data, "invite")
	if value == "" {
		value = stringField(data, "url")
	}
	invite, _ := normalizeInvite(value)
	if _, legacy := data["url"]; legacy && invite != "" && !readOnly {
		replacement, _ := json.Marshal(map[string]string{"invite": invite})
		_ = os.WriteFile(path, replacement, 0600)
	}
	return invite
}

type peerEndpoint struct {
	URL *url.URL
	IP  net.IP
}

func resolvePeer(ctx context.Context, raw string) (peerEndpoint, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "YL1.") {
		var err error
		raw, err = decodeInvite(raw)
		if err != nil {
			return peerEndpoint{}, err
		}
	}
	endpoint, err := canonicalEndpoint(raw)
	if err != nil {
		return peerEndpoint{}, err
	}
	resolveCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(resolveCtx, "ip", endpoint.Hostname())
	if err != nil || len(ips) == 0 {
		return peerEndpoint{}, peerUnavailable
	}
	for _, ip := range ips {
		if !localPeerIP(ip) {
			return peerEndpoint{}, errors.New("邀请码只支持内网或本机直连")
		}
	}
	pinned := ips[0]
	for _, ip := range ips {
		if ip.To4() != nil {
			pinned = ip
			break
		}
	}
	endpoint.Host = net.JoinHostPort(pinned.String(), endpoint.Port())
	return peerEndpoint{URL: endpoint, IP: pinned}, nil
}

func localPeerIP(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	v := ip.To4()
	return v != nil && (ip.IsPrivate() || ip.IsLinkLocalUnicast() || (v[0] == 100 && v[1] >= 64 && v[1] <= 127))
}

var peerHTTPClient = &http.Client{
	Transport:     &http.Transport{},
	Timeout:       15 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (peer peerEndpoint) fetch(ctx context.Context, route string, body any) (map[string]any, error) {
	endpoint := *peer.URL
	endpoint.Path = route
	method := http.MethodGet
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader, method = bytes.NewReader(data), http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return nil, err
	}
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := peerHTTPClient.Do(req)
	if err != nil {
		return nil, peerUnavailable
	}
	defer response.Body.Close()
	const maxStatusBytes = 256 * 1024
	data, err := io.ReadAll(io.LimitReader(response.Body, maxStatusBytes+1))
	if err != nil {
		return nil, peerUnavailable
	}
	if len(data) > maxStatusBytes {
		return nil, errors.New("对端响应体积过大")
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return nil, peerUnavailable
	}
	return result, nil
}

func localURLs(cfg config) []string {
	if cfg.loopback {
		return inviteEndpoints(cfg.port, nil)
	}
	ips := []net.IP{sourceIP("192.0.2.1:9")}
	interfaces, _ := net.Interfaces()
	for _, nic := range interfaces {
		if nic.Flags&net.FlagUp == 0 || nic.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addresses, _ := nic.Addrs()
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil {
				ips = append(ips, ip)
			}
		}
	}
	return inviteEndpoints(cfg.port, ips)
}

func inviteEndpoints(port int, ips []net.IP) []string {
	var urls []string
	for _, ip := range ips {
		if ip.To4() == nil || ip.IsLoopback() || !localPeerIP(ip) {
			continue
		}
		candidate := "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(port))
		if !slices.Contains(urls, candidate) {
			urls = append(urls, candidate)
		}
	}
	if len(urls) == 0 {
		return []string{"http://127.0.0.1:" + strconv.Itoa(port)}
	}
	return urls
}

func sourceIP(remote string) net.IP {
	socket, err := net.DialTimeout("udp4", remote, time.Second)
	if err != nil {
		return nil
	}
	defer socket.Close()
	return socket.LocalAddr().(*net.UDPAddr).IP
}

func (app *launcher) routeURL(peer peerEndpoint) string {
	if ip := sourceIP(peer.URL.Host); localPeerIP(ip) {
		return "http://" + net.JoinHostPort(ip.String(), strconv.Itoa(app.cfg.port))
	}
	return app.published
}

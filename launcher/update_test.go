package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPrepareSurvivesPageDisconnect(t *testing.T) {
	const target = "9.0.0"
	peer := &launcher{root: t.TempDir()}
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-ldflags",
		"-X main.version="+target+" -X main.releaseStamp=fishcome-release:"+target+":",
		"-o", filepath.Join(peer.root, executableName()), "../tests/fixtures/crash-launcher.go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build update fixture: %v: %s", err, out)
	}
	if err := os.CopyFS(filepath.Join(peer.root, "www"), os.DirFS("../www")); err != nil {
		t.Fatal(err)
	}
	pkg, err := peer.downloadPackage("")
	if err != nil {
		t.Fatal(err)
	}
	started, resume := make(chan struct{}), make(chan struct{}, 1)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(pkg[:1])
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-resume:
			w.Write(pkg[1:])
		case <-r.Context().Done():
		}
	}))
	defer source.Close()

	app := &launcher{root: t.TempDir(), token: "local-token", ctx: t.Context(), cfg: config{loopback: true}}
	app.update = newUpdater(app)
	disconnected := make(chan struct{})
	local := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/local/update/prepare" {
			context.AfterFunc(r.Context(), func() { close(disconnected) })
		}
		app.ServeHTTP(w, r)
	}))
	app.cfg.port = local.Listener.Addr().(*net.TCPAddr).Port
	local.Start()
	defer local.Close()
	defer close(resume)

	page, disconnect := context.WithCancel(t.Context())
	defer disconnect()
	body := `{"token":"local-token","kind":"github","input":"` + source.URL + `/owner/repo/releases/tag/v` + target + `"}`
	req, err := http.NewRequestWithContext(page, "POST", local.URL+"/local/update/prepare", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		if response, _ := local.Client().Do(req); response != nil {
			response.Body.Close()
		}
	}()
	wait := func(ch <-chan struct{}, event string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatal(event)
		}
	}
	wait(started, "download did not start")
	disconnect()
	wait(disconnected, "prepare request did not disconnect")
	resume <- struct{}{}

	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		response, err := local.Client().Post(local.URL+"/local/update/status", "application/json", strings.NewReader(`{"token":"local-token"}`))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			OK     bool
			Update updateRecord
		}
		err = json.NewDecoder(response.Body).Decode(&body)
		response.Body.Close()
		if err != nil || !body.OK || body.Update.Phase == "failed" {
			t.Fatalf("status after disconnect: %+v, %v", body, err)
		}
		if body.Update.Phase == "ready" && body.Update.TargetVersion == target {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a new page did not see the prepared update")
}

func TestInterruptedInstallRecovery(t *testing.T) {
	for _, committed := range []bool{false, true} {
		want := "old"
		if committed {
			want = "new"
		}
		t.Run(want, func(t *testing.T) {
			root := t.TempDir()
			tx := installTransaction{RollbackDir: filepath.Join(root, ".rollback-"+strings.Repeat("1", 32)), StageDir: filepath.Join(root, ".stage-"+strings.Repeat("1", 32))}
			write := func(dir, name, contents string) {
				t.Helper()
				path := filepath.Join(dir, name)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
					t.Fatal(err)
				}
			}
			write(root, executableName(), want)
			write(root, "www/index.html", "new")
			write(root, "join.json", `{"url":"old","keep":true}`)
			write(tx.RollbackDir, "www/index.html", "old")
			if err := os.Mkdir(tx.StageDir, 0700); err != nil {
				t.Fatal(err)
			}
			if !committed {
				write(tx.StageDir, executableName(), "new")
			}
			journal, err := json.Marshal(tx)
			if err != nil {
				t.Fatal(err)
			}
			write(root, txFile, string(journal))
			for i := 0; i < 2; i++ {
				if err := recoverUpdateAtStartup(root); err != nil {
					t.Fatal(err)
				}
				for path, expected := range map[string]string{executableName(): want, "www/index.html": want, "join.json": `{"url":"old","keep":true}`} {
					actual, err := os.ReadFile(filepath.Join(root, path))
					if err != nil || string(actual) != expected {
						t.Fatalf("%s: %q, %v", path, actual, err)
					}
				}
			}
			for _, p := range []string{tx.StageDir, tx.RollbackDir, filepath.Join(root, txFile)} {
				if _, err := os.Stat(p); !os.IsNotExist(err) {
					t.Fatalf("temporary state left at %s", p)
				}
			}
		})
	}
}

func TestRollbackHealthAfterRestart(t *testing.T) {
	app := &launcher{root: t.TempDir(), ctx: t.Context()}
	const reason = "更新安装失败，已恢复旧版本"
	if err := os.WriteFile(filepath.Join(app.root, ".update-error"), []byte(reason), 0600); err != nil {
		t.Fatal(err)
	}
	app.update = newUpdater(app)
	app.update.initialize()
	checkHealth := func(wantFailed bool) {
		t.Helper()
		w := httptest.NewRecorder()
		app.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
		var h struct{ OK, HandoffReady, HandoffFailed bool }
		if err := json.Unmarshal(w.Body.Bytes(), &h); err != nil || !h.OK || !h.HandoffReady || h.HandoffFailed != wantFailed {
			t.Fatalf("rollback health: %s, %v", w.Body, err)
		}
	}
	checkHealth(true)
	if !app.update.available() || app.update.state.Phase != "failed" || app.update.state.Error != reason {
		t.Fatal("restored launcher did not expose the failed update")
	}
	_, _ = app.update.prepare("github", "invalid")
	checkHealth(false)
}

func TestInstalledExecutableForRecovery(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, legacyWindowsExecutable)
	if err := os.WriteFile(legacy, nil, 0755); err != nil {
		t.Fatal(err)
	}
	got, err := installedExecutable(root)
	if runtime.GOOS == "windows" {
		if err != nil || got != legacy {
			t.Fatalf("legacy install: %s, %v", got, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("non-Windows install selected %q, %v", got, err)
	}
	name := filepath.Join(root, executableName())
	if err := os.WriteFile(name, nil, 0755); err != nil {
		t.Fatal(err)
	}
	if got, err := installedExecutable(root); err != nil || got != name {
		t.Fatalf("standard install: %s, %v", got, err)
	}
}

func TestExitDuringHandoff(t *testing.T) {
	for _, tc := range []struct {
		phase                  string
		ready, failed, canExit bool
	}{
		{"ready", true, false, true},
		{"applying", true, false, false},
		{"idle", false, false, false},
		{"applying", false, true, false},
		{"failed", false, true, true},
		{"failed", true, true, true},
	} {
		u := &updater{state: updateRecord{Phase: tc.phase}, ready: tc.ready, failed: tc.failed}
		if u.canExit() != tc.canExit {
			t.Errorf("canExit for %+v", tc)
		}
	}
}

func TestCancelDownloadingUpdate(t *testing.T) {
	received := make(chan struct{})
	end := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		close(received)
		select {
		case <-r.Context().Done():
		case <-end:
		}
	}))
	defer server.Close()
	defer close(end)
	u := newUpdater(&launcher{cfg: config{loopback: true}, root: t.TempDir(), ctx: t.Context()})
	done := make(chan error, 1)
	go func() {
		_, err := u.prepare("github", server.URL+"/owner/repo/releases/tag/v9.0.0")
		done <- err
	}()
	select {
	case <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("download did not start")
	}
	action := func(route, id string) updateRecord {
		t.Helper()
		res := httptest.NewRecorder()
		u.handle(res, httptest.NewRequest("POST", "/local/update/"+route, nil), map[string]any{"id": id})
		var body struct{ Update updateRecord }
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || res.Code != 200 {
			t.Fatalf("%s: %s", route, res.Body)
		}
		return body.Update
	}
	deadline := time.Now().Add(3 * time.Second)
	state := action("status", "")
	for state.Downloaded == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		state = action("status", "")
	}
	if state.Phase != "downloading" || state.Downloaded != 7 || state.Total != 1000 || state.ID == "" {
		t.Fatalf("download status %+v", state)
	}
	if stale := action("cancel", "expired"); stale.ID != state.ID {
		t.Fatal("stale cancel interrupted the active download")
	}
	if _, err := u.prepare("github", ""); err != errUpdateConflict {
		t.Fatalf("parallel prepare returned %v", err)
	}
	if after := action("cancel", state.ID); after.Phase != "idle" {
		t.Fatalf("cancel state %+v", after)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled download completed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("download still running after cancel")
	}
	if after := action("status", ""); after.Phase != "idle" {
		t.Fatalf("cancelled response overwrote %+v", after)
	}
}

func TestUpdatePlatformSelection(t *testing.T) {
	other := "windows"
	if assetSuffix() == "windows" {
		other = "linux-amd64"
	}
	const target = "9.0.0"
	tag := "https://github.com/owner/fishcome/releases/tag/v" + target
	src, err := githubSource(tag, false)
	if err != nil || filepath.Base(src.url.Path) != packageName(target) {
		t.Fatalf("release tag: %+v %v", src, err)
	}
	wrongLink := "https://github.com/owner/fishcome/releases/download/v" + target + "/fishcome-" + target + "-" + other + ".zip"
	if _, err := githubSource(wrongLink, false); err == nil {
		t.Fatalf("accepted %s", wrongLink)
	}
	for _, tc := range []struct {
		suffix string
		accept bool
	}{
		{assetSuffix(), true}, {other, false}, {"", assetSuffix() == "windows"},
	} {
		t.Run("peer-"+tc.suffix, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				status := map[string]any{"ok": true, "version": target}
				if tc.suffix != "" {
					status["assetSuffix"] = tc.suffix
				}
				json.NewEncoder(w).Encode(status)
			}))
			defer server.Close()
			u := newUpdater(&launcher{})
			src, err := u.source(context.Background(), "peer", server.URL)
			if (err == nil) != tc.accept {
				t.Fatalf("platform %q: %v", tc.suffix, err)
			}
			if tc.accept && (src.version != target || src.url.Path != "/download.zip") {
				t.Fatalf("peer source %+v", src)
			}
		})
	}
}

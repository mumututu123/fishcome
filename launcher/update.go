package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type updateRecord struct {
	Phase              string `json:"phase"`
	ID                 string `json:"id"`
	SourceKind         string `json:"sourceKind"`
	SourceInput        string `json:"sourceInput"`
	SourceLabel        string `json:"sourceLabel"`
	CurrentVersion     string `json:"currentVersion"`
	TargetVersion      string `json:"targetVersion"`
	TargetRulesVersion string `json:"targetRulesVersion"`
	Prerelease         bool   `json:"prerelease"`
	Error              string `json:"error"`
	Downloaded         int64  `json:"downloadedBytes"`
	Total              int64  `json:"totalBytes"`
	stage              string
	cancel             context.CancelFunc
}

type updater struct {
	app           *launcher
	mu            sync.Mutex
	state         updateRecord
	ready, failed bool
}

func idleUpdate() updateRecord {
	return updateRecord{Phase: "idle", CurrentVersion: version, Total: -1}
}

func newUpdater(app *launcher) *updater {
	u := &updater{app: app, state: idleUpdate(), ready: app.cfg.handoffTarget == ""}
	if !u.ready {
		if err := u.claimHandoff(); err != nil {
			u.failed = true
			u.state.Phase, u.state.Error = "failed", err.Error()
		}
	}
	return u
}

func (u *updater) health() (string, bool, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.failed {
		return "", u.ready, true
	}
	return u.app.cfg.handoffNonce, u.ready, u.failed
}

func (u *updater) available() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.ready && u.state.Phase != "applying"
}

func (u *updater) canExit() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return (u.ready || u.failed) && u.state.Phase != "applying"
}

func updateID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(id[:])
}

var errUpdateConflict = errors.New("当前已有更新任务正在进行")

func (u *updater) handle(w http.ResponseWriter, r *http.Request, body map[string]any) {
	var state updateRecord
	var err error
	id := stringField(body, "id")
	switch r.URL.Path {
	case "/local/update/status":
		u.mu.Lock()
		state = u.state
		u.mu.Unlock()
	case "/local/update/prepare":
		state, err = u.prepare(stringField(body, "kind"), stringField(body, "input"))
	case "/local/update/cancel":
		u.mu.Lock()
		prior := u.state
		if prior.Phase == "applying" {
			u.mu.Unlock()
			failure(w, 409, "更新正在切换中，无法取消")
			return
		}
		if id == "" || id == prior.ID {
			if prior.cancel != nil {
				prior.cancel()
			}
			u.state = idleUpdate()
		} else {
			prior.stage = ""
		}
		state = u.state
		u.mu.Unlock()
		if prior.stage != "" {
			os.RemoveAll(prior.stage)
		}
	case "/local/update/apply":
		u.mu.Lock()
		state = u.state
		if !u.ready || state.Phase != "ready" || state.ID != id || !pathExists(filepath.Join(state.stage, executableName())) {
			u.mu.Unlock()
			failure(w, 409, "更新包未就绪或已过期，请重新检查更新")
			return
		}
		u.state.Phase = "applying"
		u.mu.Unlock()
		respond(w, 200, map[string]any{"ok": true, "id": id, "targetVersion": state.TargetVersion})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go u.handoff(state)
		return
	default:
		failure(w, 404, "找不到更新操作")
		return
	}
	if err != nil {
		status := 400
		if errors.Is(err, errUpdateConflict) {
			status = 409
		}
		failure(w, status, err.Error())
		return
	}
	respond(w, 200, map[string]any{"ok": true, "update": state})
}

func (u *updater) prepare(kind, input string) (updateRecord, error) {
	u.mu.Lock()
	if !u.ready || u.state.Phase == "checking" || u.state.Phase == "downloading" || u.state.Phase == "applying" {
		u.mu.Unlock()
		return updateRecord{}, errUpdateConflict
	}
	ctx, cancel := context.WithCancel(u.app.ctx)
	defer cancel()
	oldStage := u.state.stage
	id := updateID()
	u.failed = false
	u.state = idleUpdate()
	u.state.Phase, u.state.ID, u.state.SourceKind, u.state.SourceInput, u.state.cancel = "checking", id, kind, input, cancel
	u.mu.Unlock()
	if oldStage != "" {
		os.RemoveAll(oldStage)
	}

	stage := filepath.Join(u.app.root, ".update-"+id)
	rules, err := u.prepareFiles(ctx, id, kind, input, stage)
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.state.ID != id || ctx.Err() != nil {
		err = errors.New("更新已取消")
	}
	if err != nil {
		os.RemoveAll(stage)
		if u.state.ID == id {
			u.state.Phase, u.state.Error, u.state.cancel = "failed", err.Error(), nil
		}
		return updateRecord{}, err
	}
	u.state.Phase, u.state.stage, u.state.TargetRulesVersion, u.state.cancel = "ready", stage, rules, nil
	return u.state, nil
}

func (u *updater) prepareFiles(ctx context.Context, id, kind, input, stage string) (string, error) {
	src, err := u.source(ctx, kind, input)
	if err != nil {
		return "", err
	}
	cmp, err := compareVersions(src.version, version)
	if err != nil {
		return "", err
	}
	if cmp <= 0 {
		return "", fmt.Errorf("来源版本 %s 不高于当前版本 %s，无需更新", src.version, version)
	}

	u.mu.Lock()
	if u.state.ID != id {
		u.mu.Unlock()
		return "", context.Canceled
	}
	u.state.Phase, u.state.SourceLabel, u.state.TargetVersion = "downloading", src.label, src.version
	u.state.Prerelease = versionPattern.FindStringSubmatch(src.version)[4] != ""
	u.mu.Unlock()
	data, err := src.download(ctx, func(done, total int64) {
		u.mu.Lock()
		defer u.mu.Unlock()
		if u.state.ID == id {
			u.state.Downloaded, u.state.Total = done, total
		}
	})
	if err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = os.Mkdir(stage, 0700); err != nil {
		return "", err
	}
	if err = writeStageOwner(stage); err != nil {
		return "", err
	}
	if err = extractUpdate(ctx, data, stage); err != nil {
		return "", err
	}
	if err = verifyUpdateExecutable(filepath.Join(stage, executableName()), src.version); err != nil {
		return "", err
	}
	_, rules, _ := readRules(filepath.Join(stage, "www"))
	return rules, nil
}

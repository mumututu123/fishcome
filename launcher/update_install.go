package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var stageID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (u *updater) initialize() {
	root := u.app.root
	if u.app.cfg.handoffTarget != "" {
		if _, _, failed := u.health(); failed {
			u.app.exit()
			return
		}
		go u.completeHandoff()
		return
	}
	if msg, err := os.ReadFile(filepath.Join(root, ".update-error")); err == nil {
		u.mu.Lock()
		u.failed = true
		u.state.Phase, u.state.Error = "failed", string(msg)
		u.mu.Unlock()
		os.Remove(filepath.Join(root, ".update-error"))
	}
	_ = withInstallLock(root, func() error {
		cleanupUnusedStages(root)
		return nil
	})
}

func cleanupUnusedStages(root string) {
	entries, _ := os.ReadDir(root)
	pending := pathExists(filepath.Join(root, txFile))
	for _, entry := range entries {
		dir := filepath.Join(root, entry.Name())
		if entry.IsDir() && !pending && (transactionDir(root, dir, ".rollback-") || transactionDir(root, dir, ".stage-")) {
			os.RemoveAll(dir)
			continue
		}
		id, ok := strings.CutPrefix(entry.Name(), ".update-")
		if !ok || !stageID.MatchString(id) || !entry.IsDir() {
			continue
		}
		owner, err := os.ReadFile(filepath.Join(dir, ".owner"))
		if err != nil {
			continue
		}
		pid, err := strconv.Atoi(string(owner))
		if err == nil && pid > 0 && !updateProcessAlive(pid) {
			current, err := os.ReadFile(filepath.Join(dir, ".owner"))
			if err == nil && string(current) == string(owner) {
				os.RemoveAll(dir)
			}
		}
	}
}

func writeStageOwner(dir string) error {
	return os.WriteFile(filepath.Join(dir, ".owner"), []byte(strconv.Itoa(os.Getpid())), 0600)
}

const legacyWindowsExecutable = "潮生.exe"

func installedExecutable(dir string) (string, error) {
	names := []string{executableName()}
	if runtime.GOOS == "windows" {
		names = append(names, legacyWindowsExecutable)
	}
	for _, name := range names {
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err == nil && info.Mode().IsRegular() {
			return path, nil
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("找不到安装目录中的启动器：%w", os.ErrNotExist)
}

func (u *updater) childCommand(exe string, extra ...string) *exec.Cmd {
	cfg := u.app.cfg
	args := []string{"--no-open", "--port", strconv.Itoa(cfg.port)}
	if cfg.headless {
		args = append(args, "--headless")
	}
	if cfg.loopback {
		args = append(args, "--loopback")
	}
	cmd := exec.Command(exe, append(args, extra...)...)
	cmd.Dir = filepath.Dir(exe)
	return cmd
}

func (u *updater) handoff(state updateRecord) {
	nonce := updateID()
	u.app.closeListener()
	cmd := u.childCommand(filepath.Join(state.stage, executableName()), "--handoff-target", u.app.root, "--handoff-parent", strconv.Itoa(os.Getpid()), "--handoff-nonce", nonce)
	err := cmd.Start()
	if err == nil {
		exited := make(chan struct{})
		go func() { cmd.Wait(); close(exited) }()
		if u.childListening(exited, state.TargetVersion, nonce) {
			u.app.exit()
			return
		}
		cmd.Process.Kill()
		<-exited
		err = errors.New("新版本未能接管本地地址")
	}
	os.RemoveAll(state.stage)
	u.mu.Lock()
	u.state.Phase, u.state.stage, u.state.Error = "failed", "", "新版本启动失败，已恢复旧版本："+err.Error()
	u.mu.Unlock()
	if restoreErr := u.app.listen(5 * time.Second); restoreErr != nil {
		u.mu.Lock()
		u.state.Error = "新版本启动失败，旧版本无法重新监听：" + restoreErr.Error()
		u.mu.Unlock()
		log.Print(restoreErr)
	}
}

func (u *updater) childListening(exited <-chan struct{}, target, nonce string) bool {
	deadline := time.NewTimer(15 * time.Second)
	tick := time.NewTicker(100 * time.Millisecond)
	defer deadline.Stop()
	defer tick.Stop()
	address := "http://127.0.0.1:" + strconv.Itoa(u.app.cfg.port) + "/health"
	for {
		select {
		case <-exited:
			return false
		case <-deadline.C:
			return false
		case <-tick.C:
			if childHealthy(address, target, nonce) {
				return true
			}
		}
	}
}

var updateHealthClient = http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func childHealthy(address, target, nonce string) bool {
	res, err := updateHealthClient.Get(address)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var v struct {
		OK, HandoffFailed     bool
		Version, HandoffNonce string
	}
	return res.StatusCode == 200 && json.NewDecoder(io.LimitReader(res.Body, 256<<10)).Decode(&v) == nil && v.OK && !v.HandoffFailed && v.Version == target && v.HandoffNonce == nonce
}

func (u *updater) completeHandoff() {
	app := u.app
	err := u.installAfterParent()
	u.mu.Lock()
	if err == nil {
		u.ready = true
		u.mu.Unlock()
		return
	}
	u.failed = true
	u.state.Phase, u.state.Error = "applying", err.Error()
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.state.Phase = "failed"
		u.mu.Unlock()
	}()
	log.Print(err)
	if updateProcessAlive(app.cfg.handoffParent) {
		app.exit()
		return
	}
	original, e := installedExecutable(app.root)
	if e != nil {
		log.Print(e)
		return
	}
	if e := os.WriteFile(filepath.Join(app.root, ".update-error"), []byte("更新安装失败，已恢复旧版本："+err.Error()), 0600); e != nil {
		log.Print(e)
	}
	app.closeListener()
	cmd := u.childCommand(original)
	if e := cmd.Start(); e == nil {
		cmd.Process.Release()
		app.exit()
	} else {
		log.Print(e)
		if e = app.listen(5 * time.Second); e != nil {
			log.Print(e)
		}
	}
}

func (u *updater) claimHandoff() error {
	app := u.app
	id, ok := strings.CutPrefix(filepath.Base(app.baseDir), ".update-")
	if !ok || !stageID.MatchString(id) || !sameInstallPath(filepath.Dir(app.baseDir), app.root) || app.cfg.handoffParent <= 0 || app.cfg.handoffNonce == "" {
		return errors.New("更新交接目录或参数无效")
	}
	return writeStageOwner(app.baseDir)
}

func (u *updater) installAfterParent() error {
	app := u.app
	deadline := time.Now().Add(17 * time.Second)
	for updateProcessAlive(app.cfg.handoffParent) {
		if time.Now().After(deadline) {
			return errors.New("旧版启动器未能及时退出")
		}
		time.Sleep(75 * time.Millisecond)
	}
	return withInstallLock(app.root, func() error {
		if err := recoverTransaction(app.root); err != nil {
			return err
		}
		if err := installUpdate(app.baseDir, app.root); err != nil {
			return err
		}
		cleanupUnusedStages(app.root)
		return nil
	})
}

func sameInstallPath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

const txFile = ".tx-pending.json"

type installTransaction struct {
	RollbackDir string `json:"rollbackDir"`
	StageDir    string `json:"stageDir,omitempty"`
}

func recoverUpdateAtStartup(root string) error {
	if _, err := os.Lstat(filepath.Join(root, txFile)); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return withInstallLock(root, func() error { return recoverTransaction(root) })
}

func transactionDir(root, path, prefix string) bool {
	id, ok := strings.CutPrefix(filepath.Base(path), prefix)
	if !ok || !stageID.MatchString(id) || !sameInstallPath(root, filepath.Dir(path)) {
		return false
	}
	info, err := os.Lstat(path)
	return errors.Is(err, os.ErrNotExist) || err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func copyUpdateFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0755)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	return errors.Join(err, out.Close())
}

func installUpdate(source, root string) (err error) {
	id := updateID()
	tx := installTransaction{RollbackDir: filepath.Join(root, ".rollback-"+id), StageDir: filepath.Join(root, ".stage-"+id)}
	if err = os.Mkdir(tx.StageDir, 0700); err != nil {
		return err
	}
	journal := filepath.Join(root, txFile)
	defer func() {
		if !pathExists(journal) {
			os.RemoveAll(tx.StageDir)
			os.RemoveAll(tx.RollbackDir)
		}
	}()
	if err = os.Mkdir(tx.RollbackDir, 0700); err != nil {
		return err
	}
	exe := executableName()
	if err = copyUpdateFile(filepath.Join(source, exe), filepath.Join(tx.StageDir, exe)); err != nil {
		return err
	}
	if err = os.CopyFS(filepath.Join(tx.StageDir, "www"), os.DirFS(filepath.Join(source, "www"))); err != nil {
		return err
	}
	legacy := runtime.GOOS == "windows" && pathExists(filepath.Join(root, legacyWindowsExecutable))
	if legacy {
		if err = copyUpdateFile(filepath.Join(source, exe), filepath.Join(tx.StageDir, legacyWindowsExecutable)); err != nil {
			return err
		}
		if err = copyUpdateFile(filepath.Join(root, legacyWindowsExecutable), filepath.Join(tx.RollbackDir, legacyWindowsExecutable)); err != nil {
			return err
		}
	}
	data, err := json.Marshal(tx)
	if err != nil {
		return err
	}
	tmp := filepath.Join(tx.StageDir, "journal")
	if err = os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if err = os.Rename(tmp, journal); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			if restore := recoverTransaction(root); restore != nil {
				err = errors.Join(err, fmt.Errorf("恢复旧版本失败：%w", restore))
			}
		}
	}()
	if pathExists(filepath.Join(root, "www")) {
		if err = os.Rename(filepath.Join(root, "www"), filepath.Join(tx.RollbackDir, "www")); err != nil {
			return err
		}
	}
	if err = os.Rename(filepath.Join(tx.StageDir, "www"), filepath.Join(root, "www")); err != nil {
		return err
	}
	if legacy {
		if err = os.Rename(filepath.Join(tx.StageDir, legacyWindowsExecutable), filepath.Join(root, legacyWindowsExecutable)); err != nil {
			return err
		}
	}
	if err = os.Rename(filepath.Join(tx.StageDir, exe), filepath.Join(root, exe)); err != nil {
		return err
	}
	if err = os.Remove(journal); err != nil {
		log.Print(err)
	}
	return nil
}

func recoverTransaction(root string) error {
	journal := filepath.Join(root, txFile)
	data, err := os.ReadFile(journal)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var tx installTransaction
	if err = json.Unmarshal(data, &tx); err != nil {
		return err
	}
	if !transactionDir(root, tx.RollbackDir, ".rollback-") {
		return errors.New("更新恢复目录无效")
	}
	if tx.StageDir == "" {
		// A C# launcher may have left its move-based journal here.
		for _, name := range []string{executableName(), "www", legacyWindowsExecutable} {
			dst, backup := filepath.Join(root, name), filepath.Join(tx.RollbackDir, name)
			if pathExists(backup) && !pathExists(dst) {
				if err = os.Rename(backup, dst); err != nil {
					return err
				}
			}
		}
	} else {
		if !transactionDir(root, tx.StageDir, ".stage-") {
			return errors.New("更新暂存目录无效")
		}
		if pathExists(filepath.Join(tx.StageDir, executableName())) {
			for _, name := range []string{"www", legacyWindowsExecutable} {
				dst, backup := filepath.Join(root, name), filepath.Join(tx.RollbackDir, name)
				if !pathExists(backup) {
					continue
				}
				if name == legacyWindowsExecutable && pathExists(filepath.Join(tx.StageDir, name)) {
					continue
				}
				if err = os.RemoveAll(dst); err != nil {
					return err
				}
				if err = os.Rename(backup, dst); err != nil {
					return err
				}
			}
		}
	}
	if err = os.Remove(journal); err != nil {
		return err
	}
	os.RemoveAll(tx.RollbackDir)
	if tx.StageDir != "" {
		os.RemoveAll(tx.StageDir)
	}
	return nil
}

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func updateProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return false
	}
	// An orphaned launcher may remain as a zombie until its Linux init process
	// reaps it. At that point all executable and listener handles are released.
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err == nil {
		i := strings.LastIndex(string(stat), ") ")
		if i >= 0 && i+2 < len(stat) && stat[i+2] == 'Z' {
			return false
		}
	}
	return true
}

func withInstallLock(dir string, fn func() error) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	end := time.Now().Add(5 * time.Second)
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return fn()
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) || time.Now().After(end) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

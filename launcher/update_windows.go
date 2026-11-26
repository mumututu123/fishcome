package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

func updateProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return !errors.Is(err, syscall.Errno(87))
	}
	defer syscall.CloseHandle(h)
	wait, err := syscall.WaitForSingleObject(h, 0)
	return err != nil || wait == syscall.WAIT_TIMEOUT
}

var installKernel = syscall.NewLazyDLL("kernel32.dll")
var createInstallMutex = installKernel.NewProc("CreateMutexW")
var releaseInstallMutex = installKernel.NewProc("ReleaseMutex")

func withInstallLock(dir string, fn func() error) error {
	// Use the same named mutex as the C# Windows launcher. A Win32 mutex is
	// owned by an OS thread, including when that thread is running Go code.
	hash := sha256.Sum256([]byte(strings.ToLower(dir)))
	name, err := syscall.UTF16PtrFromString(fmt.Sprintf("Local\\fishcome-install-%X", hash[:12]))
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	h, _, err := createInstallMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return err
	}
	handle := syscall.Handle(h)
	defer syscall.CloseHandle(handle)
	wait, err := syscall.WaitForSingleObject(handle, 5000)
	if err != nil {
		return err
	}
	if wait != syscall.WAIT_OBJECT_0 && wait != syscall.WAIT_ABANDONED {
		return errors.New("其他启动器正在安装更新")
	}
	defer releaseInstallMutex.Call(h)
	return fn()
}

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var shellExecute = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func trayAvailable() bool { return true }

func openBrowser(address string) error {
	target, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return err
	}
	action, _ := syscall.UTF16PtrFromString("open")
	result, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(action)), uintptr(unsafe.Pointer(target)), 0, 0, 1)
	if result <= 32 {
		return errors.New("默认浏览器无法启动")
	}
	return nil
}

func notifyDesktop(message string) {
	title, _ := syscall.UTF16PtrFromString(desktopTitle)
	text, _ := syscall.UTF16PtrFromString(message)
	messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x40)
}

func copyInvite(invite string) error {
	command := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "clip.exe"))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	command.Stdin = strings.NewReader(invite)
	return command.Run()
}

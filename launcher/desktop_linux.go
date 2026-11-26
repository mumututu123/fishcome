package main

import (
	"errors"
	"os"
	"os/exec"
	"strings"

	"github.com/godbus/dbus/v5"
)

func trayAvailable() bool {
	conn, err := dbus.SessionBus()
	return err == nil && conn.Connected()
}

func openBrowser(address string) error {
	return exec.Command("xdg-open", address).Run()
}

func notifyDesktop(message string) {
	_ = exec.Command("notify-send", desktopTitle, message).Run()
}

func copyInvite(invite string) error {
	candidates := [][]string{
		{"xclip", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--input"},
	}
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		candidates = append([][]string{{"wl-copy"}}, candidates...)
	}
	for _, args := range candidates {
		command := exec.Command(args[0], args[1:]...)
		command.Stdin = strings.NewReader(invite)
		if command.Run() == nil {
			return nil
		}
	}
	return errors.New("无法访问系统剪贴板")
}

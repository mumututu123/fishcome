package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"net/url"
	"runtime"
	"strconv"

	"github.com/energye/systray"
)

const desktopTitle = "鱼来 · 鱼元水世界"

func (app *launcher) open() {
	address := "http://127.0.0.1:" + strconv.Itoa(app.cfg.port)
	if app.joinURL != "" {
		address += "/?join=" + url.QueryEscape(app.joinURL)
	}
	if err := openBrowser(address); err != nil {
		log.Printf("无法打开浏览器，请访问 %s：%v", address, err)
	}
}

func runDesktop(app *launcher) {
	if !app.cfg.noOpen {
		go app.open()
	}
	if !trayAvailable() {
		return
	}
	systray.Run(func() {
		systray.SetIcon(trayIcon())
		systray.SetTooltip(desktopTitle)
		systray.SetOnDClick(func(systray.IMenu) { app.open() })
		systray.AddMenuItem("打开鱼来", "").Click(app.open)
		systray.AddMenuItem("复制我的邀请码", "").Click(func() {
			if err := copyInvite(app.publishedInvite()); err != nil {
				notifyDesktop("请在游戏的「连接同事」中复制邀请码。")
				log.Print(err)
			}
		})
		systray.AddMenuItem("退出启动器", "").Click(func() {
			if app.update.canExit() {
				app.exit()
			}
		})
		go func() {
			<-app.ctx.Done()
			systray.Quit()
		}()
	}, app.exit)
}

func notifyPortOccupied(port int) {
	notifyDesktop("固定端口 " + strconv.Itoa(port) + " 已被占用。如果鱼来已经启动，可直接打开本地网页。")
}

func trayIcon() []byte {
	icon := image.NewRGBA(image.Rect(0, 0, 32, 32))
	draw.Draw(icon, icon.Bounds(), image.NewUniform(color.RGBA{11, 51, 86, 255}), image.Point{}, draw.Src)
	glyph := []string{
		" XX     X    ",
		"X  X     X   ",
		"X  X      X  ",
		"X  X       X ",
		"X  X      X  ",
		"X  X     X   ",
		" XX     X    ",
	}
	ink := image.NewUniform(color.RGBA{127, 255, 212, 255})
	for y, line := range glyph {
		for x, c := range line {
			if c == 'X' {
				left, top := 2+x*2, 9+y*2
				draw.Draw(icon, image.Rect(left, top, left+2, top+2), ink, image.Point{}, draw.Src)
			}
		}
	}
	var bitmap bytes.Buffer
	_ = png.Encode(&bitmap, icon)
	if runtime.GOOS != "windows" {
		return bitmap.Bytes()
	}
	header := []byte{0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0}
	binary.LittleEndian.PutUint32(header[14:18], uint32(bitmap.Len()))
	return append(header, bitmap.Bytes()...)
}

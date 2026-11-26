package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

var version = "0.0.0-dev"
var buildRules string

type config struct {
	port                                     int
	loopback, headless, noOpen, printVersion bool
	handoffTarget, handoffNonce              string
	handoffParent                            int
}

type launcher struct {
	cfg                         config
	baseDir, root, www, joinURL string
	rules                       json.RawMessage
	rulesVersion                string
	token, published            string
	urls                        []string

	clientsMu sync.Mutex
	clients   map[string]*client

	listenerMu sync.Mutex
	server     *http.Server
	ctx        context.Context
	exit       context.CancelFunc
	update     *updater
}

func main() {
	cfg := config{}
	flag.IntVar(&cfg.port, "port", 39241, "")
	flag.BoolVar(&cfg.loopback, "loopback", false, "")
	flag.BoolVar(&cfg.headless, "headless", false, "")
	flag.BoolVar(&cfg.noOpen, "no-open", false, "")
	flag.BoolVar(&cfg.printVersion, "print-version", false, "")
	flag.StringVar(&cfg.handoffTarget, "handoff-target", "", "")
	flag.StringVar(&cfg.handoffNonce, "handoff-nonce", "", "")
	flag.IntVar(&cfg.handoffParent, "handoff-parent", 0, "")
	flag.Parse()

	code, err := run(cfg)
	if err != nil {
		log.Print(err)
	}
	if code != 0 {
		os.Exit(code)
	}
}

func run(cfg config) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	baseDir := filepath.Dir(exe)
	if cfg.printVersion {
		_, rulesVersion, err := installedRules(filepath.Join(baseDir, "www"))
		if err != nil {
			return 1, err
		}
		return 0, json.NewEncoder(os.Stdout).Encode(map[string]string{"version": version, "rulesVersion": rulesVersion})
	}
	if cfg.port < 1024 || cfg.port > 65535 {
		return 2, errors.New("端口必须在 1024 到 65535 之间")
	}
	root := baseDir
	if cfg.handoffTarget != "" {
		root, err = filepath.Abs(cfg.handoffTarget)
		if err != nil {
			return 1, err
		}
	} else if err := recoverUpdateAtStartup(root); err != nil {
		return 1, err
	}

	www := filepath.Join(baseDir, "www")
	rules, rulesVersion, err := installedRules(www)
	if err != nil {
		return 1, err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	app := &launcher{
		cfg: cfg, baseDir: baseDir, root: root, www: www, rules: rules, rulesVersion: rulesVersion,
		token: newToken(), urls: localURLs(cfg), clients: make(map[string]*client), ctx: ctx, exit: stop,
	}
	defer app.exit()
	defer app.closeListener()
	app.published = app.urls[0]
	app.joinURL = loadJoin(root, true)
	app.update = newUpdater(app)

	retry := time.Duration(0)
	if cfg.handoffTarget != "" {
		retry = 8 * time.Second
	}
	if err := app.listen(retry); err != nil {
		if !cfg.headless && cfg.handoffTarget == "" {
			notifyPortOccupied(cfg.port)
			app.open()
		}
		return 2, fmt.Errorf("端口 %d 无法监听：%w", cfg.port, err)
	}
	if cfg.handoffTarget == "" {
		loadJoin(root, false)
	}
	app.update.initialize()
	if !cfg.headless {
		runDesktop(app)
	}
	<-ctx.Done()
	return 0, nil
}

func installedRules(www string) (json.RawMessage, string, error) {
	if buildRules == "" {
		return readRules(www)
	}
	raw, err := base64.StdEncoding.DecodeString(buildRules)
	if err != nil {
		return nil, "", err
	}
	return parseRules(raw)
}

func (app *launcher) listen(wait time.Duration) error {
	deadline := time.Now().Add(wait)
	host := "0.0.0.0"
	if app.cfg.loopback {
		host = "127.0.0.1"
	}
	address := net.JoinHostPort(host, strconv.Itoa(app.cfg.port))
	for {
		listener, err := net.Listen("tcp4", address)
		if err == nil {
			server := &http.Server{
				Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
				IdleTimeout: 5 * time.Second, MaxHeaderBytes: 16 * 1024,
				BaseContext: func(net.Listener) context.Context { return app.ctx },
			}
			app.listenerMu.Lock()
			if app.ctx.Err() != nil {
				app.listenerMu.Unlock()
				listener.Close()
				return app.ctx.Err()
			}
			app.server = server
			app.listenerMu.Unlock()
			go func() {
				if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
					log.Print(err)
				}
			}()
			return nil
		}
		if time.Now().After(deadline) || app.ctx.Err() != nil {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (app *launcher) closeListener() {
	app.listenerMu.Lock()
	defer app.listenerMu.Unlock()
	if app.server != nil {
		app.server.Close()
		app.server = nil
	}
}

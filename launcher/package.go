package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

func executableName() string {
	if runtime.GOOS == "windows" {
		return "鱼来.exe"
	}
	return "fishcome"
}

func assetSuffix() string {
	if runtime.GOOS == "windows" && runtime.GOARCH == "amd64" {
		return "windows"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

func packageName(release string) string {
	return "fishcome-" + release + "-" + assetSuffix() + ".zip"
}

var ruleLiteral = regexp.MustCompile("(?s)Object\\.freeze\\((\\{.*?\\})\\)")

func readRules(www string) (json.RawMessage, string, error) {
	text, err := os.ReadFile(filepath.Join(www, "rules.js"))
	if err != nil {
		return nil, "", err
	}
	match := ruleLiteral.FindSubmatch(text)
	if match == nil {
		return nil, "", errors.New("无法读取联机规则版本")
	}
	return parseRules(match[1])
}

func parseRules(raw []byte) (json.RawMessage, string, error) {
	invalid := errors.New("联机规则版本格式无效")
	if !json.Valid(raw) {
		return nil, "", invalid
	}
	reader := json.NewDecoder(bytes.NewReader(raw))
	reader.UseNumber()
	first, err := reader.Token()
	if err != nil || first != json.Delim('{') {
		return nil, "", invalid
	}
	var parts []string
	for reader.More() {
		if _, err := reader.Token(); err != nil {
			return nil, "", invalid
		}
		token, err := reader.Token()
		value, ok := token.(json.Number)
		if err != nil || !ok {
			return nil, "", invalid
		}
		number, err := value.Int64()
		if err != nil {
			return nil, "", invalid
		}
		parts = append(parts, strconv.FormatInt(number, 10))
	}
	if len(parts) == 0 {
		return nil, "", invalid
	}
	return json.RawMessage(raw), strings.Join(parts, "."), nil
}

func (app *launcher) downloadPackage(invite string) ([]byte, error) {
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	header := func(name string, mode fs.FileMode) (io.Writer, error) {
		entry := &zip.FileHeader{Name: name, Method: zip.Deflate}
		entry.SetMode(mode)
		return archive.CreateHeader(entry)
	}
	writeFile := func(name, filename string, mode fs.FileMode) error {
		input, err := os.Open(filename)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := header(name, mode)
		if err != nil {
			return err
		}
		_, err = io.Copy(output, input)
		return err
	}

	join, err := header("join.json", 0600)
	if err != nil {
		return nil, err
	}
	if err := json.NewEncoder(join).Encode(map[string]string{"invite": invite}); err != nil {
		return nil, err
	}
	exe := executableName()
	var exePath string
	if app.baseDir == app.root {
		exePath, err = os.Executable()
	} else {
		exePath, err = installedExecutable(app.root)
	}
	if err != nil {
		return nil, err
	}
	if err := writeFile(exe, exePath, 0755); err != nil {
		return nil, err
	}
	web := os.DirFS(filepath.Join(app.root, "www"))
	err = fs.WalkDir(web, ".", func(name string, item fs.DirEntry, err error) error {
		if err != nil || item.IsDir() || !item.Type().IsRegular() {
			return err
		}
		return writeFile(path.Join("www", name), filepath.Join(app.root, "www", filepath.FromSlash(name)), 0644)
	})
	if err != nil {
		return nil, err
	}
	readme, err := header("使用说明.txt", 0644)
	if err != nil {
		return nil, err
	}
	instructions := "鱼来 " + version + "\r\n解压整个文件夹，运行 " + exe +
		"。\r\n浏览器进入固定本地地址 http://127.0.0.1:39241。" +
		"\r\n包内带有邀请码，启动后会尝试配对。也可在游戏中粘贴同事的邀请码。" +
		"\r\n关闭游戏页即退出世界，托盘菜单可退出启动器。" +
		"\r\n世界数据保存在浏览器，请按需导出身份和记忆备份。\r\n"
	if _, err := io.WriteString(readme, instructions); err != nil {
		return nil, err
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return data.Bytes(), nil
}

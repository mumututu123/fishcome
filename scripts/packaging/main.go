package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func main() {
	log.SetFlags(0)
	if len(os.Args) != 5 && len(os.Args) != 6 {
		log.Fatal("用法：packaging <编译产物> <启动器路径> <www目录> <ZIP路径> [Windows版本]")
	}
	binary, launcher, webRoot, archive := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	if len(os.Args) == 6 {
		if err := writeWindowsVersion(binary, launcher, os.Args[5]); err != nil {
			log.Fatalf("写入 Windows 版本信息失败：%v", err)
		}
	} else if err := os.Rename(binary, launcher); err != nil {
		log.Fatal(err)
	}
	if err := writeArchive(archive, launcher, webRoot); err != nil {
		log.Fatalf("写入发行包失败：%v", err)
	}
}

func writeWindowsVersion(binary, launcher, release string) error {
	src, err := os.Open(binary)
	if err != nil {
		return err
	}
	defer src.Close()

	resources, err := winres.LoadFromEXE(src)
	if errors.Is(err, winres.ErrNoResources) {
		resources = &winres.ResourceSet{}
	} else if err != nil {
		return err
	}
	info := version.Info{}
	info.SetProductVersion(release)
	info.SetFileVersion(release)
	info.Set(version.LangDefault, version.ProductName, "fishcome")
	info.Set(version.LangDefault, version.FileDescription, "鱼来")
	info.Set(version.LangDefault, version.OriginalFilename, filepath.Base(launcher))
	resources.SetVersionInfo(info)

	dst, err := os.Create(launcher)
	if err != nil {
		return err
	}
	return errors.Join(resources.WriteToEXE(dst, src), dst.Close())
}

func writeArchive(archive, launcher, webRoot string) error {
	dst, err := os.Create(archive)
	if err != nil {
		return err
	}
	return errors.Join(writeEntries(dst, launcher, webRoot), dst.Close())
}

func writeEntries(dst io.Writer, launcher, webRoot string) (err error) {
	pkg := zip.NewWriter(dst)
	defer func() { err = errors.Join(err, pkg.Close()) }()

	zipEpoch := time.Date(1980, time.January, 1, 0, 0, 0, 0, time.UTC)
	addFile := func(name, path string, mode fs.FileMode) error {
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		defer src.Close()
		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: zipEpoch}
		header.SetMode(mode)
		entry, err := pkg.CreateHeader(header)
		if err != nil {
			return err
		}
		_, err = io.Copy(entry, src)
		return err
	}
	if err := addFile(filepath.Base(launcher), launcher, 0755); err != nil {
		return err
	}
	return fs.WalkDir(os.DirFS(webRoot), ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("网页资源必须是常规文件：%s", name)
		}
		return addFile("www/"+name, filepath.Join(webRoot, filepath.FromSlash(name)), 0644)
	})
}

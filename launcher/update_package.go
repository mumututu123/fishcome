package main

import (
	"archive/zip"
	"bytes"
	"context"
	"debug/elf"
	"debug/pe"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var releaseStamp = "fishcome-release::"

func extractUpdate(ctx context.Context, data []byte, dir string) error {
	const entryLimit = 1024
	// Check the directory count before archive/zip allocates entries. Our release
	// size limits never require ZIP64.
	end := len(data) - 22
	minimum := max(0, end-65535)
	for ; end >= minimum; end-- {
		if bytes.Equal(data[end:end+4], []byte("PK\x05\x06")) && end+22+int(binary.LittleEndian.Uint16(data[end+20:])) == len(data) {
			break
		}
	}
	if end < minimum {
		return errors.New("更新包格式无效")
	}
	if int(binary.LittleEndian.Uint16(data[end+10:])) > entryLimit {
		return errors.New("更新包文件数量超过限制")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("更新包格式无效：%w", err)
	}
	if len(z.File) > entryLimit {
		return errors.New("更新包文件数量超过限制")
	}
	openRoot, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer openRoot.Close()

	files, dirs := map[string]bool{}, map[string]string{}
	var written int64
	for _, entry := range z.File {
		if err = ctx.Err(); err != nil {
			return err
		}
		norm := strings.ReplaceAll(entry.Name, "\\", "/")
		name := strings.TrimSuffix(norm, "/")
		parts := strings.Split(name, "/")
		for _, p := range parts {
			if p == "" || p == "." || p == ".." || strings.ContainsAny(p, "\x00:") || strings.HasSuffix(p, ".") || strings.HasSuffix(p, " ") || !filepath.IsLocal(p) {
				return errors.New("更新包包含非法路径条目")
			}
		}
		isExe := strings.EqualFold(name, executableName())
		if !isExe && !strings.EqualFold(parts[0], "www") {
			continue
		}
		isDir := strings.HasSuffix(norm, "/")
		if !isDir && !entry.Mode().IsRegular() {
			return errors.New("更新包包含特殊文件")
		}
		for i := range parts {
			path := strings.Join(parts[:i+1], "/")
			key := strings.ToLower(path)
			if files[key] || (dirs[key] != "" && (dirs[key] != path || (i == len(parts)-1 && !isDir))) {
				return errors.New("更新包包含重复或大小写冲突的文件条目")
			}
			if i != len(parts)-1 || isDir {
				dirs[key] = path
			} else {
				files[key] = true
			}
		}
		if isDir {
			continue
		}
		if entry.UncompressedSize64 > uint64(maxExtractBytes-written) {
			return errors.New("更新包解压体积超过限制")
		}
		local := filepath.FromSlash(name)
		if err = openRoot.MkdirAll(filepath.Dir(local), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0644)
		if isExe {
			mode = 0755
		}
		n, err := extractFile(openRoot, local, entry, mode, maxExtractBytes-written)
		if err != nil {
			return err
		}
		written += n
	}
	for _, req := range []string{executableName(), "www/index.html", "www/app.js", "www/rules.js", "www/update.js", "www/network.js", "www/storage.js", "www/style.css"} {
		info, err := openRoot.Stat(filepath.FromSlash(req))
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("更新包缺少必需文件：%s", req)
		}
	}
	return nil
}

func extractFile(root *os.Root, name string, entry *zip.File, mode os.FileMode, limit int64) (int64, error) {
	in, err := entry.Open()
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(in, limit+1))
	closeErr := out.Close()
	if n > limit {
		return n, errors.New("更新包解压体积超过限制")
	}
	return n, errors.Join(err, closeErr)
}

func verifyUpdateExecutable(path, expected string) error {
	var actual string
	var err error
	switch runtime.GOOS {
	case "windows":
		f, e := pe.Open(path)
		if e != nil {
			return errors.New("更新包内程序缺少有效的 PE 头")
		}
		defer f.Close()
		if f.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 || f.Characteristics&pe.IMAGE_FILE_DLL != 0 {
			return errors.New("更新包内程序不是可执行程序")
		}
		if f.Machine != pe.IMAGE_FILE_MACHINE_AMD64 && !managedAnyCPU(f) {
			return errors.New("更新包内程序不适用于本机架构")
		}
		actual, err = windowsProductVersion(f)
		if (err != nil || actual == "") && f.Section(".rdata") != nil {
			actual, err = stampedVersion(f.Section(".rdata").Open())
		}
	case "linux":
		f, e := elf.Open(path)
		if e != nil {
			return errors.New("更新包内程序缺少有效的 ELF 头")
		}
		defer f.Close()
		if f.Class != elf.ELFCLASS64 || f.Machine != elf.EM_X86_64 || (f.OSABI != elf.ELFOSABI_NONE && f.OSABI != elf.ELFOSABI_LINUX) || (f.Type != elf.ET_EXEC && f.Type != elf.ET_DYN) || f.Entry == 0 {
			return errors.New("更新包内程序不适用于本机架构")
		}
		if section := f.Section(".rodata"); section != nil {
			actual, err = stampedVersion(section.Open())
		}
	default:
		return errors.New("当前平台不支持热更新")
	}
	if err != nil || actual != expected {
		return fmt.Errorf("更新包内程序版本（%s）与声明版本（%s）不一致", actual, expected)
	}
	return nil
}

func stampedVersion(r io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxExtractBytes+1))
	if err != nil {
		return "", err
	}
	prefix, _, _ := strings.Cut(releaseStamp, ":")
	marker := []byte(prefix + ":")
	for {
		_, rest, ok := bytes.Cut(data, marker)
		if !ok {
			return "", errors.New("缺少发行版本标记")
		}
		candidate, _, ok := bytes.Cut(rest, []byte(":"))
		if ok && versionPattern.Match(candidate) {
			return string(candidate), nil
		}
		data = rest
	}
}

// Older Windows releases are managed PE32 images marked IL-only. They run
// natively under the 64-bit CLR despite the i386 machine field.
func managedAnyCPU(f *pe.File) bool {
	header, ok := f.OptionalHeader.(*pe.OptionalHeader32)
	if !ok || f.Machine != pe.IMAGE_FILE_MACHINE_I386 || header.NumberOfRvaAndSizes <= 14 {
		return false
	}
	clr := header.DataDirectory[14]
	if clr.Size < 20 || clr.VirtualAddress == 0 {
		return false
	}
	for _, section := range f.Sections {
		if clr.VirtualAddress < section.VirtualAddress {
			continue
		}
		offset := int64(clr.VirtualAddress - section.VirtualAddress)
		if offset+20 > int64(section.Size) {
			continue
		}
		var hdr [20]byte
		if _, err := section.ReadAt(hdr[:], offset); err != nil {
			return false
		}
		flags := binary.LittleEndian.Uint32(hdr[16:])
		return flags&1 != 0 && flags&2 == 0
	}
	return false
}

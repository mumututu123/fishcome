package main

import (
	"debug/pe"
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

func peResourceData(f *pe.File, rva, size uint32) ([]byte, error) {
	if size > 4<<20 {
		return nil, errors.New("程序版本资源过大")
	}
	for _, s := range f.Sections {
		if rva < s.VirtualAddress {
			continue
		}
		offset := int64(rva - s.VirtualAddress)
		if offset+int64(size) > int64(s.Size) {
			continue
		}
		data := make([]byte, size)
		_, err := s.ReadAt(data, offset)
		return data, err
	}
	return nil, errors.New("程序缺少有效的版本资源")
}

func windowsProductVersion(f *pe.File) (string, error) {
	const versionResourceType = 16
	var dir pe.DataDirectory
	switch h := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		dir = h.DataDirectory[2]
	case *pe.OptionalHeader64:
		dir = h.DataDirectory[2]
	}
	data, err := peResourceData(f, dir.VirtualAddress, dir.Size)
	if err != nil {
		return "", err
	}
	var offset uint32
	for level := 0; level < 3; level++ {
		if uint64(offset)+16 > uint64(len(data)) {
			return "", errors.New("程序版本资源无效")
		}
		table := data[offset:]
		count := int(binary.LittleEndian.Uint16(table[12:])) + int(binary.LittleEndian.Uint16(table[14:]))
		found := false
		for i := 0; i < count && 16+(i+1)*8 <= len(table); i++ {
			entry := table[16+i*8:]
			if level == 0 && binary.LittleEndian.Uint32(entry) != versionResourceType {
				continue
			}
			target := binary.LittleEndian.Uint32(entry[4:])
			if (target>>31 != 0) != (level < 2) {
				continue
			}
			offset = target & 0x7fffffff
			found = true
			break
		}
		if !found {
			return "", errors.New("程序缺少版本资源")
		}
	}
	if uint64(offset)+16 > uint64(len(data)) {
		return "", errors.New("程序版本资源无效")
	}
	entry := data[offset:]
	value, err := peResourceData(f, binary.LittleEndian.Uint32(entry), binary.LittleEndian.Uint32(entry[4:]))
	if err != nil {
		return "", err
	}
	return findProductVersion(value, 0), nil
}

// VS_VERSIONINFO nodes have a UTF-16 key, a DWORD-aligned value, then
// DWORD-aligned children. Text value lengths are in UTF-16 code units.
func findProductVersion(node []byte, depth int) string {
	if depth > 4 || len(node) < 6 {
		return ""
	}
	size := int(binary.LittleEndian.Uint16(node))
	if size < 6 || size > len(node) {
		return ""
	}
	node = node[:size]
	keyEnd := 6
	var key []uint16
	for keyEnd+2 <= size {
		ch := binary.LittleEndian.Uint16(node[keyEnd:])
		keyEnd += 2
		if ch == 0 {
			break
		}
		key = append(key, ch)
	}
	valueStart := (keyEnd + 3) &^ 3
	valueBytes := int(binary.LittleEndian.Uint16(node[2:]))
	text := binary.LittleEndian.Uint16(node[4:]) == 1
	if text {
		valueBytes *= 2
	}
	valueEnd := valueStart + valueBytes
	if valueEnd > size {
		return ""
	}
	if text && string(utf16.Decode(key)) == "ProductVersion" {
		var v []uint16
		for i := valueStart; i < valueEnd; i += 2 {
			ch := binary.LittleEndian.Uint16(node[i:])
			if ch == 0 {
				break
			}
			v = append(v, ch)
		}
		return string(utf16.Decode(v))
	}
	for child := (valueEnd + 3) &^ 3; child+6 <= size; {
		length := int(binary.LittleEndian.Uint16(node[child:]))
		if length < 6 || child+length > size {
			break
		}
		if v := findProductVersion(node[child:child+length], depth+1); v != "" {
			return v
		}
		child = (child + length + 3) &^ 3
	}
	return ""
}

package main

import "os"

var version, releaseStamp string

func main() {
	if marker := os.Getenv("TIDE_TEST_CRASH_MARKER"); marker != "" {
		_ = os.WriteFile(marker, []byte(version+"\n"+releaseStamp), 0600)
	}
	os.Exit(1)
}

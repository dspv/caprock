package logcap

import (
	"sync"
)

var (
	mu    sync.Mutex
	paths []string
)

// Watch names the files the daemon may be logging to. Only a file named here
// is ever renamed, so an unexpected stderr — another program's log, a file
// the user redirected to — is left alone.
func Watch(p ...string) {
	mu.Lock()
	paths = append(paths, p...)
	mu.Unlock()
}

func candidates() []string {
	mu.Lock()
	defer mu.Unlock()
	return append([]string(nil), paths...)
}

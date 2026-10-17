//go:build darwin

package browser

import (
	"bytes"
	"os"
	"sync"

	"github.com/ebitengine/purego"
)

// LaunchServices, through purego (the binary is built without cgo, as
// internal/procstat's libSystem calls are): the apps registered for an
// https URL and the default one. Asking for a URL rather than a scheme uses
// the calls Apple has not deprecated (LSCopyApplicationURLsForURL,
// LSCopyDefaultApplicationURLForURL, macOS 10.10 and later).

const (
	kCFStringEncodingUTF8 = 0x08000100
	kLSRolesAll           = 0xFFFFFFFF
)

var (
	lsOnce sync.Once
	lsOK   bool

	cfRelease            func(uintptr)
	cfArrayGetCount      func(uintptr) int
	cfArrayGetValueAt    func(uintptr, int) uintptr
	cfURLCreateWithBytes func(alloc uintptr, b *byte, n int, enc uint32, base uintptr) uintptr
	cfURLGetFSRep        func(u uintptr, resolve bool, buf *byte, max int) bool
	lsAppURLsForURL      func(u uintptr, roles uint32) uintptr
	lsDefaultAppForURL   func(u uintptr, roles uint32, errOut uintptr) uintptr
)

func loadLS() bool {
	lsOnce.Do(func() {
		cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		cs, err := purego.Dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		for _, f := range []struct {
			lib  uintptr
			name string
			fn   any
		}{
			{cf, "CFRelease", &cfRelease},
			{cf, "CFArrayGetCount", &cfArrayGetCount},
			{cf, "CFArrayGetValueAtIndex", &cfArrayGetValueAt},
			{cf, "CFURLCreateWithBytes", &cfURLCreateWithBytes},
			{cf, "CFURLGetFileSystemRepresentation", &cfURLGetFSRep},
			{cs, "LSCopyApplicationURLsForURL", &lsAppURLsForURL},
			{cs, "LSCopyDefaultApplicationURLForURL", &lsDefaultAppForURL},
		} {
			if _, err := purego.Dlsym(f.lib, f.name); err != nil {
				return
			}
			purego.RegisterLibFunc(f.fn, f.lib, f.name)
		}
		lsOK = true
	})
	return lsOK
}

func urlPath(u uintptr) string {
	if u == 0 {
		return ""
	}
	buf := make([]byte, 4096)
	if !cfURLGetFSRep(u, true, &buf[0], len(buf)) {
		return ""
	}
	if i := bytes.IndexByte(buf, 0); i >= 0 {
		buf = buf[:i]
	}
	return string(buf)
}

// DetectHere lists the browsers installed: every app LaunchServices would
// open an https link with, the default one marked.
func DetectHere([]string) []Browser {
	if !loadLS() {
		return nil
	}
	probe := []byte("https://example.com/")
	u := cfURLCreateWithBytes(0, &probe[0], len(probe), kCFStringEncodingUTF8, 0)
	if u == 0 {
		return nil
	}
	defer cfRelease(u)
	var def string
	if d := lsDefaultAppForURL(u, kLSRolesAll, 0); d != 0 {
		def = urlPath(d)
		cfRelease(d)
	}
	var paths []string
	if arr := lsAppURLsForURL(u, kLSRolesAll); arr != 0 {
		n := cfArrayGetCount(arr)
		for i := 0; i < n; i++ {
			if p := urlPath(cfArrayGetValueAt(arr, i)); p != "" {
				paths = append(paths, p)
			}
		}
		cfRelease(arr)
	}
	// The default first, so a second copy of it never takes its place.
	if def != "" {
		paths = append([]string{def}, paths...)
	}
	return FromAppPaths(paths, def, func(p string) bool {
		st, err := os.Stat(p)
		return err == nil && st.IsDir()
	})
}

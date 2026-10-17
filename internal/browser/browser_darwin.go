//go:build darwin

package browser

import (
	"bytes"
	"os"
	"strings"
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

	// The bundle's identifier, to tell a web browser from any other app
	// that handles https (known.go). Optional: without them the name
	// decides.
	bundleOK           bool
	cfBundleCreate     func(alloc uintptr, u uintptr) uintptr
	cfBundleGetID      func(b uintptr) uintptr
	cfStringGetCString func(s uintptr, buf *byte, n int, enc uint32) bool
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
		bundleOK = true
		for _, f := range []struct {
			name string
			fn   any
		}{
			{"CFBundleCreate", &cfBundleCreate},
			{"CFBundleGetIdentifier", &cfBundleGetID},
			{"CFStringGetCString", &cfStringGetCString},
		} {
			if _, err := purego.Dlsym(cf, f.name); err != nil {
				bundleOK = false
				return
			}
			purego.RegisterLibFunc(f.fn, cf, f.name)
		}
	})
	return lsOK
}

// bundleID is the identifier of the bundle at the file URL u; "" when it
// cannot be read.
func bundleID(u uintptr) string {
	if !bundleOK || u == 0 {
		return ""
	}
	b := cfBundleCreate(0, u)
	if b == 0 {
		return ""
	}
	defer cfRelease(b)
	s := cfBundleGetID(b) // the Get rule: not ours to release
	if s == 0 {
		return ""
	}
	buf := make([]byte, 256)
	if !cfStringGetCString(s, &buf[0], len(buf), kCFStringEncodingUTF8) {
		return ""
	}
	if i := bytes.IndexByte(buf, 0); i >= 0 {
		buf = buf[:i]
	}
	return string(buf)
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
	ids := map[string]string{}
	var def string
	if d := lsDefaultAppForURL(u, kLSRolesAll, 0); d != 0 {
		def = urlPath(d)
		ids[strings.TrimSuffix(def, "/")] = bundleID(d)
		cfRelease(d)
	}
	var paths []string
	if arr := lsAppURLsForURL(u, kLSRolesAll); arr != 0 {
		n := cfArrayGetCount(arr)
		for i := 0; i < n; i++ {
			a := cfArrayGetValueAt(arr, i)
			if p := urlPath(a); p != "" {
				paths = append(paths, p)
				ids[strings.TrimSuffix(p, "/")] = bundleID(a)
			}
		}
		cfRelease(arr)
	}
	// The default first, so a second copy of it never takes its place.
	if def != "" {
		paths = append([]string{def}, paths...)
	}
	out := FromAppPaths(paths, def, func(p string) bool {
		st, err := os.Stat(p)
		return err == nil && st.IsDir()
	})
	for i := range out {
		out[i].bundle = ids[out[i].app]
	}
	return out
}

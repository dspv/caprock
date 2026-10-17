package browser

import (
	posix "path"
	"strings"
)

// FromAppPaths turns the app bundles LaunchServices names for web links into
// the macOS list: def is the default one's bundle. Only a bundle in an
// Applications folder is kept (/Applications, ~/Applications, the system's,
// Safari's cryptex), so a test browser a tool downloaded into a cache or a
// hidden folder is not offered; nor is a bundle inside another (a helper),
// one in the Trash, or one stat says is gone. Of two bundles with the same
// name (an old copy) the first wins. Every app that registers for https is
// returned, as macOS's own Default web browser menu lists it — a terminal or
// a chat app among them — and the Opener keeps only the web browsers
// (known.go). Kept free of build tags so its tests run on every OS.
func FromAppPaths(paths []string, def string, exists func(string) bool) []Browser {
	var out []Browser
	names := map[string]bool{}
	def = strings.TrimSuffix(def, "/")
	for _, p := range paths {
		p = strings.TrimSuffix(p, "/")
		dir := posix.Dir(p)
		if !strings.HasSuffix(p, ".app") || strings.Contains(dir+"/", ".app/") {
			continue
		}
		if !strings.Contains(p, "/Applications/") || strings.Contains(p, "/.") || (exists != nil && !exists(p)) {
			continue
		}
		name := strings.TrimSuffix(posix.Base(p), ".app")
		if name == "" || names[name] {
			continue
		}
		names[name] = true
		out = append(out, Browser{ID: p, Name: name, Default: p == def, app: p})
	}
	return out
}

package api

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// distFS is the built dashboard (ui/ → internal/api/dist, git-ignored).
//
//go:embed all:dist
var distFS embed.FS

// placeholderFS is served when the binary was built without the dashboard, so
// `go build` never needs Node.
//
//go:embed placeholder/index.html
var placeholderFS embed.FS

// DistFS returns the embedded UI filesystem: the built dashboard when present,
// else the placeholder page.
func DistFS() fs.FS {
	if sub, err := fs.Sub(distFS, "dist"); err == nil {
		if f, err := sub.Open("index.html"); err == nil {
			_ = f.Close()
			return sub
		}
	}
	sub, err := fs.Sub(placeholderFS, "placeholder")
	if err != nil {
		panic(err)
	}
	return sub
}

// UIBuilt reports whether the real dashboard is embedded.
func UIBuilt() bool {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return false
	}
	f, err := sub.Open("index.html")
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

// uiHandler serves the SPA: static assets by path, index.html for everything
// else (client-side routing).
func (s *Server) uiHandler() http.Handler {
	ui := s.d.UI
	if ui == nil {
		ui = DistFS()
	}
	fileServer := http.FileServer(http.FS(ui))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := ui.Open(p); err == nil {
			_ = f.Close()
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA fallback.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		b, err := fs.ReadFile(ui, "index.html")
		if err != nil {
			http.Error(w, "ui not built", http.StatusNotFound)
			return
		}
		_, _ = w.Write(b)
	})
}

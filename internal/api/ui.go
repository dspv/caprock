package api

import (
	"bytes"
	"embed"
	"html"
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
		} else {
			p = "index.html" // a client-side route
		}
		if p != "index.html" {
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		// The page itself, for "/" and as the SPA fallback.
		b, err := fs.ReadFile(ui, "index.html")
		if err != nil {
			http.Error(w, "ui not built", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Never kept: the page names the daemon that served it.
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(withVersion(b, s.d.Version))
	})
}

// withVersion writes the daemon's version into the page as
// <meta name="caprock-version">, so the page knows exactly which daemon
// served it and reloads when the live link comes back to a different one
// (ui/src/lib/staleui.ts; .ai/21-app.md § Updating the daemon). A page with
// no </head>, or a daemon with no version, is served as it is.
func withVersion(page []byte, version string) []byte {
	if version == "" {
		return page
	}
	i := bytes.Index(page, []byte("</head>"))
	if i < 0 {
		return page
	}
	meta := `<meta name="caprock-version" content="` + html.EscapeString(version) + `" />`
	out := make([]byte, 0, len(page)+len(meta))
	out = append(out, page[:i]...)
	out = append(out, meta...)
	return append(out, page[i:]...)
}

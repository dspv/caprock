package opencode

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// testdata/opencode-2.0.26-events.txt is frames read off a real 2.0.26
// service's /api/event during one `opencode run` (directories rewritten): a
// connect, the session's creation, three finished steps with a text delta
// between them, and the run's end.

func serveV2(t *testing.T, password string) *httptest.Server {
	t.Helper()
	frames, err := os.ReadFile(filepath.Join("testdata", "opencode-2.0.26-events.txt"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pw, ok := r.BasicAuth()
		if r.URL.Path != "/api/event" {
			http.NotFound(w, r)
			return
		}
		if !ok || user != "opencode" || pw != password {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, line := range splitLines(string(frames)) {
			_, _ = io.WriteString(w, line+"\n\n")
		}
		_, _ = io.WriteString(w, ": heartbeat\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func writeService(t *testing.T, dir, url, password string) string {
	t.Helper()
	path := filepath.Join(dir, "service.json")
	body := fmt.Sprintf(`{"id":"x","version":"2.0.26","url":%q,"pid":1,"password":%q}`, url, password)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestServiceStreamerFollowsTheV2Service(t *testing.T) {
	srv := serveV2(t, "pw")
	s := &ServiceStreamer{file: writeService(t, t.TempDir(), srv.URL, "pw"), log: slog.New(slog.NewTextHandler(io.Discard, nil)), http: srv.Client()}

	var mu sync.Mutex
	var got []string
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go s.Run(ctx, func(id string) {
		mu.Lock()
		got = append(got, id)
		if len(got) == 5 {
			cancel()
		}
		mu.Unlock()
	})
	<-ctx.Done()
	mu.Lock()
	defer mu.Unlock()
	// created, three step.ended, execution.succeeded; the connect frame and
	// the text delta are not changes.
	if len(got) != 5 {
		t.Fatalf("got %d changes, want 5: %v", len(got), got)
	}
	for _, id := range got {
		if id != "ses_ee2436a4affea745wld2i1EQEU" {
			t.Errorf("session %q", id)
		}
	}
}

func TestServiceStreamerNeedsThePassword(t *testing.T) {
	srv := serveV2(t, "right")
	s := &ServiceStreamer{log: slog.New(slog.NewTextHandler(io.Discard, nil)), http: srv.Client()}
	err := followSSE(context.Background(), s.http, srv.URL+"/api/event", nil, sessionOfV2, func(string) {}, s.log)
	if err == nil {
		t.Error("an unauthenticated stream was accepted")
	}
}

func TestServiceStreamerWithoutAServiceIsQuiet(t *testing.T) {
	s := &ServiceStreamer{file: filepath.Join(t.TempDir(), "service.json"), log: slog.New(slog.NewTextHandler(io.Discard, nil)), http: http.DefaultClient}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	s.Run(ctx, func(string) { t.Error("a change with no service") })

	(&ServiceStreamer{}).Run(context.Background(), nil) // no state directory: returns at once
}

func TestReadService(t *testing.T) {
	dir := t.TempDir()
	if _, err := readService(filepath.Join(dir, "none.json")); err == nil {
		t.Error("missing file read")
	}
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"password":"x"}`), 0o600)
	if _, err := readService(bad); err == nil {
		t.Error("a file without a url read")
	}
	_ = os.WriteFile(bad, []byte(`not json`), 0o600)
	if _, err := readService(bad); err == nil {
		t.Error("garbage read")
	}
	s, err := readService(writeService(t, dir, "http://127.0.0.1:1", "p"))
	if err != nil || s.URL != "http://127.0.0.1:1" || s.Password != "p" {
		t.Errorf("read %+v, %v", s, err)
	}
}

func TestStatePath(t *testing.T) {
	env := map[string]string{}
	get := func(k string) string { return env[k] }
	if got, want := statePath(get, "/h"), filepath.Join("/h", ".local", "state", "opencode"); got != want {
		t.Errorf("statePath = %q, want %q", got, want)
	}
	if got := statePath(get, ""); got != "" {
		t.Errorf("no home: %q", got)
	}
	env["XDG_STATE_HOME"] = "/x"
	if got, want := statePath(get, "/h"), filepath.Join("/x", "opencode"); got != want {
		t.Errorf("XDG: %q, want %q", got, want)
	}
	if NewServiceStreamer(slog.Default()).file == "" {
		t.Error("no service file path on this machine")
	}
}

func TestV2ChangedIsNarrow(t *testing.T) {
	for _, ty := range []string{"server.connected", "session.text.delta", "session.tool.progress", "model.updated", ""} {
		if v2Changed(ty) {
			t.Errorf("%q counted as a change", ty)
		}
	}
	if sessionOfV2([]byte(`{nope`)) != "" {
		t.Error("garbage frame named a session")
	}
}

package opencode

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

// A stub SSE server, so these run everywhere rather than only where OpenCode
// is installed. The frames are copied from what a real `opencode serve`
// emits — the envelope is `data: {"type":…,"properties":{"sessionID":…}}`.

func streamLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

// sseServer writes the given frames and then holds the connection until the
// test finishes, which is how the real stream behaves.
func sseServer(t *testing.T, frames []string) *httptest.Server {
	t.Helper()
	// Cleanups run last-registered-first, and httptest.Server.Close waits for
	// every handler to return. Registering the release *after* the server
	// means it runs *before* Close, so the handler is already unblocked when
	// Close waits for it — the other order deadlocks for the test's lifetime.
	done := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/event" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		for _, f := range frames {
			fmt.Fprintf(w, "data: %s\n\n", f)
			if fl != nil {
				fl.Flush()
			}
		}
		select {
		case <-done:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(done) })
	return srv
}

// collect runs the streamer against a server and returns the session ids it
// reported within a short window.
func collect(t *testing.T, url string, want int) []string {
	t.Helper()
	var (
		mu   sync.Mutex
		got  []string
		seen = make(chan struct{}, 64)
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go NewStreamer(url, streamLogger()).Run(ctx, func(id string) {
		mu.Lock()
		got = append(got, id)
		mu.Unlock()
		select {
		case seen <- struct{}{}:
		default:
		}
	})

	deadline := time.After(3 * time.Second)
	for i := 0; i < want; i++ {
		select {
		case <-seen:
		case <-deadline:
			mu.Lock()
			defer mu.Unlock()
			return got
		}
	}
	// A moment more, to catch anything that should NOT have been reported.
	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	return append([]string(nil), got...)
}

func TestStreamReportsChangedSessions(t *testing.T) {
	srv := sseServer(t, []string{
		`{"type":"server.connected","properties":{}}`,
		`{"type":"message.updated","properties":{"sessionID":"ses_a","info":{}}}`,
		`{"type":"session.idle","properties":{"sessionID":"ses_b"}}`,
	})
	got := collect(t, srv.URL, 2)
	if len(got) != 2 || got[0] != "ses_a" || got[1] != "ses_b" {
		t.Errorf("reported %v, want [ses_a ses_b]", got)
	}
}

func TestStreamIgnoresIrrelevantEvents(t *testing.T) {
	// OpenCode publishes over a hundred event types; most say nothing about
	// what Caprock stores. Re-reading a session on a toast or a TUI selection
	// is work for nothing, and on a busy session the stream is chatty enough
	// that it matters.
	srv := sseServer(t, []string{
		`{"type":"server.connected","properties":{}}`,
		`{"type":"tui.toast.show","properties":{"sessionID":"ses_x"}}`,
		`{"type":"lsp.client.diagnostics","properties":{"sessionID":"ses_x"}}`,
		`{"type":"file.watcher.updated","properties":{"sessionID":"ses_x"}}`,
		`{"type":"tui.session.select","properties":{"sessionID":"ses_x"}}`,
		`{"type":"message.updated","properties":{"sessionID":"ses_real"}}`,
	})
	got := collect(t, srv.URL, 1)
	if len(got) != 1 || got[0] != "ses_real" {
		t.Errorf("reported %v, want only [ses_real]", got)
	}
}

func TestStreamSurvivesMalformedFrames(t *testing.T) {
	// One bad frame must not drop a connection that is otherwise fine.
	srv := sseServer(t, []string{
		`{"type":"message.updated","properties":{`,
		`not json at all`,
		``,
		`{"type":"message.updated","properties":{"sessionID":"ses_ok"}}`,
	})
	got := collect(t, srv.URL, 1)
	if len(got) != 1 || got[0] != "ses_ok" {
		t.Errorf("reported %v, want [ses_ok]", got)
	}
}

func TestStreamIgnoresEventsWithNoSession(t *testing.T) {
	// A relevant type with no session id names nothing to re-read; acting on
	// it would mean guessing which session was meant.
	srv := sseServer(t, []string{
		`{"type":"session.idle","properties":{}}`,
		`{"type":"message.updated","properties":{"sessionID":"ses_ok"}}`,
	})
	got := collect(t, srv.URL, 1)
	if len(got) != 1 || got[0] != "ses_ok" {
		t.Errorf("reported %v, want [ses_ok]", got)
	}
}

func TestStreamStopsOnContextCancel(t *testing.T) {
	// The daemon cancels this on shutdown; a streamer that ignores it holds a
	// connection open past exit and retries forever.
	srv := sseServer(t, []string{`{"type":"server.connected","properties":{}}`})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		NewStreamer(srv.URL, streamLogger()).Run(ctx, func(string) {})
		close(done)
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return within 3s of cancellation")
	}
}

func TestStreamRetriesWhenTheServerIsAbsent(t *testing.T) {
	// `opencode serve` is not always running — it is there while a TUI is open
	// and gone otherwise — so a refused connection is the normal case, not an
	// error. Run must keep trying rather than give up on the first failure.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		// A port nothing is listening on.
		NewStreamer("http://127.0.0.1:1", streamLogger()).Run(ctx, func(string) {})
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("Run gave up instead of retrying")
	case <-time.After(1200 * time.Millisecond):
		// Still going, which is the point.
	}
}

func TestChangedIsNarrow(t *testing.T) {
	relevant := []string{
		"message.updated", "message.removed", "session.created",
		"session.updated", "session.idle", "session.deleted",
		"session.compacted", "session.error",
	}
	for _, t2 := range relevant {
		if !changed(t2) {
			t.Errorf("%q is not treated as a change", t2)
		}
	}
	ignored := []string{
		"server.connected", "server.heartbeat", "tui.toast.show",
		"tui.session.select", "lsp.updated", "file.watcher.updated",
		"mcp.tools.changed", "permission.asked", "",
	}
	for _, t2 := range ignored {
		if changed(t2) {
			t.Errorf("%q would trigger a re-read for nothing", t2)
		}
	}
}

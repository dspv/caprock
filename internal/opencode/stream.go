package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

// The live stream, and what it is for.
//
// The poller reads OpenCode's database every few seconds, which is right for
// history and for cost but visibly late on the Now screen: a session that just
// answered shows up seconds after it did. OpenCode's headless server publishes
// an SSE stream, so when one is running Caprock subscribes and re-reads the one
// session an event names, immediately.
//
// It never replaces the poller. The stream only exists while `opencode serve`
// is running — which is whenever the TUI is open, but not otherwise — and it
// carries no history, so a machine that has been off all night still needs the
// database read. The two are complementary: the poller is the floor, the
// stream removes the latency on top of it.
//
// Events are used as a *signal*, not as data. An event says "this session
// changed"; the figures still come from the database, which is the only place
// OpenCode's own cost arithmetic lives. Trusting the event payload instead
// would mean maintaining a second reading of their schema that drifts from the
// first.

// DefaultServerURL is where `opencode serve` listens unless told otherwise.
const DefaultServerURL = "http://127.0.0.1:4096"

// Streamer follows OpenCode's event stream and reports which sessions changed.
type Streamer struct {
	url  string
	log  *slog.Logger
	http *http.Client
}

// ServerURL is where OpenCode's headless server is expected.
//
// OPENCODE_URL overrides it, which is what a user with a non-default port
// needs and what the tests point at a stub.
func ServerURL() string {
	if u := os.Getenv("OPENCODE_URL"); u != "" {
		return u
	}
	return DefaultServerURL
}

// NewStreamer builds a streamer against an OpenCode server URL.
func NewStreamer(url string, log *slog.Logger) *Streamer {
	if url == "" {
		url = ServerURL()
	}
	return &Streamer{
		url: strings.TrimRight(url, "/"),
		log: log,
		// No overall timeout: this request is meant to stay open. The read
		// deadline below is what detects a dead connection.
		http: &http.Client{},
	}
}

// sseEvent is the envelope every frame carries.
type sseEvent struct {
	Type       string `json:"type"`
	Properties struct {
		SessionID string `json:"sessionID"`
	} `json:"properties"`
}

// changed reports whether an event means a session's stored state moved.
//
// Deliberately narrow. OpenCode publishes over a hundred event types, most of
// which say nothing about what Caprock stores — a toast, a TUI selection, an
// LSP diagnostic. Re-reading a session on those would be work for nothing, and
// on a busy session the stream is chatty enough that the difference matters.
func changed(t string) bool {
	switch t {
	case "message.updated", "message.removed",
		"session.created", "session.updated", "session.idle",
		"session.deleted", "session.compacted", "session.error":
		return true
	default:
		return false
	}
}

// Run follows the stream until the context is cancelled, calling onChange with
// the session id behind every event that matters.
//
// It reconnects on its own. `opencode serve` is not always running — the
// stream is available while a TUI is open and gone when it closes — so a
// failed connection is the normal case rather than an error, and it is logged
// at debug level for that reason.
func (s *Streamer) Run(ctx context.Context, onChange func(sessionID string)) {
	backoff := time.Second
	for {
		if err := s.follow(ctx, onChange); err != nil && ctx.Err() == nil {
			s.log.Debug("opencode stream ended", "component", "opencode", "err", err)
		}
		if ctx.Err() != nil {
			return
		}
		// Back off up to half a minute. A machine with no OpenCode server
		// running would otherwise retry every second forever.
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// follow holds one connection open, returning when it drops.
func (s *Streamer) follow(ctx context.Context, onChange func(sessionID string)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("opencode stream: %s", res.Status)
	}
	s.log.Info("following opencode's live stream", "component", "opencode", "url", s.url)

	// SSE frames can be long when a payload is attached; the default scanner
	// buffer would fail on those rather than skip them.
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // comments, heartbeats and blank separators
		}
		var ev sseEvent
		if err := json.Unmarshal([]byte(strings.TrimSpace(line[5:])), &ev); err != nil {
			continue // one unreadable frame is not a reason to drop the stream
		}
		if !changed(ev.Type) || ev.Properties.SessionID == "" {
			continue
		}
		onChange(ev.Properties.SessionID)
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

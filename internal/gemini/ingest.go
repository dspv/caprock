package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
)

// Ingester turns Gemini's telemetry files into Caprock events.
//
// It tails rather than polls-and-rereads: each file belongs to one session,
// grows only at the end, and is never rewritten — so remembering a byte offset
// per file is both correct and the difference between reading a few hundred
// bytes a tick and re-parsing megabytes.
//
// Every write is idempotent anyway. Events carry a key derived from the
// session, the event kind and its timestamp, and `(session_id, key)` is unique
// in the store, so a re-read after a restart is a no-op rather than a session
// whose cost has doubled.
type Ingester struct {
	dir string
	rec *rollup.Recorder
	log *slog.Logger

	// every is the tick. A few seconds of latency on a token count is not worth
	// spinning for; the terminal is already live, and this is the number
	// underneath it.
	every time.Duration

	mu sync.Mutex
	// at is how far into each file has been read. Keyed by path.
	at map[string]int64
	// cwd remembers where a session runs, learned from the spawn rather than
	// from telemetry — Gemini reports its own working directory but Caprock
	// already knows the one the user picked, and they can differ.
	cwd map[string]string
}

// NewIngester builds one. dir is where spawned sessions write their telemetry.
func NewIngester(dir string, rec *rollup.Recorder, log *slog.Logger) *Ingester {
	if log == nil {
		log = slog.Default()
	}
	if dir == "" {
		return nil
	}
	return &Ingester{
		dir: dir, rec: rec, log: log, every: 3 * time.Second,
		at: map[string]int64{}, cwd: map[string]string{},
	}
}

// Track records where a session runs, so its events land in the right project.
func (g *Ingester) Track(sessionID, cwd string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cwd[sessionID] = cwd
}

// Run tails every telemetry file until the context ends.
func (g *Ingester) Run(ctx context.Context) {
	if g == nil {
		return
	}
	t := time.NewTicker(g.every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := g.Sweep(ctx); err != nil {
				// A telemetry read failing must never be louder than it is
				// important: the session itself is unaffected, and the user
				// sees the terminal regardless.
				g.log.Warn("gemini telemetry", "component", "gemini", "err", err)
			} else if n > 0 {
				g.log.Debug("gemini telemetry", "component", "gemini", "events", n)
			}
		}
	}
}

// Sweep reads whatever is new in every file and records it. Returns how many
// events were stored.
func (g *Ingester) Sweep(ctx context.Context) (int, error) {
	if g == nil {
		return 0, nil
	}
	entries, err := os.ReadDir(g.dir)
	if err != nil {
		if os.IsNotExist(err) {
			// No session has been spawned yet. Not a problem.
			return 0, nil
		}
		return 0, err
	}
	var stored int
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".otel.log") {
			continue
		}
		n, err := g.readFile(ctx, filepath.Join(g.dir, e.Name()))
		if err != nil {
			return stored, err
		}
		stored += n
	}
	return stored, nil
}

func (g *Ingester) readFile(ctx context.Context, path string) (int, error) {
	g.mu.Lock()
	from := g.at[path]
	g.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() <= from {
		return 0, nil
	}
	if _, err := f.Seek(from, 0); err != nil {
		return 0, err
	}

	evs, err := ParseTelemetry(f)
	if err != nil {
		return 0, err
	}

	// Advance only past what parsed cleanly. The file is being written while
	// this reads it, so the tail is routinely a half-written record; counting
	// it as read would lose it forever, and re-reading it next tick costs
	// nothing because the store deduplicates.
	consumed := from + consumedBytes(evs, info.Size()-from)

	var stored int
	for _, e := range evs {
		ok, err := g.record(ctx, path, e)
		if err != nil {
			return stored, err
		}
		if ok {
			stored++
		}
	}

	g.mu.Lock()
	g.at[path] = consumed
	g.mu.Unlock()
	return stored, nil
}

// consumedBytes is how far the reader may advance.
//
// ParseTelemetry does not report where it stopped, and adding that would
// complicate its only other caller for no gain — so a file whose tail did not
// parse is simply re-read next tick. That is safe because the store
// deduplicates, and cheap because a tail is small.
func consumedBytes(evs []TelemetryEvent, available int64) int64 {
	if len(evs) == 0 {
		return 0
	}
	return available
}

func (g *Ingester) record(ctx context.Context, path string, e TelemetryEvent) (bool, error) {
	sessionID := strings.TrimSuffix(filepath.Base(path), ".otel.log")
	// The session id in the file name is Caprock's own, passed to Gemini as
	// --session-id; the one inside the telemetry is Gemini's conversation id.
	// The file name wins, so an event lands on the row the user is looking at.
	if e.SessionID != "" && sessionID == "" {
		sessionID = e.SessionID
	}

	payload, err := json.Marshal(e.Raw)
	if err != nil {
		payload = []byte(`{}`)
	}

	ev := &event.Event{
		Ts:        e.TS,
		SessionID: sessionID,
		Source:    event.SourceGemini,
		Kind:      e.Kind,
		Tool:      e.Tool,
		Model:     e.Model,
		Payload:   payload,
		// The key is what makes a re-read free. Timestamp plus kind plus tool
		// is unique within a session in practice: Gemini stamps to the
		// millisecond and does not emit two identical events in one.
		Key: fmt.Sprintf("otel:%s:%s:%d", e.Kind, e.Tool, e.TS.UnixMilli()),
	}
	if e.Kind == event.KindTurnAssistant {
		ev.Tokens = &event.TokenDelta{
			In:  int64(e.TokensIn),
			Out: int64(e.TokensOut),
			// Gemini reports what it read from cache; it has no separate
			// cache-write figure, so that stays zero rather than being
			// invented. A zero here is honest — the column means "we do not
			// know", and guessing would put a number on a screen that says it
			// only shows measured ones.
			CacheRead: int64(e.CacheRead),
		}
	}

	g.mu.Lock()
	cwd := g.cwd[sessionID]
	g.mu.Unlock()

	res, err := g.rec.Record(ctx, ev, rollup.SessionInfo{
		Cwd:   cwd,
		Model: e.Model,
		Agent: "gemini",
	})
	if err != nil {
		return false, err
	}
	return res.Stored, nil
}

// Forget drops the offset for a finished session's file, so a restart does not
// hold state for sessions that will never grow again.
func (g *Ingester) Forget(sessionID string) {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.at, filepath.Join(g.dir, sessionID+".otel.log"))
	delete(g.cwd, sessionID)
}

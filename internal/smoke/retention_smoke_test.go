//go:build smoke

package smoke

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/daemon"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The daemon prunes events older than retention_days on start.
func TestRetentionPrunesOnStart(t *testing.T) {
	dataDir := t.TempDir()
	// Seed a database with one old and one recent event before the daemon opens it.
	st, err := store.Open(context.Background(), config.DBPath(dataDir), nil)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().AddDate(0, 0, -100)
	recent := time.Now()
	for i, ts := range []time.Time{old, recent} {
		ev := &event.Event{SessionID: "s", Source: event.SourceHook, Kind: event.KindToolPre, Tool: "Bash", Key: string(rune('a' + i)), Ts: ts}
		if _, err := store.InsertEvent(context.Background(), st.DB(), ev); err != nil {
			t.Fatal(err)
		}
	}
	_ = st.Close()

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	cfg := config.Defaults()
	cfg.RetentionDays = 30
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- daemon.Run(ctx, daemon.Options{DataDir: dataDir, Config: cfg, Version: "smoke", Listener: ln, DisableIngest: true, OnReady: func(u string) { ready <- u }})
	}()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("daemon exited: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not start")
	}
	// Give the prune goroutine a moment.
	deadline := time.After(5 * time.Second)
	st2, _ := store.Open(context.Background(), config.DBPath(dataDir), nil)
	defer st2.Close()
	for {
		n, _ := store.CountEvents(context.Background(), st2.DB())
		if n == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("prune did not run: %d events remain", n)
		case <-time.After(100 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

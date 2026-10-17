package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/brain"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// longAnswer is an answer long enough to be squeezed.
var longAnswer = strings.Repeat("I moved the cache to SQLite in WAL mode and the tests pass. ", 10)

// tldrEvent records one event in session s1 and returns its id.
func tldrEvent(t *testing.T, e *env, kind event.Kind, key, text string) int64 {
	t.Helper()
	ctx := context.Background()
	if err := store.UpsertSession(ctx, e.st.DB(), "s1", store.SessionPatch{Project: "caprock", LastEventAt: 1000, StartedAt: 1000, FromHook: true}); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"text": text})
	ev := event.Event{SessionID: "s1", Source: event.SourceTranscript, Kind: kind, Ts: time.UnixMilli(900), Key: key, Payload: payload}
	id, err := store.InsertEvent(ctx, e.st.DB(), &ev)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// countingRunner answers every squeeze with the same TL;DR and counts calls.
func countingRunner(calls *atomic.Int32) brain.Runner {
	return brain.RunnerFunc(func(_ context.Context, r brain.Request) (brain.Result, error) {
		calls.Add(1)
		if !r.Plain || r.Model != brain.TLDRModel {
			return brain.Result{}, fmt.Errorf("unexpected request %+v", r)
		}
		return brain.Result{Text: "Cache moved to SQLite WAL; tests pass.", Model: "claude-haiku-5-5", CostUSD: 0.0005}, nil
	})
}

func tldrDo(t *testing.T, e *env, id int64) (int, map[string]any) {
	t.Helper()
	return brainDo(t, e, "POST", fmt.Sprintf("/v1/events/%d/tldr", id), nil)
}

func TestTLDRSqueezesOnceThenServesTheCache(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	e.api.d.TLDR = countingRunner(&calls)
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", longAnswer)

	code, out := tldrDo(t, e, id)
	if code != 200 || out["tldr"] != "Cache moved to SQLite WAL; tests pass." || out["cached"] != false {
		t.Fatalf("first tap: %d %v", code, out)
	}
	code, out = tldrDo(t, e, id)
	if code != 200 || out["tldr"] != "Cache moved to SQLite WAL; tests pass." || out["cached"] != true {
		t.Fatalf("second tap: %d %v", code, out)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("claude was called %d times, want 1", n)
	}
	kept, ok, err := store.GetEventTLDR(context.Background(), e.st.DB(), id)
	if err != nil || !ok || kept.Model != "claude-haiku-5-5" || kept.CostUSD != 0.0005 || kept.CreatedAt == 0 {
		t.Errorf("kept %+v %v %v", kept, ok, err)
	}
}

func TestTLDRShortAnswerIsItsOwnTLDR(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	e.api.d.TLDR = countingRunner(&calls)
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", "  Done: the tests pass.  ")
	code, out := tldrDo(t, e, id)
	if code != 200 || out["tldr"] != "Done: the tests pass." || out["cached"] != false {
		t.Fatalf("%d %v", code, out)
	}
	if calls.Load() != 0 {
		t.Error("a short answer needs no call")
	}
	if _, ok, _ := store.GetEventTLDR(context.Background(), e.st.DB(), id); ok {
		t.Error("a short answer is not kept")
	}
}

func TestTLDRNotAnAnswerIs404(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	e.api.d.TLDR = countingRunner(&calls)
	prompt := tldrEvent(t, e, event.KindTurnUser, "u", longAnswer)
	for _, path := range []string{
		fmt.Sprintf("/v1/events/%d/tldr", prompt),
		"/v1/events/999999/tldr",
		"/v1/events/abc/tldr",
	} {
		if code, out := brainDo(t, e, "POST", path, nil); code != http.StatusNotFound {
			t.Errorf("%s: %d %v, want 404", path, code, out)
		}
	}
	if calls.Load() != 0 {
		t.Error("no call for what is not an answer")
	}
}

func TestTLDRWithoutClaudeIs503(t *testing.T) {
	e := newEnv(t)
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", longAnswer)
	// Not wired at all.
	if code, out := tldrDo(t, e, id); code != http.StatusServiceUnavailable || out["error"] == "" {
		t.Errorf("no runner: %d %v", code, out)
	}
	// Wired, but claude is not installed: what ClaudeRunner says.
	e.api.d.TLDR = brain.ClaudeRunner{Binary: func() string { return "" }}
	code, out := tldrDo(t, e, id)
	if code != http.StatusServiceUnavailable || !strings.Contains(fmt.Sprint(out["error"]), "Claude Code") {
		t.Errorf("no claude: %d %v", code, out)
	}
	if _, ok, _ := store.GetEventTLDR(context.Background(), e.st.DB(), id); ok {
		t.Error("nothing is kept from a failed call")
	}
}

func TestTLDRFailedCallIs502AndRetried(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	fail := true
	e.api.d.TLDR = brain.RunnerFunc(func(context.Context, brain.Request) (brain.Result, error) {
		calls.Add(1)
		if fail {
			return brain.Result{}, fmt.Errorf("claude: exit status 1: Invalid API key")
		}
		return brain.Result{Text: "Fine now."}, nil
	})
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", longAnswer)
	if code, out := tldrDo(t, e, id); code != http.StatusBadGateway || !strings.Contains(fmt.Sprint(out["error"]), "Invalid API key") {
		t.Errorf("failed call: %d %v", code, out)
	}
	fail = false
	if code, out := tldrDo(t, e, id); code != 200 || out["tldr"] != "Fine now." || out["cached"] != false {
		t.Errorf("retry: %d %v", code, out)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d; a failure is not kept", calls.Load())
	}
}

// Taps on the same answer while its squeeze runs share that one call.
func TestTLDRConcurrentTapsShareOneCall(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	e.api.d.TLDR = brain.RunnerFunc(func(context.Context, brain.Request) (brain.Result, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return brain.Result{Text: "One call."}, nil
	})
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", longAnswer)

	// The flight itself: a second ask while one runs gets the same call.
	first := e.api.tldrSqueeze(id, longAnswer)
	<-started
	if second := e.api.tldrSqueeze(id, longAnswer); second != first {
		t.Fatal("a second ask while the first runs started another call")
	}

	// And over HTTP: taps that arrive while it runs wait on it.
	const taps = 5
	var wg sync.WaitGroup
	codes := make([]int, taps)
	outs := make([]map[string]any, taps)
	for i := range taps {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], outs[i] = tldrDo(t, e, id)
		}(i)
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	<-first.done
	for i := range taps {
		if codes[i] != 200 || outs[i]["tldr"] != "One call." {
			t.Errorf("tap %d: %d %v", i, codes[i], outs[i])
		}
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("claude was called %d times, want 1", n)
	}
}

// A phone that controls may squeeze an answer; one that only views may not
// (it writes Caprock's cache and spends the user's claude).
func TestTLDRFromAControllerPhone(t *testing.T) {
	e := newEnv(t)
	var calls atomic.Int32
	id := tldrEvent(t, e, event.KindTurnAssistant, "a", longAnswer)
	s, _, viewer, controller := pairedPhones(t, Deps{Store: e.st, Bus: e.bus, TLDR: countingRunner(&calls)})
	path := fmt.Sprintf("/v1/events/%d/tldr", id)
	if w := call(t, s, testPhone, viewer.Token, "POST", path, ""); w.Code != http.StatusForbidden {
		t.Errorf("viewer: %d %s", w.Code, w.Body)
	}
	w := call(t, s, testPhone, controller.Token, "POST", path, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Cache moved to SQLite WAL") {
		t.Errorf("controller: %d %s", w.Code, w.Body)
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d", calls.Load())
	}
}

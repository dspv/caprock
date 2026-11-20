package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// TestSeedLargeDB writes a synthetic database at the scale of the owner's
// (~675k events in the heavy tables, 2026-11-20) for measuring the daemon's
// reads, without opening a real one. It runs only when asked:
//
//	CAPROCK_SEED_DB=/scratch/caprock.db CAPROCK_SEED_EVENTS=680000 \
//	  go test ./internal/store -run TestSeedLargeDB -count=1 -timeout 30m
//
// The repositories it names are created under CAPROCK_SEED_REPOS (default: a
// "repos" folder beside the database) with an empty .git, so sessions resolve
// to them exactly as a real checkout does. CAPROCK_SEED_LIVE=N then appends N
// turns (with their tool calls) to the newest sessions, now, which is how the
// measurement simulates agents working against a running daemon.
func TestSeedLargeDB(t *testing.T) {
	path := os.Getenv("CAPROCK_SEED_DB")
	if path == "" {
		t.Skip("CAPROCK_SEED_DB not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	repos := os.Getenv("CAPROCK_SEED_REPOS")
	if repos == "" {
		repos = filepath.Join(filepath.Dir(path), "repos")
	}
	if n, _ := strconv.Atoi(os.Getenv("CAPROCK_SEED_LIVE")); n > 0 {
		seedLive(t, s, repos, n)
		return
	}
	target, _ := strconv.Atoi(os.Getenv("CAPROCK_SEED_EVENTS"))
	if target <= 0 {
		target = 680_000
	}
	seedHistory(t, s, repos, target)
}

var seedRepoNames = []string{"caprock", "caprock-web", "amarketer", "infra", "notes", "mobile", "billing", "playground"}

var seedDirs = []string{"internal/store", "internal/api", "ui/src/components", "ui/src/screens", "cmd/caprock", ".ai", "docs", "scripts", "app/src", "testdata"}

var seedTools = []string{"Read", "Read", "Read", "Bash", "Bash", "Bash", "Edit", "Edit", "Grep", "Glob", "Write", "TodoWrite", "Agent"}

func seedRepoDir(t *testing.T, repos, name string) string {
	t.Helper()
	dir := filepath.Join(repos, name)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// seedSession writes one session of turns turns ending no later than end:
// each turn a user prompt every few turns, the assistant turn, and up to four
// tool calls with their results.
func seedSession(t *testing.T, q Querier, rng *rand.Rand, id, cwd, agent string, start time.Time, turns int, seq *int) int {
	t.Helper()
	ctx := context.Background()
	if err := UpsertSession(ctx, q, id, SessionPatch{Cwd: cwd, Model: "claude-opus-5", Agent: agent,
		StartedAt: start.UnixMilli(), LastEventAt: start.UnixMilli(), Status: StatusEnded}); err != nil {
		t.Fatal(err)
	}
	n := 0
	ts := start
	insert := func(ev *event.Event) {
		*seq++
		ev.SessionID, ev.Ts = id, ts
		if ev.Key == "" {
			ev.Key = fmt.Sprintf("k%d", *seq)
		}
		if _, err := InsertEvent(ctx, q, ev); err != nil {
			t.Fatal(err)
		}
		n++
		ts = ts.Add(time.Duration(500+rng.IntN(20_000)) * time.Millisecond)
	}
	model := "claude-opus-5"
	if rng.IntN(4) == 0 {
		model = "claude-sonnet-5"
	}
	for i := range turns {
		if i%5 == 0 {
			p, _ := json.Marshal(map[string]any{"prompt": strings.Repeat("please look at this ", 5+rng.IntN(30))})
			insert(&event.Event{Source: event.SourceTranscript, Kind: event.KindTurnUser, Payload: p})
		}
		msg := fmt.Sprintf("msg_%s_%d", id, i)
		cost := 0.001 + rng.Float64()*0.2
		m := model
		if rng.IntN(25) == 0 {
			m = "claude-haiku-4-5"
		}
		text, _ := json.Marshal(map[string]any{"text": strings.Repeat("Here is what I found. ", 5+rng.IntN(40))})
		insert(&event.Event{Source: event.SourceTranscript, Kind: event.KindTurnAssistant, Model: m, MsgID: msg,
			Key: "msg:" + msg, Payload: text, CostUSD: &cost,
			Tokens: &event.TokenDelta{In: int64(rng.IntN(50)), Out: int64(50 + rng.IntN(2000)),
				CacheRead: int64(20_000 + rng.IntN(150_000)), CacheWrite: int64(rng.IntN(8_000))}})
		for c := range rng.IntN(5) {
			tool := seedTools[rng.IntN(len(seedTools))]
			input := map[string]any{"command": "go test ./..."}
			if tool == "Read" || tool == "Edit" || tool == "Write" {
				input = map[string]any{"file_path": filepath.Join(cwd, seedDirs[rng.IntN(len(seedDirs))], fmt.Sprintf("f%d.go", rng.IntN(40)))}
			}
			use := fmt.Sprintf("toolu_%s_%d_%d", id, i, c)
			pre, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "session_id": id, "tool_name": tool,
				"tool_input": input, "tool_use_id": use, "message_id": msg, "_from": "transcript"})
			insert(&event.Event{Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: tool, MsgID: msg,
				Key: "pre:" + use, Payload: pre})
			size := 200 + rng.IntN(3_000)
			if rng.IntN(30) == 0 {
				size = 20_000 + rng.IntN(40_000)
			}
			post, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "session_id": id, "tool_name": tool,
				"tool_input": input, "tool_use_id": use, "tool_response": strings.Repeat("x", size)})
			insert(&event.Event{Source: event.SourceTranscript, Kind: event.KindToolPost, Tool: tool,
				Key: "post:" + use, Payload: post})
		}
	}
	if err := UpsertSession(ctx, q, id, SessionPatch{LastEventAt: ts.UnixMilli(), Status: StatusEnded}); err != nil {
		t.Fatal(err)
	}
	return n
}

func seedHistory(t *testing.T, s *Store, repos string, target int) {
	rng := rand.New(rand.NewPCG(1, 2))
	ctx := context.Background()
	now := time.Now()
	const days = 120
	total, seq, sess := 0, 0, 0
	for total < target {
		tx, err := s.DB().BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		for range 20 {
			if total >= target {
				break
			}
			sess++
			// Newer days are busier: a quarter of the sessions fall in the last two weeks.
			back := time.Duration(rng.Float64()*rng.Float64()*days*24) * time.Hour
			start := now.Add(-back - 2*time.Hour)
			cwd := seedRepoDir(t, repos, seedRepoNames[rng.IntN(len(seedRepoNames))])
			agent := "claude"
			if rng.IntN(8) == 0 {
				agent = "codex"
			}
			turns := 10 + rng.IntN(180)
			total += seedSession(t, tx, rng, fmt.Sprintf("seed-%05d", sess), cwd, agent, start, turns, &seq)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("seeded %d sessions, %d events", sess, total)
}

// seedLive appends n turns, now, to a few live sessions.
func seedLive(t *testing.T, s *Store, repos string, n int) {
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 3))
	seq := int(time.Now().UnixNano() % 1e9)
	for i := range n {
		id := fmt.Sprintf("live-%d", rng.IntN(3))
		cwd := seedRepoDir(t, repos, seedRepoNames[i%3])
		seedSession(t, s.DB(), rng, id, cwd, "claude", time.Now(), 1, &seq)
	}
}

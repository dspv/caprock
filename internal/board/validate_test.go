// What the board refuses to accept, and why each case was worth refusing.
//
// Every input here was accepted before: it produced an unnamed row on the
// board, a title longer than most files, a negative budget that breaks every
// "is there budget left" comparison, or an id that collided with another task
// created in the same millisecond.
package board

import (
	"context"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func TestCreateRejectsUnusableInput(t *testing.T) {
	ctx := context.Background()
	cases := map[string]map[string]any{
		"no title":         {"body": "x"},
		"empty title":      {"title": "", "body": "x"},
		"whitespace title": {"title": "   ", "body": "x"},
		"title too long":   {"title": strings.Repeat("A", 100_000), "body": "x"},
		"negative budget":  {"title": "t", "budget_usd": -100.0},
		"absurd budget":    {"title": "t", "budget_usd": 1e308},
		"NaN budget":       {"title": "t", "budget_usd": math.NaN()},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			b := newBoard(t)
			if _, err := b.Create(ctx, req); err == nil {
				t.Errorf("accepted %v; this reaches the board and the task file", req)
			}
		})
	}
}

// The refusals must not overshoot: an ordinary task still has to go through.
func TestCreateAcceptsAnOrdinaryTask(t *testing.T) {
	b := newBoard(t)
	out, err := b.Create(context.Background(), map[string]any{
		"title": "Add /healthz", "body": "notes", "budget_usd": 5.0,
	})
	if err != nil {
		t.Fatalf("a normal task was rejected: %v", err)
	}
	row := out.(map[string]any)["task"].(store.TaskRow)
	if row.Title != "Add /healthz" {
		t.Errorf("title = %q", row.Title)
	}
}

// A title is trimmed rather than rejected for stray whitespace, since a paste
// routinely carries some.
func TestCreateTrimsTheTitle(t *testing.T) {
	b := newBoard(t)
	out, err := b.Create(context.Background(), map[string]any{"title": "  spaced  ", "body": "x"})
	if err != nil {
		t.Fatal(err)
	}
	if got := out.(map[string]any)["task"].(store.TaskRow).Title; got != "spaced" {
		t.Errorf("title = %q; want it trimmed", got)
	}
}

// Ids were minted from the millisecond alone, so tasks created together
// collided: twelve concurrent creates produced four tasks and eight rejections,
// and the user silently lost most of what they added.
func TestConcurrentCreatesAllSucceed(t *testing.T) {
	b := newBoard(t) // Now() is fixed, so every id shares a millisecond
	ctx := context.Background()

	const n = 12
	var wg sync.WaitGroup
	var mu sync.Mutex
	ids := map[string]bool{}
	errs := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := b.Create(ctx, map[string]any{"title": "concurrent", "body": "x"})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs++
				return
			}
			ids[out.(map[string]any)["task"].(store.TaskRow).ID] = true
		}()
	}
	wg.Wait()

	if errs != 0 {
		t.Errorf("%d of %d concurrent creates failed; tasks added together must not collide", errs, n)
	}
	if len(ids) != n {
		t.Errorf("got %d distinct ids from %d creates", len(ids), n)
	}
}

package daemon

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/store"
)

// The handoff: what the last session in this repository left behind, given to
// the one now opening.
//
// Claude Code asks its SessionStart hook a question and will take text back;
// this answers with the last substantial thing an agent said in the same
// repository. Nothing is typed into anybody's process — the session asked, and
// this is the reply — so rule 7 is untouched.
//
// Why the *last* passage rather than a search: measured on the owner's own
// database, searching prior prose by the terms of the opening prompt helped in
// 4 of 15 resumed sessions and missed the clearest case of all ("напомни что мы
// последний раз изучали" — 384 candidate passages, no term overlap, because an
// opening question shares no words with its own answer). Recency answered 12 of
// 19. The cheap thing works better than the clever one here.

const (
	// handoffMaxRunes bounds what is injected. Claude Code documents no limit,
	// and there are reports of a SessionStart reply being silently dropped
	// above some undocumented size, so this is deliberately well short of any
	// plausible cap — and short enough that it costs a returning session a
	// couple of hundred tokens rather than a page of its context window.
	handoffMaxRunes = 1200
	// handoffMinRunes is the floor for a passage worth handing back. "Done." is
	// true and says nothing about where the work stood.
	handoffMinRunes = 400
	// handoffMaxAge is how stale a handoff may be. Beyond a fortnight the last
	// thing said is usually not what you are returning to, and presenting it as
	// context is worse than silence.
	handoffMaxAge = 14 * 24 * time.Hour
)

// handoff answers a SessionStart hook. An empty reply means "say nothing", and
// the session then starts exactly as it does today.
func (d *Daemon) handoff(ctx context.Context, p hookd.Payload) []byte {
	// Only a genuinely new session. SessionStart also fires on resume, on
	// /clear and after compaction: a resume already has the conversation, and
	// re-injecting the same passage after every compaction would turn a useful
	// note into noise that grows with the session.
	if p.Source != "startup" {
		return nil
	}
	project := store.ProjectFromCwd(p.Cwd)
	if project == "" {
		return nil
	}
	now := d.rec.Now()
	note, err := store.WhereWeLeftOff(ctx, d.store.DB(), project, now.UnixMilli(), handoffMinRunes)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			d.log.Warn("handoff lookup failed", "component", "daemon", "project", project, "err", err)
		}
		return nil // a repository nobody has worked in is not an error
	}
	age := now.Sub(time.UnixMilli(note.Ts))
	if age > handoffMaxAge {
		return nil
	}

	text := clipRunes(strings.TrimSpace(note.Text), handoffMaxRunes)
	if text == "" {
		return nil
	}
	body := fmt.Sprintf(
		"Where this repository was left, %s ago (from Caprock's record of the previous session — "+
			"the user has not said this to you, and it may be stale):\n\n%s",
		humanAge(age), text)

	reply, err := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": body,
		},
	})
	if err != nil {
		return nil
	}
	return reply
}

// clipRunes cuts to n runes at a sentence boundary where one is near the end,
// so a handoff does not stop mid-word.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)[:n]
	cut := string(r)
	if i := strings.LastIndexAny(cut, ".!?\n"); i > len(cut)*3/4 {
		return strings.TrimSpace(cut[:i+1])
	}
	return strings.TrimSpace(cut) + "…"
}

// humanAge is the coarse form a person reads: minutes, hours, or days.
func humanAge(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d minutes", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days", int(d.Hours()/24))
	}
}

// memoryStatus is what the status screen shows about the handoff: how many
// repositories it could speak for, and since when.
//
// A feature that acts before anyone types is one nobody can see working. This
// is how a person checks that it can, without opening a session to find out.
func (d *Daemon) memoryStatus() MemoryStatus {
	// A daemon assembled for a test may have no store; status must still answer.
	if d.store == nil || d.rec == nil {
		return MemoryStatus{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	repos, oldest, err := store.HandoffCoverage(ctx, d.store.DB(),
		d.rec.Now().Add(-handoffMaxAge).UnixMilli(), handoffMinRunes)
	if err != nil {
		return MemoryStatus{}
	}
	ms := MemoryStatus{Repos: repos}
	if oldest > 0 {
		ms.Since = time.UnixMilli(oldest).Format("2006-01-02")
	}
	return ms
}

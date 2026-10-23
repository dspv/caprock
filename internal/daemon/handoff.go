package daemon

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/hookd"
	"github.com/dspv/caprock/internal/relay"
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
// 4 of 15 resumed sessions and missed the clearest case of all ("remind me what
// we were looking into last time" — 384 candidate passages, no term overlap, because an
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
	// Switched off is switched off, read here rather than at registration so a
	// change takes effect on the next session rather than the next restart —
	// and under the lock, because the settings endpoint writes this while
	// sessions are opening.
	d.cfgMu.RLock()
	on := d.opt.Config.MemoryOn()
	holdout := d.opt.Config.MemoryHoldoutPct
	d.cfgMu.RUnlock()
	if !on {
		return nil
	}
	// Only a genuinely new session. SessionStart also fires on resume, on
	// /clear and after compaction: a resume already has the conversation, and
	// re-injecting the same passage after every compaction would turn a useful
	// note into noise that grows with the session.
	if p.Source != "startup" {
		return nil
	}
	// "/", the home directory and a temp directory are nobody's repository:
	// there is nothing of theirs to hand over, so the lookup is not even run.
	if store.NotAProject(p.Cwd) {
		return nil
	}
	project := store.ProjectFromCwd(p.Cwd)
	if project == "" {
		return nil
	}
	// A scheduled job's session (`automation: true` at its spawn) is handed
	// nothing and counted in neither group: it is not a person returning to
	// the repository, and Second Brain never reads it either.
	if auto, err := store.BrainAutomation(ctx, d.store.DB(), p.SessionID); err != nil {
		d.log.Warn("handoff automation lookup failed", "component", "daemon", "err", err)
	} else if auto {
		return nil
	}
	now := d.rec.Now()
	// The passage where the repository was left, when one is recent enough.
	text := ""
	var age time.Duration
	note, err := store.WhereWeLeftOff(ctx, d.store.DB(), project, now.UnixMilli(), handoffMinRunes)
	switch {
	case err == nil:
		age = now.Sub(time.UnixMilli(note.Ts))
		if age <= handoffMaxAge {
			text = relay.Clip(strings.TrimSpace(note.Text), handoffMaxRunes)
		}
	case !errors.Is(err, sql.ErrNoRows):
		d.log.Warn("handoff lookup failed", "component", "daemon", "project", project, "err", err)
	}
	// Second Brain's current decisions and memories go with it, or alone
	// when there is no recent passage — unless the folder is one the user
	// excluded from Second Brain, which is handed the passage only.
	var pick store.BrainHandoffPick
	if !d.brainExcludedFolder(p.Cwd) {
		var err error
		if pick, err = store.BrainHandoff(ctx, d.store.DB(), project); err != nil {
			d.log.Warn("handoff memories lookup failed", "component", "daemon", "project", project, "err", err)
			pick = store.BrainHandoffPick{}
		}
	}
	if text == "" && pick.Text == "" {
		return nil // a repository nobody has worked in is not an error
	}
	// There is something to hand over. Whether it was, is recorded either way,
	// so the sessions that got it can be compared with the ones that could
	// have and did not — the only way to learn whether it helps (see
	// store.HandoffEffect). Held back at random, never by any property of the
	// session, or the two groups would differ for reasons of their own.
	state := store.HandoffServed
	if holdout > 0 && d.holdoutRoll() < holdout {
		state = store.HandoffWithheld
	}
	if err := store.SetHandoff(ctx, d.store.DB(), p.SessionID, state); err != nil {
		d.log.Warn("could not record the handoff", "component", "daemon", "err", err)
	}
	if state == store.HandoffWithheld {
		return nil
	}
	body := ""
	if text != "" {
		body = fmt.Sprintf(
			"Where this repository was left, %s ago (from Caprock's record of the previous session — "+
				"the user has not said this to you, and it may be stale):\n\n%s",
			relay.HumanAge(age), text)
	}
	if pick.Text != "" {
		if body != "" {
			body += "\n\n"
		}
		body += pick.Text
	}
	// Its length, so delivery can be measured (migration 0069).
	if err := store.SetHandoffRunes(ctx, d.store.DB(), p.SessionID, utf8.RuneCountInString(body)); err != nil {
		d.log.Warn("could not record the handoff's length", "component", "daemon", "err", err)
	}
	if n := pick.Count(); n > 0 {
		// Counted, so the Second Brain screen can say how often agents start
		// with its memories (migration 0058).
		if err := store.SetHandoffBrain(ctx, d.store.DB(), p.SessionID, n); err != nil {
			d.log.Warn("could not record the handoff's memories", "component", "daemon", "err", err)
		}
		// Said on the live socket, so the sidebar can show the memories
		// going into the new session's tab. A held-back session returned
		// above and gets no frame: nothing was handed to it.
		if d.bus != nil {
			d.bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: map[string]any{
				"op": "handoff", "session": p.SessionID, "project": project, "memories": n,
			}})
		}
	}

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

// holdoutRoll is a number in [0, 100), behind a field so a test can decide
// which group a session falls in.
func (d *Daemon) holdoutRoll() int {
	if d.roll != nil {
		return d.roll()
	}
	return rand.IntN(100)
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
	if held, err := store.ProseSince(ctx, d.store.DB()); err == nil && held > 0 {
		ms.Held = time.UnixMilli(held).Format("2006-01-02")
	}
	d.cfgMu.RLock()
	ms.HoldoutPct = d.opt.Config.MemoryHoldoutPct
	d.cfgMu.RUnlock()
	if s, w, err := store.HandoffEffect(ctx, d.store.DB()); err == nil && s.Sessions+w.Sessions > 0 {
		ms.Served, ms.Withheld = &s, &w
	}
	return ms
}

// brainHandoffState is whether a new session in the project would be served
// a handoff now, by the rules handoff applies: Memory between sessions on,
// and a passage of the repository's within handoffMaxAge. The holdout is
// reported, not rolled.
func (d *Daemon) brainHandoffState(ctx context.Context, project string) api.BrainHandoffState {
	d.cfgMu.RLock()
	st := api.BrainHandoffState{On: d.opt.Config.MemoryOn(), HoldoutPct: d.opt.Config.MemoryHoldoutPct}
	d.cfgMu.RUnlock()
	now := d.rec.Now()
	if note, err := store.WhereWeLeftOff(ctx, d.store.DB(), project, now.UnixMilli(), handoffMinRunes); err == nil &&
		now.Sub(time.UnixMilli(note.Ts)) <= handoffMaxAge && strings.TrimSpace(note.Text) != "" {
		st.LeftOffAt = note.Ts
	}
	return st
}

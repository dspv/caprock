package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/dspv/caprock/internal/loop"
)

// The Stage 2 gate: what a compaction boundary COSTS.
//
// Compacting is not free. The summary drops detail the model then goes and
// fetches again: files it had already read, commands it had already run. The
// $578 saving estimated in Stage 0 does not include that, and the spec refuses
// to ship the intervention until it does -- if re-reads eat more than half the
// saving, a lower threshold moves cost rather than removing it.
//
// This measures it from transcripts that already contain real boundaries,
// which is the only honest way to learn it: nothing here simulates a
// compaction, it reads what actually happened after 39 of them.

// Reread is one boundary's audit.
type Reread struct {
	Session string `json:"session"`
	Project string `json:"project"`
	Turn    int    `json:"turn"` // the boundary's assistant-turn index

	// TurnsAfter is how much session followed the boundary. A boundary at the
	// very end of a session has nothing to re-read and must not be counted as
	// evidence that compaction is cheap.
	TurnsAfter int `json:"turns_after"`

	// PathsBefore is how many distinct files were in context before the
	// boundary; PathsAgain how many of them were fetched again after it.
	PathsBefore int `json:"paths_before"`
	PathsAgain  int `json:"paths_again"`
	// CmdsBefore/CmdsAgain are the same for Bash commands, matched on the
	// normalised command text.
	CmdsBefore int `json:"cmds_before"`
	CmdsAgain  int `json:"cmds_again"`

	// TokensAgain is what those repeat fetches put back into context. This is
	// the number the gate turns on: it is the cost the estimate omitted.
	// ContextBefore is the context the session carried when the boundary fired.
	// It is what decides whether a boundary is evidence for the intervention
	// at all: compacting at 998k, which is what the default does, drops far
	// less than compacting at 250k, which is what the paid lever would set.
	ContextBefore int `json:"context_before"`

	TokensAgain int `json:"tokens_again"`
	// TokensAfter is everything the calls after the boundary returned, so the
	// re-read share of post-boundary work is visible rather than only its
	// absolute size.
	TokensAfter int `json:"tokens_after"`
}

// touched names what a call put into context, so a later call can be
// recognised as fetching the same thing again. A Read is keyed by its path, a
// Bash by its normalised command; anything else is not comparable and is
// skipped rather than guessed at.
func touched(e Event) (key string, ok bool) {
	switch e.Tool {
	case "Read", "NotebookRead":
		if e.Path != "" {
			return "path:" + e.Path, true
		}
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		// An edit reads the file it edits. Counting it makes a re-edit after a
		// boundary look like a re-read, which is exactly what it is: the model
		// had to look at the file again to change it again.
		if e.Path != "" {
			return "path:" + e.Path, true
		}
	case "Bash":
		// The loop detector's own normalisation, so "the same command" means
		// here what it means in the alert a user sees: temp paths, hex and
		// numbers collapsed, so a command that differs only by a run id is
		// still recognised as a repeat.
		if e.Command == "" {
			return "", false
		}
		// The payload shape matters: Signature reads tool_input, and a flat
		// {"command": ...} is silently ignored -- every command then hashes to
		// the same value and the whole audit collapses to one command.
		in, err := json.Marshal(map[string]any{"tool_input": map[string]string{"command": e.Command}})
		if err != nil {
			return "", false
		}
		sig, _ := loop.Signature("Bash", in)
		if sig != "" {
			return "cmd:" + sig, true
		}
	}
	return "", false
}

// AuditRereads measures every compaction boundary in a session.
func AuditRereads(s Session) []Reread {
	if len(s.CompactAt) == 0 {
		return nil
	}
	lastTurn := 0
	for _, e := range s.Events {
		if e.Turn > lastTurn {
			lastTurn = e.Turn
		}
	}
	var out []Reread
	for _, at := range s.CompactAt {
		r := Reread{Session: s.ID, Project: s.Project, Turn: at, TurnsAfter: lastTurn - at}
		// The largest context seen before the boundary: what the compaction
		// actually had to discard.
		for _, e := range s.Events {
			if e.Turn < at && e.ContextAtCall > r.ContextBefore {
				r.ContextBefore = e.ContextAtCall
			}
		}
		// What was in context before this boundary. Everything before it
		// counts, not only since the previous boundary: a file read early,
		// carried through one compaction and re-read after the next was still
		// re-read because a summary dropped it.
		before := map[string]bool{}
		for _, e := range s.Events {
			if e.Turn >= at {
				continue
			}
			if k, ok := touched(e); ok {
				before[k] = true
			}
		}
		seen := map[string]bool{}
		for _, e := range s.Events {
			if e.Turn < at {
				continue
			}
			r.TokensAfter += e.Tokens
			k, ok := touched(e)
			if !ok || !before[k] {
				continue
			}
			// A file fetched three times after a boundary is one re-read of a
			// dropped file plus two ordinary repeats; only the first is
			// attributable to the compaction.
			if seen[k] {
				continue
			}
			seen[k] = true
			r.TokensAgain += e.Tokens
			if strings.HasPrefix(k, "path:") {
				r.PathsAgain++
			} else {
				r.CmdsAgain++
			}
		}
		for k := range before {
			if strings.HasPrefix(k, "path:") {
				r.PathsBefore++
			} else {
				r.CmdsBefore++
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TokensAgain > out[j].TokensAgain })
	return out
}

// RereadReport is the archive-wide answer to "what does a compaction cost".
type RereadReport struct {
	Sessions   int `json:"sessions_with_boundaries"`
	Boundaries int `json:"boundaries"`
	// Measurable is how many boundaries had enough session after them to say
	// anything. A boundary in the last few turns cannot demonstrate that
	// compaction is cheap; it only demonstrates that nothing came after it.
	Measurable int      `json:"measurable_boundaries"`
	Rereads    []Reread `json:"rereads"`

	TokensAgain int `json:"tokens_again"`
	TokensAfter int `json:"tokens_after"`
	PathsAgain  int `json:"paths_again"`
	CmdsAgain   int `json:"cmds_again"`

	// EarlyBoundaries is how many measurable boundaries fired below
	// EarlyContext -- the only ones that are evidence about the intervention,
	// which compacts EARLY. A boundary at 998k is the default firing at the
	// ceiling; it discards little and so re-reads little, and counting it as
	// evidence that early compaction is cheap would be the wrong inference.
	EarlyBoundaries  int `json:"early_boundaries"`
	EarlyTokensAgain int `json:"early_tokens_again"`
	EarlyTokensAfter int `json:"early_tokens_after"`
}

// EarlyContext is the ceiling below which a boundary tells us something about
// compacting sooner. The spec's candidate points start at 250k and the grid
// runs to 500k; a boundary above this is the default's behaviour, not the
// lever's.
const EarlyContext = 500_000

// MinTurnsAfter is how much session must follow a boundary for its re-read
// figure to mean anything. Ten assistant turns is roughly the span in which
// the model re-establishes what it was doing; below that a zero says only that
// the session ended.
const MinTurnsAfter = 10

// AnalyseRereads audits every boundary in the archive.
func AnalyseRereads(all []Session) RereadReport {
	var rep RereadReport
	for _, s := range all {
		rr := AuditRereads(s)
		if len(rr) == 0 {
			continue
		}
		rep.Sessions++
		rep.Boundaries += len(rr)
		for _, r := range rr {
			if r.TurnsAfter < MinTurnsAfter {
				continue
			}
			rep.Measurable++
			rep.Rereads = append(rep.Rereads, r)
			rep.TokensAgain += r.TokensAgain
			rep.TokensAfter += r.TokensAfter
			rep.PathsAgain += r.PathsAgain
			rep.CmdsAgain += r.CmdsAgain
			if r.ContextBefore > 0 && r.ContextBefore < EarlyContext {
				rep.EarlyBoundaries++
				rep.EarlyTokensAgain += r.TokensAgain
				rep.EarlyTokensAfter += r.TokensAfter
			}
		}
	}
	sort.Slice(rep.Rereads, func(i, j int) bool {
		return rep.Rereads[i].TokensAgain > rep.Rereads[j].TokensAgain
	})
	return rep
}

// ReadShare is the fraction of post-boundary tool output that was material the
// summary had dropped. It is not yet the gate -- the gate compares dollars
// against an estimated saving -- but it is the shape of the answer.
func (r RereadReport) ReadShare() float64 {
	if r.TokensAfter == 0 {
		return 0
	}
	return float64(r.TokensAgain) / float64(r.TokensAfter)
}

func (r RereadReport) Text() string {
	var b strings.Builder
	b.WriteString("Compaction re-read audit (spec section 6.1, the Stage 2 gate)\n\n")
	fmt.Fprintf(&b, "  sessions with a boundary   %d\n", r.Sessions)
	fmt.Fprintf(&b, "  boundaries                 %d\n", r.Boundaries)
	fmt.Fprintf(&b, "  measurable (>=%d turns after) %d\n", MinTurnsAfter, r.Measurable)
	if r.Measurable == 0 {
		b.WriteString("\n  Nothing measurable: every boundary sits at the end of its session.\n")
		return b.String()
	}
	fmt.Fprintf(&b, "\n  tokens re-read after a boundary   %d\n", r.TokensAgain)
	fmt.Fprintf(&b, "  tokens returned after a boundary  %d\n", r.TokensAfter)
	fmt.Fprintf(&b, "  re-read share of post-boundary work %.1f%%\n", 100*r.ReadShare())
	fmt.Fprintf(&b, "  distinct files re-read            %d\n", r.PathsAgain)
	fmt.Fprintf(&b, "  distinct commands re-run          %d\n", r.CmdsAgain)
	fmt.Fprintf(&b, "\n  boundaries below %dk of context     %d of %d\n", EarlyContext/1000, r.EarlyBoundaries, r.Measurable)
	if r.EarlyBoundaries == 0 {
		b.WriteString("\n  THE GATE IS NOT ANSWERED BY THIS ARCHIVE.\n")
		b.WriteString("  Every measurable boundary fired near the ceiling of the context window,\n")
		b.WriteString("  which is the default compacting when it has no choice. The intervention\n")
		b.WriteString("  compacts EARLY, and an early boundary discards more, so it must re-read\n")
		b.WriteString("  more. The figure above is a floor for the default's behaviour, not an\n")
		b.WriteString("  estimate of the lever's cost. Answering the gate needs boundaries that\n")
		b.WriteString("  fired below the threshold the lever would set -- which means running at a\n")
		b.WriteString("  lower autoCompactWindow first and measuring what that does.\n")
	} else {
		fmt.Fprintf(&b, "  re-read share below %dk           %.1f%%\n", EarlyContext/1000,
			100*float64(r.EarlyTokensAgain)/float64(max(1, r.EarlyTokensAfter)))
	}
	b.WriteString("\n  Worst boundaries by tokens re-read:\n")
	for i, x := range r.Rereads {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&b, "    %-10s turn %-5d ctx %4dk  %7d tok re-read of %8d after  (%d files, %d cmds)\n",
			trunc(x.Project, 10), x.Turn, x.ContextBefore/1000, x.TokensAgain, x.TokensAfter, x.PathsAgain, x.CmdsAgain)
	}
	return b.String()
}

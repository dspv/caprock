// Command routing-spike measures how much of a Claude Code archive is bulk I/O
// that could be routed to a cheap worker model.
//
// It is Stage 0 of the routing-savings spec: the measurement that decides
// whether the rest of the feature is built. It writes nothing, changes nothing,
// and reads only the transcripts Claude Code already keeps.
//
//	go run ./cmd/routing-spike                       # ~/.claude/projects
//	go run ./cmd/routing-spike -dir /path/to/projects
//	go run ./cmd/routing-spike -json                 # machine-readable
//
// # What it counts, and why that is not obvious
//
// The unit is **tokens**, taken from the transcript's own `usage` accounting,
// never bytes on disk. A screenshot is 600 KB of base64 and about 1.5k tokens;
// measuring bytes makes images look like the dominant cost when they are not.
// An earlier pass of this spike made exactly that mistake and reached the
// opposite conclusion, which is why `-bytes` still exists: it reproduces the
// wrong answer beside the right one so the size of the error stays visible.
//
// The cost of a tool result is not its size either. Content written into the
// context is billed once as a cache write and then re-read on every remaining
// turn, so a file read early in a long session is charged many times over. The
// spec's unit is therefore `T * (1 + turns_left)` — token-turns — and the
// denominator is every context token-turn in the same sessions, not just the
// tool results. Both errors have burned this product before: counting each
// re-read at full price overstates, counting only the first read understates.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	dir := flag.String("dir", defaultDir(), "root of Claude Code transcripts")
	asJSON := flag.Bool("json", false, "emit JSON instead of a report")
	showBytes := flag.Bool("bytes", false, "also report the byte-based figures, to show how wrong they are")
	// One very long session can dominate the denominator — on the owner's
	// archive a single 20k-turn session is 58% of it. Excluding the largest
	// sessions shows whether a verdict is a property of the archive or of one
	// outlier, which is a question the spec's kill criteria cannot answer alone.
	drop := flag.Int("drop-largest", 0, "exclude the N largest sessions by context token-turns")
	// The context-tax spec asks for the dev session to be excluded by project
	// name rather than by size, so the exclusion is a stated rule and not a
	// number chosen after seeing the answer.
	exclude := flag.String("exclude-project", "", "comma-separated project names to exclude (context-tax spec §8)")
	tax := flag.Bool("tax", false, "run the context-tax analysis (spec sections 5.3-5.5)")
	// The Edit/Write rule refuses the most expensive series on this archive, so
	// the kill decision needs to be readable with and without it. The spec
	// permits edits to files created inside the series; the transcript cannot
	// tell which those are, so this flag brackets the answer instead.
	allowEdits := flag.Bool("allow-edits", false, "count series containing Edit/Write as eligible (upper bound)")
	flag.Parse()

	files, err := transcripts(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scan:", err)
		os.Exit(1)
	}
	if len(files) == 0 {
		fmt.Fprintf(os.Stderr, "no transcripts under %s\n", *dir)
		os.Exit(1)
	}

	var all []Session
	for _, f := range files {
		s, err := ParseSession(f)
		if err != nil || s == nil {
			continue
		}
		all = append(all, *s)
	}
	// Subagent transcripts are separate files under <session>/subagents/. They
	// are the measured basis for C_sub0 and are never counted as sessions of
	// their own: a subagent's context is the thing isolation creates, not a
	// session the user ran.
	var main_, subs []Session
	for _, s := range all {
		if strings.Contains(s.Path, "/subagents/") {
			subs = append(subs, s)
		} else {
			main_ = append(main_, s)
		}
	}
	all = main_

	excluded := 0
	if *exclude != "" {
		var kept []Session
		names := strings.Split(*exclude, ",")
		for _, s := range all {
			drop := false
			// Matched against the project directory exactly, not as a
			// substring of the path. `-Users-ds-dev-caprock` as a substring
			// also catches the orchestrator's scratchpad runs
			// (`-private-tmp-...--Users-ds-dev-caprock-<uuid>-scratchpad-...`),
			// which are Caprock being exercised rather than Caprock being
			// written — a different population, and 21 of the 43 it removed.
			dirName := filepath.Base(filepath.Dir(s.Path))
			for _, n := range names {
				if n = strings.TrimSpace(n); n != "" && dirName == n {
					drop = true
					break
				}
			}
			if drop {
				excluded++
				continue
			}
			kept = append(kept, s)
		}
		all = kept
	}
	if *drop > 0 {
		all = dropLargest(all, *drop)
	}

	if *tax {
		cSub0 := measureCSub0(subs)
		rule := DefaultRule
		rule.AllowEdits = *allowEdits
		tr := AnalyseTax(all, rule, cSub0, 1_000, 500)
		tr.Excluded = excluded
		if *asJSON {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(tr)
			return
		}
		fmt.Print(tr.Text())
		return
	}

	rep := Analyse(all)
	rep.Root = *dir
	rep.FilesScanned = len(files)

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
		return
	}
	fmt.Print(rep.Text(*showBytes))
}

// measureCSub0 is the median peak context of a real subagent run.
//
// The spec guesses 25k. Measuring it matters because it sits inside the
// isolation counterfactual: guessing low would inflate the saving, which is
// the direction that would sell the feature rather than test it.
func measureCSub0(subs []Session) int {
	// The first turn's context, not the peak. C_sub0 is what a subagent starts
	// with; everything after is its own accumulating results, which the
	// counterfactual already adds call by call. Using the peak would charge
	// that growth twice.
	var peaks []int
	for _, s := range subs {
		first := 0
		for _, e := range s.Events {
			if e.ContextAtCall > 0 {
				first = e.ContextAtCall
				break
			}
		}
		if first > 0 {
			peaks = append(peaks, first)
		}
	}
	if len(peaks) == 0 {
		return 25_000 // the spec's default, when there is nothing to measure
	}
	sort.Ints(peaks)
	return peaks[len(peaks)/2]
}

// dropLargest removes the n sessions with the most context token-turns.
func dropLargest(in []Session, n int) []Session {
	if n >= len(in) {
		return nil
	}
	s := append([]Session(nil), in...)
	sort.Slice(s, func(i, j int) bool { return s[i].ContextTokenTurns > s[j].ContextTokenTurns })
	return s[n:]
}

func defaultDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ".claude/projects"
	}
	return filepath.Join(h, ".claude", "projects")
}

// transcripts finds every .jsonl under root, at any depth. A missing directory
// is reported rather than treated as an empty archive: "no transcripts" and
// "wrong path" are different answers and only one of them is interesting.
func transcripts(root string) ([]string, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	var out []string
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			// An unreadable entry is skipped rather than aborting the walk: one
			// bad permission in a 400-transcript archive must not lose the run.
			return nil //nolint:nilerr // deliberate: skip and keep scanning
		}
		if !info.IsDir() && strings.HasSuffix(p, ".jsonl") {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

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
	if *drop > 0 {
		all = dropLargest(all, *drop)
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
			return nil // unreadable entry: skip, keep scanning
		}
		if !info.IsDir() && strings.HasSuffix(p, ".jsonl") {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

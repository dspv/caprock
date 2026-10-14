package projects

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// The instruction files a repository keeps for agents itself: Claude Code
// reads CLAUDE.md (at the root or in .claude/), Codex and Grok AGENTS.md.
// They are not Caprock's project instructions (`defaults.system_prompt`),
// which Caprock hands to each session it starts; the app shows both, so
// whether a project's agents are told anything is in sight where an agent
// is started (.ai/03-contracts.md § Projects).

// InstructionFileNames are looked for at a folder's top, in this order.
var InstructionFileNames = []string{"CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"}

// MaxInstructionBytes is how much of one instruction file a scan returns.
const MaxInstructionBytes = 64 << 10

// InstructionFile is one instruction file a scan found, with its text.
type InstructionFile struct {
	Name      string `json:"name"` // slash form, below the scanned folder
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

// instructionFileNames are the instruction files at dir's top that are
// regular files (a symbolic link to one counts), in InstructionFileNames
// order; nil when there are none. A stat each, nothing read.
func instructionFileNames(dir string) []string {
	var out []string
	for _, n := range InstructionFileNames {
		if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(n))); err == nil && st.Mode().IsRegular() {
			out = append(out, n)
		}
	}
	return out
}

// readInstructionFiles reads the instruction files at dir's top, each cut
// at MaxInstructionBytes on a rune boundary; one that is not text is left out.
func readInstructionFiles(dir string) []InstructionFile {
	var out []InstructionFile
	for _, n := range instructionFileNames(dir) {
		f, err := os.Open(filepath.Join(dir, filepath.FromSlash(n)))
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(f, MaxInstructionBytes+1))
		_ = f.Close()
		if err != nil {
			continue
		}
		cut := len(b) > MaxInstructionBytes
		if cut {
			b = b[:MaxInstructionBytes]
			// Back off a rune cut in half, at most three bytes.
			for i := 0; i < utf8.UTFMax-1 && len(b) > 0 && !utf8.Valid(b); i++ {
				b = b[:len(b)-1]
			}
		}
		if !utf8.Valid(b) || strings.ContainsRune(string(b), 0) {
			continue
		}
		out = append(out, InstructionFile{Name: n, Text: string(b), Truncated: cut})
	}
	return out
}

// projectInstructionFiles are a project's instruction files: those at its
// root, then each member's below it as "<member>/<file>" (ADR-055). A
// member outside the root is left out: its files cannot be read through the
// project's file API.
func projectInstructionFiles(root string, members []RepoView) []string {
	out := instructionFileNames(root)
	for _, m := range members {
		if !m.Exists {
			continue
		}
		rel, err := filepath.Rel(root, m.Path)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			continue
		}
		for _, n := range instructionFileNames(m.Path) {
			out = append(out, filepath.ToSlash(rel)+"/"+n)
		}
	}
	return out
}

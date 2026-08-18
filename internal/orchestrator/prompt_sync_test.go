package orchestrator

import (
	"os"
	"strings"
	"testing"
)

// The embedded prompt.txt must stay in sync with the § SYSTEM PROMPT block in
// .ai/07-orchestrator.md (the human-editable source of record).
func TestPromptInSyncWithDoc(t *testing.T) {
	md, err := os.ReadFile("../../.ai/07-orchestrator.md")
	if err != nil {
		t.Skip("doc not found")
	}
	s := string(md)
	i := strings.Index(s, "## SYSTEM PROMPT (verbatim)")
	if i < 0 {
		t.Fatal("no SYSTEM PROMPT block in doc")
	}
	block := s[i:]
	block = block[strings.Index(block, "\n")+1:]
	block = strings.TrimLeft(block, "\n")
	if strings.TrimSpace(block) != strings.TrimSpace(systemPrompt) {
		t.Fatalf("prompt.txt out of sync with .ai/07-orchestrator.md — regenerate prompt.txt from the doc's SYSTEM PROMPT block")
	}
}

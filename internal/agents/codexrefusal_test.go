package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/codex"
)

// A Codex session that prints the refusal, split over reads, has its model
// remembered; a Claude session printing the same text does not.
func TestWatchRefusalRemembersTheModelCodexRefused(t *testing.T) {
	home := t.TempDir()
	t.Setenv(codex.EnvHome, home)
	cache := `{"models":[{"slug":"gpt-6.2-sol","display_name":"GPT-6.2-Sol","visibility":"list","priority":1},{"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","priority":2}]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}
	codex.SetStateDir(t.TempDir())
	t.Cleanup(func() { codex.SetStateDir("") })

	msg := "■ The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account."
	claude := &Agent{Kind: "claude"}
	claude.watchRefusal([]byte(msg))
	if m := codex.ListedModels(); m[len(m)-1].Refused {
		t.Fatalf("a Claude session marked a Codex model: %+v", m)
	}

	a := &Agent{Kind: "codex", retry: &SpawnRequest{Agent: "codex", Model: "gpt-6.2-sol"}}
	a.watchRefusal([]byte(strings.Repeat("x", 3000) + msg[:30]))
	a.watchRefusal([]byte(msg[30:]))
	m := codex.ListedModels()
	if m[0].ID != "gpt-5.5" || !m[1].Refused || m[1].ID != "gpt-6.2-sol" {
		t.Fatalf("after the refusal: %+v", m)
	}
	if !a.refusal.done {
		t.Fatal("the watch did not stop after the refusal")
	}
}

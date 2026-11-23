package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The refusal as Codex printed it on 2026-11-23, and as a terminal may draw
// it: wrapped, coloured, split by cursor moves.
func TestRefusedModelReadsCodexsRefusal(t *testing.T) {
	raw := `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}`
	for name, tc := range map[string]struct{ out, fallback, want string }{
		"json":                  {raw, "", "gpt-6.2-sol"},
		"wrapped and coloured":  {"\x1b[31m■ The 'gpt-6.2-sol' model is not\r\n  supported when \x1b[1Gusing Codex with a ChatGPT account.\x1b[0m", "", "gpt-6.2-sol"},
		"code only, -m given":   {`{"code":"model_not_found"}`, "gpt-6.2-astra", "gpt-6.2-astra"},
		"code only, no -m":      {`{"code":"model_not_found"}`, "", ""},
		"other output":          {"Working… model gpt-6.2-sol", "gpt-6.2-sol", ""},
		"unrelated API refusal": {"The 'x' model does not exist", "x", ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := RefusedModel([]byte(tc.out), tc.fallback); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func chatgptHome(t *testing.T, plan string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv(EnvHome, home)
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(home, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("models_cache.json", signInCache)
	write("auth.json", `{"auth_mode":"chatgpt","tokens":{"id_token":"`+fakeIDToken(plan)+`"}}`)
	write("config.toml", "model = \"gpt-6.2-sol\"\n")
	return home
}

func useStateDir(t *testing.T) {
	t.Helper()
	SetStateDir(t.TempDir())
	t.Cleanup(func() { SetStateDir(""); refusedNow = time.Now })
}

func ids(ms []Model) string {
	var s []string
	for _, m := range ms {
		s = append(s, m.ID)
	}
	return strings.Join(s, ",")
}

func TestARefusedModelIsListedLastMarkedAndNeverTheDefault(t *testing.T) {
	home := chatgptHome(t, "pro")
	useStateDir(t)
	if DefaultModel() != "gpt-6.2-sol" {
		t.Fatalf("before: default %q", DefaultModel())
	}
	NoteRefused("gpt-6.2-sol")
	got := ListedModels()
	if ids(got) != "gpt-6-luna,gpt-chat-only,gpt-5.5,gpt-6.2-sol" {
		t.Fatalf("order: %s", ids(got))
	}
	last := got[len(got)-1]
	if !last.Refused || last.Label != "GPT-6.2-Sol · "+RefusedNote {
		t.Fatalf("last: %+v", last)
	}
	if got[0].Refused {
		t.Fatalf("first marked: %+v", got[0])
	}
	if d := DefaultModel(); d != "" {
		t.Fatalf("refused model offered as the default: %q", d)
	}
	// Nothing is written under CODEX_HOME.
	if _, err := os.Stat(filepath.Join(home, refusedFile)); err == nil {
		t.Fatal("wrote into CODEX_HOME")
	}
}

func TestARefusalHoldsOnlyForItsSignInAndItsMonth(t *testing.T) {
	chatgptHome(t, "plus")
	useStateDir(t)
	NoteRefused("gpt-6.2-sol")
	if !ListedModels()[len(ListedModels())-1].Refused {
		t.Fatal("not marked on the sign-in it was learnt on")
	}

	// Another plan: starts over.
	chatgptHome(t, "pro")
	for _, m := range ListedModels() {
		if m.Refused {
			t.Fatalf("still marked after the plan changed: %+v", m)
		}
	}

	// Back on the first sign-in, a month and a day later: forgotten.
	chatgptHome(t, "plus")
	NoteRefused("gpt-6.2-sol")
	refusedNow = func() time.Time { return time.Now().Add(RefusedFor + 24*time.Hour) }
	for _, m := range ListedModels() {
		if m.Refused {
			t.Fatalf("still marked after RefusedFor: %+v", m)
		}
	}
}

func TestNothingIsRememberedWithoutAStateDir(t *testing.T) {
	chatgptHome(t, "pro")
	SetStateDir("")
	NoteRefused("gpt-6.2-sol")
	for _, m := range ListedModels() {
		if m.Refused {
			t.Fatalf("marked: %+v", m)
		}
	}
}

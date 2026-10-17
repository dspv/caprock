package subs

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/hooks"
)

func TestLoginCommandQuotesTheDirectory(t *testing.T) {
	dir := "/Users/me/Library/Application Support/caprock/profiles/ab12"
	got := LoginCommand(AgentClaude, dir, "darwin")
	want := "CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/caprock/profiles/ab12' claude auth login"
	if got != want {
		t.Fatalf("claude:\n got %s\nwant %s", got, want)
	}
	if got := LoginCommand(AgentCodex, "/a/it's", "linux"); got != `CODEX_HOME='/a/it'\''s' codex login` {
		t.Fatalf("codex quoting: %s", got)
	}
	if got := LoginCommand(AgentCodex, `C:\Users\me\AppData\Roaming\caprock\profiles\ab12`, "windows"); got != `$env:CODEX_HOME='C:\Users\me\AppData\Roaming\caprock\profiles\ab12'; codex login` {
		t.Fatalf("windows: %s", got)
	}
	if got := LoginCommand(AgentClaude, "", "darwin"); got != "claude auth login" {
		t.Fatalf("default: %s", got)
	}
}

func TestValidIDKeepsRequestsInsideProfiles(t *testing.T) {
	for _, bad := range []string{"", "..", "../x", "a/b", "A1", "default", strings.Repeat("a", 33), `a\b`} {
		if ValidID(bad) {
			t.Errorf("ValidID(%q) = true", bad)
		}
	}
	id, err := NewID()
	if err != nil || !ValidID(id) {
		t.Fatalf("NewID() = %q, %v", id, err)
	}
	if err := Remove(t.TempDir(), "../etc"); err == nil {
		t.Fatal("Remove accepted a path")
	}
}

func TestCountIncludesDefault(t *testing.T) {
	list := []config.Subscription{{ID: "a", Agent: "claude"}, {ID: "b", Agent: "codex"}, {ID: "c", Agent: "claude"}}
	if got := Count(list, "claude"); got != 3 {
		t.Fatalf("claude count = %d", got)
	}
	if got := Count(list, "codex"); got != 2 {
		t.Fatalf("codex count = %d", got)
	}
}

func TestCleanLabel(t *testing.T) {
	if got, err := CleanLabel("  Work   Max "); err != nil || got != "Work Max" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := CleanLabel("   "); err == nil {
		t.Fatal("empty label accepted")
	}
	if _, err := CleanLabel(strings.Repeat("é", MaxLabel+1)); err == nil {
		t.Fatal("long label accepted")
	}
}

func TestPrepareClaudeWritesHooksStatuslineAndConsent(t *testing.T) {
	data := t.TempDir()
	def := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(def, []byte(`{"skipDangerousModePermissionPrompt": true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := Dir(data, "ab12")
	if err := Prepare(AgentClaude, dir, "/x/caprock-hook", "/x/caprock statusline", def); err != nil {
		t.Fatal(err)
	}
	sp := filepath.Join(dir, "settings.json")
	st, err := hooks.Inspect(sp, "/x/caprock-hook")
	if err != nil || len(st.Missing) != 0 {
		t.Fatalf("hooks: %+v %v", st, err)
	}
	if ours, _, err := hooks.StatuslineInstalled(sp, "/x/caprock statusline"); err != nil || !ours {
		t.Fatalf("statusline ours=%v err=%v", ours, err)
	}
	if ok, _ := hooks.BypassAccepted(sp); !ok {
		t.Fatal("bypass consent not carried over")
	}
	// Again: nothing breaks, nothing doubles.
	if err := Prepare(AgentClaude, dir, "/x/caprock-hook", "/x/caprock statusline", def); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", fi.Mode().Perm())
	}
}

func TestPrepareCodexMakesOnlyTheDirectory(t *testing.T) {
	dir := Dir(t.TempDir(), "cd34")
	if err := Prepare(AgentCodex, dir, "/x/hook", "/x/sl", ""); err != nil {
		t.Fatal(err)
	}
	ents, err := os.ReadDir(dir)
	if err != nil || len(ents) != 0 {
		t.Fatalf("codex dir has %d entries, %v", len(ents), err)
	}
	if err := Prepare(AgentCodex, "relative", "", "", ""); err == nil {
		t.Fatal("relative dir accepted")
	}
}

func TestStatusReadsFilesOnly(t *testing.T) {
	dir := t.TempDir()
	p := ProfilePaths(AgentClaude, dir)
	if got := Status(p); got.SignedIn {
		t.Fatal("empty dir signed in")
	}
	if err := os.WriteFile(p.GlobalConfig, []byte(`{"projects":{},"oauthAccount":{"emailAddress":"me@example.com"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Status(p); !got.SignedIn || got.Account != "me@example.com" {
		t.Fatalf("claude: %+v", got)
	}

	cx := t.TempDir()
	if got := Status(ProfilePaths(AgentCodex, cx)); got.SignedIn {
		t.Fatal("codex empty dir signed in")
	}
	claims := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"dev@example.com"}`))
	auth := `{"tokens":{"id_token":"h.` + claims + `.s"}}`
	if err := os.WriteFile(filepath.Join(cx, "auth.json"), []byte(auth), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := Status(ProfilePaths(AgentCodex, cx)); !got.SignedIn || got.Account != "dev@example.com" {
		t.Fatalf("codex: %+v", got)
	}
}

func TestOfNamesTheSubscriptionFromAPath(t *testing.T) {
	data := filepath.Join(t.TempDir(), "caprock")
	tr := filepath.Join(Dir(data, "ab12"), "projects", "-x", "s.jsonl")
	if got := Of(data, tr); got != "ab12" {
		t.Fatalf("Of = %q", got)
	}
	if got := Of(data, filepath.Join(t.TempDir(), ".claude", "projects", "s.jsonl")); got != "" {
		t.Fatalf("outside = %q", got)
	}
	if got := OfDir(data, Dir(data, "ab12")+string(os.PathSeparator)); got != "ab12" {
		t.Fatalf("OfDir = %q", got)
	}
	if got := OfDir(data, filepath.Join(Dir(data, "ab12"), "x")); got != "" {
		t.Fatalf("OfDir nested = %q", got)
	}
}

func TestDefaultPathsHonourTheEnvironment(t *testing.T) {
	none := func(string) string { return "" }
	if p := DefaultPaths(AgentClaude, "/h", none); p.Dir != filepath.Join("/h", ".claude") || p.GlobalConfig != filepath.Join("/h", ".claude.json") {
		t.Fatalf("%+v", p)
	}
	set := func(k string) string {
		if k == "CODEX_HOME" {
			return "/elsewhere"
		}
		return ""
	}
	if p := DefaultPaths(AgentCodex, "/h", set); p.Dir != "/elsewhere" {
		t.Fatalf("%+v", p)
	}
}

func TestLogoutCommandIsPointedLikeLogin(t *testing.T) {
	dir := "/Users/me/Library/Application Support/caprock/profiles/ab12"
	if got := LogoutCommand(AgentClaude, dir, "darwin"); got != "CLAUDE_CONFIG_DIR='"+dir+"' claude auth logout" {
		t.Fatalf("claude: %s", got)
	}
	if got := LogoutCommand(AgentCodex, `C:\p\ab12`, "windows"); got != `$env:CODEX_HOME='C:\p\ab12'; codex logout` {
		t.Fatalf("codex windows: %s", got)
	}
}

// The expected names were computed the way the Claude Code 2.1.302 bundle
// does it (node: createHash("sha256").update(dir.normalize("NFC"))), not
// with this code. A decomposed accent hashes as its composed form.
func TestKeychainServiceMatchesClaudeCode(t *testing.T) {
	for dir, want := range map[string]string{
		"": "Claude Code-credentials",
		"/Users/me/Library/Application Support/caprock/profiles/ab12": "Claude Code-credentials-cffcd5e3",
		"/Users/cafe\u0301/p": "Claude Code-credentials-a18661dd",
		"/Users/caf\u00e9/p":  "Claude Code-credentials-a18661dd",
	} {
		if got := KeychainService(dir); got != want {
			t.Errorf("KeychainService(%q) = %s, want %s", dir, got, want)
		}
	}
}

func TestCredentialEnvSetNamesOnlyWhatIsSet(t *testing.T) {
	env := []string{"ANTHROPIC_API_KEY=sk", "CLAUDE_CODE_OAUTH_TOKEN= ", "PATH=/bin", "CODEX_API_KEY=x", "ANTHROPIC_PROFILE=work"}
	if got := strings.Join(CredentialEnvSet(AgentClaude, env), ","); got != "ANTHROPIC_API_KEY,ANTHROPIC_PROFILE" {
		t.Errorf("claude: %s", got)
	}
	if got := strings.Join(CredentialEnvSet(AgentCodex, env), ","); got != "CODEX_API_KEY" {
		t.Errorf("codex: %s", got)
	}
	if got := CredentialEnvSet(AgentCodex, []string{"OPENAI_API_KEY=sk"}); len(got) != 0 {
		t.Errorf("OPENAI_API_KEY is not a Codex sign-in: %v", got)
	}
}

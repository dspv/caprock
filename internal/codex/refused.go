package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Models that did not run on this sign-in: learnt from failure, because the
// cache cannot tell. Current Codex drops `available_in_plans` when it writes
// models_cache.json, so for a ChatGPT account a model the server refuses
// ("The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT
// account", 2026-11-23) is still listed. When a session Caprock started
// prints that refusal, the model is remembered here, and the New agent
// dialog lists it last with a note, never as the default.
//
// The file is Caprock's own (`<data dir>/codex-refused-models.json`), never
// anything under $CODEX_HOME. What it remembers holds for the sign-in it was
// learnt on: a different mode or plan in auth.json starts it over. An entry
// is forgotten after RefusedFor, since a plan's models change over time.

// RefusedFor is how long a model that did not run stays marked.
var RefusedFor = 30 * 24 * time.Hour

// refusedFile is the file's name in Caprock's data directory.
const refusedFile = "codex-refused-models.json"

var (
	refusedMu  sync.Mutex
	refusedDir string
	// refusedNow is the clock, for tests.
	refusedNow = time.Now
)

// SetStateDir is Caprock's data directory, where the models that did not run
// are kept. Until it is set nothing is remembered.
func SetStateDir(dir string) {
	refusedMu.Lock()
	refusedDir = dir
	refusedMu.Unlock()
}

// refusedState is the file: the sign-in it was learnt on and, per model id,
// when it was last refused (unix ms).
type refusedState struct {
	SignIn string           `json:"sign_in"`
	Models map[string]int64 `json:"models"`
}

// key is a sign-in as the file names it: its mode and plan, no identity.
func (s signIn) key() string { return s.mode + "/" + s.plan }

// refusalRe is Codex's refusal with the whitespace taken out: a terminal
// wraps the line anywhere, and a model id has no spaces.
var refusalRe = regexp.MustCompile(`The'([^'\s]{1,120})'modelisnotsupportedwhenusingCodex`)

// ansiRe matches terminal escape sequences (CSI and OSC), dropped before
// the refusal is looked for.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// RefusedModel is the model a piece of Codex output says the account cannot
// use, or "" when it says no such thing. `model_not_found` without a name in
// the text answers fallback — the model the session was started with.
func RefusedModel(out []byte, fallback string) string {
	s := ansiRe.ReplaceAllString(string(out), "")
	flat := strings.Join(strings.Fields(s), "")
	if m := refusalRe.FindStringSubmatch(flat); m != nil {
		return m[1]
	}
	if strings.Contains(flat, "model_not_found") || strings.Contains(flat, "modelisnotsupportedwhenusingCodex") {
		return fallback
	}
	return ""
}

// NoteRefused remembers that model did not run on the current sign-in.
func NoteRefused(model string) {
	model = strings.TrimSpace(model)
	refusedMu.Lock()
	defer refusedMu.Unlock()
	if refusedDir == "" || model == "" {
		return
	}
	in := readSignIn(Home())
	st := loadRefusedLocked(in)
	st.Models[model] = refusedNow().UnixMilli()
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	path := filepath.Join(refusedDir, refusedFile)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

// refusedModels is what is remembered for this sign-in, still in date.
func refusedModels(in signIn) map[string]bool {
	refusedMu.Lock()
	defer refusedMu.Unlock()
	out := map[string]bool{}
	if refusedDir == "" {
		return out
	}
	for m := range loadRefusedLocked(in).Models {
		out[m] = true
	}
	return out
}

// loadRefusedLocked reads the file for this sign-in: empty when there is
// none, it was learnt on another sign-in, or it is unreadable; entries past
// RefusedFor are left out.
func loadRefusedLocked(in signIn) refusedState {
	st := refusedState{SignIn: in.key(), Models: map[string]int64{}}
	b, err := os.ReadFile(filepath.Join(refusedDir, refusedFile))
	if err != nil {
		return st
	}
	var got refusedState
	if json.Unmarshal(b, &got) != nil || got.SignIn != in.key() {
		return st
	}
	cutoff := refusedNow().Add(-RefusedFor).UnixMilli()
	for m, at := range got.Models {
		if at >= cutoff {
			st.Models[m] = at
		}
	}
	return st
}

// RefusedNote is what the dialog says next to a model that did not run.
const RefusedNote = "didn't run on your account"

// DefaultModel is ConfiguredModel unless that model did not run on this
// sign-in: a refused model is never offered as the default.
func DefaultModel() string {
	m := ConfiguredModel()
	if m != "" && refusedModels(readSignIn(Home()))[m] {
		return ""
	}
	return m
}

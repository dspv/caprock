package codex

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Model is one model the Codex CLI offers in its own picker.
type Model struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Refused: a session Caprock started on this model was refused by
	// Codex on the current sign-in (refused.go). Listed last, its label
	// carries RefusedNote, and it is never the default.
	Refused bool `json:"refused,omitempty"`
	// DefaultEffort is the reasoning effort Codex runs it at by default.
	DefaultEffort string `json:"-"`
}

// ListedModels is the models Codex itself lists, read from the catalog it
// caches at `$CODEX_HOME/models_cache.json`, in the order of its own picker.
//
// Read from the CLI's cache rather than written into Caprock: the catalog is
// per account and changes with Codex releases, and the Claude and Gemini lists
// in the dialog were both wrong the first time they were written from memory.
// Only `visibility: "list"` entries are offered — the rest are Codex's own
// machinery (`codex-auto-review`) or hidden. Empty when there is no cache.
//
// Then filtered by what the signed-in account can run (readSignIn), as
// Codex's own picker does: `ModelPreset::filter_by_auth` in codex-rs/protocol
// (src/openai_models.rs) keeps only `supported_in_api` models when the
// sign-in does not go through the Codex backend (an API key, Bedrock), and
// every model for a ChatGPT account. For a ChatGPT account whose plan is
// known, an entry that carries `available_in_plans` without that plan is
// dropped too — the server refuses it ("The 'gpt-6.2-sol' model is not
// supported when using Codex with a ChatGPT account", 2026-11-23). Current
// Codex does not keep that field when it writes its cache, so for most caches
// nothing tells, and the model stays listed — until a session Caprock started
// on it is refused: then it is listed last, labelled RefusedNote (refused.go).
func ListedModels() []Model {
	home := Home()
	if home == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(home, "models_cache.json"))
	if err != nil {
		return nil
	}
	var cache struct {
		Models []cachedModel `json:"models"`
	}
	if err := json.Unmarshal(b, &cache); err != nil {
		return nil
	}
	in := readSignIn(home)
	sort.SliceStable(cache.Models, func(i, j int) bool { return cache.Models[i].Priority < cache.Models[j].Priority })
	refused := refusedModels(in)
	var out, last []Model
	for _, m := range cache.Models {
		if m.Visibility != "list" || m.Slug == "" || !in.canRun(m.SupportedInAPI, m.Plans) {
			continue
		}
		label := m.DisplayName
		if label == "" {
			label = m.Slug
		}
		if refused[m.Slug] {
			last = append(last, Model{ID: m.Slug, Label: label + " · " + RefusedNote, Refused: true, DefaultEffort: m.DefaultReasoningLevel})
			continue
		}
		out = append(out, Model{ID: m.Slug, Label: label, DefaultEffort: m.DefaultReasoningLevel})
	}
	return append(out, last...)
}

// signIn is how Codex is signed in, as far as ListedModels needs it.
type signIn struct {
	// mode is Codex's AuthMode as auth.json spells it ("chatgpt", "apikey",
	// …), or "" when there is no auth.json to read: Codex can keep its
	// credentials in the OS keyring instead.
	mode string
	// plan is the ChatGPT plan ("plus", "pro", "free", …) from the
	// `chatgpt_plan_type` claim of the sign-in, or "" when unknown.
	plan string
}

// apiModes are Codex's sign-ins that call the model API directly rather than
// through the Codex backend (AuthMode::uses_codex_backend is false in
// codex-rs/app-server-protocol): only `supported_in_api` models run on them.
var apiModes = map[string]bool{"apikey": true, "bedrockApiKey": true, "bedrockAccessKeys": true}

// canRun is whether a catalog entry runs on this sign-in. A field the entry
// does not carry, or a sign-in Caprock could not read, keeps the model: when
// nothing tells, it is offered, and the dialog's default stays config.toml's.
func (s signIn) canRun(supportedInAPI *bool, plans []string) bool {
	if apiModes[s.mode] {
		return supportedInAPI == nil || *supportedInAPI
	}
	if s.mode == "" || s.plan == "" || len(plans) == 0 {
		return true
	}
	for _, p := range plans {
		if strings.EqualFold(p, s.plan) {
			return true
		}
	}
	return false
}

// readSignIn reads the sign-in mode from `$CODEX_HOME/auth.json` the way
// Codex resolves it (AuthDotJson::resolved_mode in codex-rs/login): an
// explicit `auth_mode`, else a personal access token, a Bedrock key, an
// `OPENAI_API_KEY`, and otherwise a ChatGPT login. For a ChatGPT login the
// plan is the `https://api.openai.com/auth` → `chatgpt_plan_type` claim of
// its id_token, which Codex reads the same way (codex-rs/login
// token_data.rs). Only those two words are kept: no token is copied, stored
// or logged.
func readSignIn(home string) signIn {
	b, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil {
		return signIn{}
	}
	var a struct {
		AuthMode            string          `json:"auth_mode"`
		OpenAIAPIKey        json.RawMessage `json:"OPENAI_API_KEY"`
		PersonalAccessToken json.RawMessage `json:"personal_access_token"`
		BedrockAPIKey       json.RawMessage `json:"bedrock_api_key"`
		BedrockAccessKeys   json.RawMessage `json:"bedrock_access_keys"`
		Tokens              *struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(b, &a) != nil {
		return signIn{}
	}
	set := func(r json.RawMessage) bool { return len(r) > 0 && string(r) != "null" }
	var s signIn
	switch {
	case a.AuthMode != "":
		s.mode = a.AuthMode
	case set(a.PersonalAccessToken):
		s.mode = "personalAccessToken"
	case set(a.BedrockAPIKey):
		s.mode = "bedrockApiKey"
	case set(a.BedrockAccessKeys):
		s.mode = "bedrockAccessKeys"
	case set(a.OpenAIAPIKey):
		s.mode = "apikey"
	default:
		s.mode = "chatgpt"
	}
	if (s.mode == "chatgpt" || s.mode == "chatgptAuthTokens") && a.Tokens != nil {
		s.plan = planClaim(a.Tokens.IDToken)
	}
	return s
}

// planClaim is the `chatgpt_plan_type` claim of a JWT's payload, or "". The
// signature is not checked: the plan only narrows a list, and Codex keys its
// own cache on the same unverified claim.
func planClaim(jwt string) string {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Auth struct {
			Plan string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return strings.TrimSpace(claims.Auth.Plan)
}

// cachedModel is one model in models_cache.json, Codex's own ModelInfo
// (codex-rs/protocol/src/openai_models.rs: `slug`, `default_reasoning_level`
// and the rest, read 2026-11-23).
type cachedModel struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Visibility  string `json:"visibility"`
	Priority    int    `json:"priority"`
	// DefaultReasoningLevel is the effort Codex runs the model at when
	// config.toml names none: codex-rs/core/src/client.rs takes the
	// configured effort `.or_else(|| model_info.default_reasoning_level)`.
	DefaultReasoningLevel string `json:"default_reasoning_level"`
	// Absent in a cache is "can't tell", not false.
	SupportedInAPI *bool    `json:"supported_in_api"`
	Plans          []string `json:"available_in_plans"`
}

// ConfiguredModel is the `model = "…"` set at the top of
// `$CODEX_HOME/config.toml` — what a session started without -m runs on — or
// "" when none is set. Only the top-level key is read: a `model` inside a
// [profile] table applies to that profile, not to a plain start.
func ConfiguredModel() string { return topLevelString("model") }

// ConfiguredEffort is the top-level `model_reasoning_effort = "…"` in
// `$CODEX_HOME/config.toml`, the effort every session started without one
// runs at, or "" when none is set.
func ConfiguredEffort() string { return topLevelString("model_reasoning_effort") }

// topLevelString is the string value of key at the top level of
// `$CODEX_HOME/config.toml`, "" when it is not set there.
func topLevelString(name string) string {
	home := Home()
	if home == "" {
		return ""
	}
	f, err := os.Open(filepath.Join(home, "config.toml"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			return "" // a table began; the top level had no model
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != name {
			continue
		}
		val = strings.TrimSpace(val)
		if i := strings.Index(val, "#"); i > 0 && !strings.HasPrefix(val, `"`) {
			val = strings.TrimSpace(val[:i])
		}
		if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') {
			if j := strings.IndexByte(val[1:], val[0]); j >= 0 {
				return val[1 : 1+j]
			}
		}
		return ""
	}
	return ""
}

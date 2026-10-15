package ai

import (
	"net"
	"net/url"
	"strings"
)

// The providers Mail's assistant can ask.
const (
	ProviderClaude     = "claude"     // the user's Claude Code login, through `claude -p`
	ProviderCodex      = "codex"      // the user's Codex login, through `codex exec`
	ProviderGemini     = "gemini"     // the user's Gemini CLI login, through `gemini -p`
	ProviderAnthropic  = "anthropic"  // Anthropic's Messages API with the user's key
	ProviderOpenAI     = "openai"     // OpenAI's API with the user's key
	ProviderOpenRouter = "openrouter" // OpenRouter with the user's key
	ProviderDeepSeek   = "deepseek"   // DeepSeek's API with the user's key
	ProviderLocal      = "local"      // an OpenAI-compatible server the user runs (Ollama by default)
)

// Kinds of provider.
const (
	KindCLI   = "cli"   // a coding CLI the user is logged in to
	KindAPI   = "api"   // a cloud API that takes the user's key
	KindLocal = "local" // a server at an address the user gives
)

// Info describes one provider for the settings panel.
type Info struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
	// Command is the CLI's command name (KindCLI).
	Command string `json:"command,omitempty"`
	// URL is the API base (KindAPI).
	URL string `json:"-"`
	// Model is the model used when the user leaves the field empty; "" for a
	// CLI means the CLI's own default.
	Model string `json:"default_model,omitempty"`
	// NeedsModel: no call is made until a model is typed.
	NeedsModel bool `json:"needs_model,omitempty"`
	// ModelHint is the model field's placeholder.
	ModelHint string `json:"model_hint,omitempty"`
	// SendsTo says where the mail text goes when an AI action runs (ADR-047).
	SendsTo string `json:"sends_to"`
}

// Providers is every provider, in the order the picker lists them.
var Providers = []Info{
	{ID: ProviderClaude, Label: "Claude Code", Kind: KindCLI, Command: "claude",
		ModelHint: "haiku, sonnet or opus; empty is your Claude Code default",
		SendsTo:   "Anthropic, through your Claude Code login (the claude command on this computer)"},
	{ID: ProviderCodex, Label: "Codex", Kind: KindCLI, Command: "codex",
		ModelHint: "empty is your Codex default",
		SendsTo:   "OpenAI, through your Codex login (the codex command on this computer)"},
	{ID: ProviderGemini, Label: "Gemini CLI", Kind: KindCLI, Command: "gemini",
		ModelHint: "empty is your Gemini CLI default",
		SendsTo:   "Google, through your Gemini CLI login (the gemini command on this computer)"},
	{ID: ProviderAnthropic, Label: "Anthropic API", Kind: KindAPI, URL: AnthropicURL,
		Model: "claude-haiku-5-5", ModelHint: "claude-haiku-5-5",
		SendsTo: "api.anthropic.com, with your API key"},
	{ID: ProviderOpenAI, Label: "OpenAI API", Kind: KindAPI, URL: "https://api.openai.com/v1",
		NeedsModel: true, ModelHint: "a model id from your OpenAI account",
		SendsTo: "api.openai.com, with your API key"},
	{ID: ProviderOpenRouter, Label: "OpenRouter", Kind: KindAPI, URL: "https://openrouter.ai/api/v1",
		NeedsModel: true, ModelHint: "vendor/model, as openrouter.ai/models lists it",
		SendsTo: "openrouter.ai with your API key, which passes it on to the model's vendor"},
	{ID: ProviderDeepSeek, Label: "DeepSeek API", Kind: KindAPI, URL: "https://api.deepseek.com/v1",
		Model: "deepseek-chat", ModelHint: "deepseek-chat",
		SendsTo: "api.deepseek.com, with your API key"},
	{ID: ProviderLocal, Label: "Local model", Kind: KindLocal,
		SendsTo: "the model server on this computer"},
}

// AutoOrder is the order "Automatic" tries: the user's CLIs first, so a
// machine with claude works with no setup, then a local server.
var AutoOrder = []string{ProviderClaude, ProviderCodex, ProviderGemini, ProviderLocal}

// Lookup finds a provider by id.
func Lookup(id string) (Info, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Info{}, false
}

// DefaultModel is the model a provider uses when none is set.
func DefaultModel(id string) string {
	p, _ := Lookup(id)
	return p.Model
}

// LocalSendsTo says where a local-kind server is: on this computer when its
// host is loopback, else the address itself, so a URL pointed at another
// machine is never described as local.
func LocalSendsTo(raw string) string {
	if raw == "" {
		raw = DefaultURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "the model server at " + raw
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return "the model server on this computer (" + u.Host + "); nothing leaves it"
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return "the model server on this computer (" + u.Host + "); nothing leaves it"
	}
	return "the model server at " + u.Host
}

package agents

import "strings"

// Claude Code on DeepSeek: a Claude Code session whose model calls go to
// DeepSeek's Anthropic-compatible API on the user's own DeepSeek key, picked
// as "DeepSeek" beside the user's sign-ins (subs.DeepSeekID).
//
// The variables are DeepSeek's own published set for Claude Code
// (api-docs.deepseek.com/quick_start/agent_integrations/claude_code, read
// 2026-10-13), less CLAUDE_CODE_EFFORT_LEVEL=max: how hard the model thinks
// is the user's choice in the session, not Caprock's to raise for them.
// ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY: Claude Code sends it as
// `Authorization: Bearer`, which DeepSeek accepts, and it takes precedence
// over a saved claude.ai login at once, where an API key waits for a one-time
// approval in the session (code.claude.com/docs/en/llm-gateway-connect, read
// 2026-10-13).

// DeepSeekBaseURL is DeepSeek's Anthropic-compatible endpoint.
const DeepSeekBaseURL = "https://api.deepseek.com/anthropic"

// DeepSeekModel is the model every tier maps to. The `[1m]` suffix tells
// Claude Code the model has a 1M-token context; Claude Code does not send it.
const DeepSeekModel = "deepseek-flash"

// providerConflicts are variables in the user's login-shell environment that
// would send the session somewhere else or with another credential: an
// Anthropic key would ride along as `x-api-key`, and a cloud-provider switch
// would route around the base URL entirely.
var providerConflicts = []string{
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"ANTHROPIC_SMALL_FAST_MODEL",
}

// deepSeekEnv is the environment a Claude Code session on DeepSeek adds. The
// key goes here and nowhere else: not on the command line, where `ps` shows
// it, and not in the database.
func deepSeekEnv(key string) []string {
	long := DeepSeekModel + "[1m]"
	return []string{
		"ANTHROPIC_BASE_URL=" + DeepSeekBaseURL,
		"ANTHROPIC_AUTH_TOKEN=" + key,
		"ANTHROPIC_MODEL=" + long,
		"ANTHROPIC_DEFAULT_OPUS_MODEL=" + long,
		"ANTHROPIC_DEFAULT_SONNET_MODEL=" + long,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=" + DeepSeekModel,
		"CLAUDE_CODE_SUBAGENT_MODEL=" + DeepSeekModel,
		// DeepSeek's figure: the point at which Claude Code compacts, inside
		// the 1M context.
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432",
	}
}

// withDeepSeek is env for a session on DeepSeek: the conflicting variables
// removed, then DeepSeek's set over whatever the login shell exported.
func withDeepSeek(env []string, key string) []string {
	return withEnv(withoutEnv(env, providerConflicts), deepSeekEnv(key))
}

// Claude Code on Kimi: the same shape as DeepSeek, on Moonshot's
// Anthropic-compatible API with the user's own Kimi platform key (subs.KimiID).
//
// The variables are Moonshot's own published set for Claude Code
// (platform.kimi.ai/docs/guide/claude-code-kimi, read 2026-11-03), less
// CLAUDE_CODE_EFFORT_LEVEL=max for the reason DeepSeek's set is without it.
// The page names kimi-k3[1m] for every tier but Haiku, and kimi-k2.7-code
// for Haiku; it states no price, and Caprock states none either.

// KimiBaseURL is Moonshot's Anthropic-compatible endpoint
// (platform.kimi.ai/docs/api/overview and the guide above, read 2026-11-03).
const KimiBaseURL = "https://api.moonshot.ai/anthropic"

// KimiModel is the model the guide maps every tier but Haiku to; the `[1m]`
// suffix is the guide's own. KimiFastModel is its Haiku tier.
const (
	KimiModel     = "kimi-k3[1m]"
	KimiFastModel = "kimi-k2.7-code"
)

// kimiEnv is the environment a Claude Code session on Kimi adds. The key
// goes here and nowhere else, as DeepSeek's does.
func kimiEnv(key string) []string {
	return []string{
		"ANTHROPIC_BASE_URL=" + KimiBaseURL,
		"ANTHROPIC_AUTH_TOKEN=" + key,
		"ANTHROPIC_MODEL=" + KimiModel,
		"ANTHROPIC_DEFAULT_OPUS_MODEL=" + KimiModel,
		"ANTHROPIC_DEFAULT_SONNET_MODEL=" + KimiModel,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL=" + KimiFastModel,
		"ANTHROPIC_DEFAULT_FABLE_MODEL=" + KimiModel,
		"CLAUDE_CODE_SUBAGENT_MODEL=" + KimiModel,
		// The guide's figure: compact inside the 1M context.
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000",
	}
}

// withKimi is env for a session on Kimi: the conflicting variables removed,
// then Moonshot's set over whatever the login shell exported.
func withKimi(env []string, key string) []string {
	return withEnv(withoutEnv(env, providerConflicts), kimiEnv(key))
}

// withoutEnv drops the named variables. Case-insensitive, because Windows
// environment names are.
func withoutEnv(env []string, names []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		k := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			k = kv[:i]
		}
		drop := false
		for _, n := range names {
			if strings.EqualFold(k, n) {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out
}

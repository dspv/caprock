package api

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
)

// A session's description is what tells one card from the next (FB-035). An
// ended card used to carry the project, a short id and the last narrated state
// — "ended" or "waiting for you" on nearly every one — so a list of them was a
// list of identical rows.
//
// The agent's own name for the session comes first: Claude Code's ai-title is
// the name its /resume picker shows, so it is the name the user already knows
// the session by. Without one, the first prompt that says something.
const (
	descriptionMaxRunes = 120
	// minPromptRunes drops the prompts that name nothing: "так", "say ok",
	// "проверь". A session that opened with one of those usually said what it
	// was about in the next.
	minPromptRunes = 12
	promptsScanned = 8
)

// DescriptionSource says where a description came from.
const (
	DescriptionTitle  = "title"
	DescriptionPrompt = "prompt"
)

func describe(ctx context.Context, q store.Querier, sess store.Session) (text, source string) {
	if t := clipLine(sess.Title); t != "" {
		return t, DescriptionTitle
	}
	prompts, err := store.FirstPrompts(ctx, q, sess.SessionID, promptsScanned)
	if err != nil {
		return "", ""
	}
	// An agent whose prompts are not events (Codex) has its first one stored
	// on the session instead.
	if sess.Prompt != "" {
		prompts = append([]string{sess.Prompt}, prompts...)
	}
	for _, p := range prompts {
		if substantivePrompt(p) {
			return clipLine(p), DescriptionPrompt
		}
	}
	return "", ""
}

// substantivePrompt rejects what Claude Code records as a prompt without the
// user having said anything: the wrappers it puts around slash commands,
// notifications and reminders (all start with a tag), a bare pasted path, and
// one-word nudges.
func substantivePrompt(p string) bool {
	p = strings.TrimSpace(p)
	if p == "" || strings.HasPrefix(p, "<") || strings.HasPrefix(p, "[Image") {
		return false
	}
	if !strings.ContainsAny(p, " \t\n") && (strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") || strings.HasPrefix(p, `"/`)) {
		return false
	}
	return utf8.RuneCountInString(p) >= minPromptRunes
}

// clipLine is the first non-empty line, whitespace collapsed, cut on a rune
// boundary with an ellipsis.
func clipLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line == "" {
			continue
		}
		if utf8.RuneCountInString(line) <= descriptionMaxRunes {
			return line
		}
		r := []rune(line)
		return strings.TrimSpace(string(r[:descriptionMaxRunes-1])) + "…"
	}
	return ""
}

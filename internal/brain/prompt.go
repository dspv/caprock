package brain

import (
	"fmt"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// System is the extraction's instructions.
const System = `You keep a developer's second brain. You are given the prose of one coding-agent session: the user's prompts and the agent's answers, numbered as passages. Pick out the memories worth keeping weeks from now:
- decision: what was chosen, and why;
- finding: what turned out to be true;
- idea: something worth trying later;
- question: something still open.
Skip routine progress, tool chatter, greetings, and anything true only for the moment. Fewer is better: at most 8, and none is right for a session that settled nothing.
Title: one line of at most 80 characters that states the thing itself ("Keep SQLite in WAL mode for the cache"), never "Discussed X".
Summary: at most 400 characters of plain text, the why and the context someone needs later.
Topics: one to three short lowercase noun phrases; when one of the existing topics fits, use its exact spelling.
Passage: the number of the passage the memory comes from.
Related: indexes (0-based) of other memories in your answer this one builds on; contradicts: the ones it contradicts.
Write titles and summaries in the language the session was written in. Answer only with the JSON asked for.`

// Schema is the shape of the answer, for --json-schema.
const Schema = `{"type":"object","properties":{"memories":{"type":"array","maxItems":8,"items":{"type":"object","properties":{"kind":{"type":"string","enum":["idea","decision","finding","question"]},"title":{"type":"string"},"summary":{"type":"string"},"topics":{"type":"array","items":{"type":"string"},"maxItems":3},"passage":{"type":"integer"},"related":{"type":"array","items":{"type":"integer"}},"contradicts":{"type":"array","items":{"type":"integer"}}},"required":["kind","title","summary","topics"]}}},"required":["memories"]}`

// Limits on what one read sends.
const (
	// MaxInputChars is the most transcript one read sends; when a session
	// has more, the newest is kept, where its conclusions are.
	MaxInputChars = 24000
	// promptChars and answerChars clip one passage.
	promptChars = 600
	answerChars = 2500
	// MinProseRunes is how much of the agent's own prose a session needs
	// before it is worth a read; less is a quick question, and is skipped.
	MinProseRunes = 300
)

// Input is one session's transcript as the extraction sends it.
type Input struct {
	Prompt   string
	Passages []store.BrainPassage // in the order numbered, 1-based
	// ProseRunes is how much of the agent's prose there is, before clipping.
	ProseRunes int
}

// BuildInput numbers a session's passages and writes the prompt: the
// project, the topics already in the brain, then the passages, newest kept
// when they do not all fit.
func BuildInput(project string, topics []string, passages []store.BrainPassage) Input {
	in := Input{}
	type line struct {
		p    store.BrainPassage
		text string
	}
	var lines []line
	for _, p := range passages {
		t := strings.Join(strings.Fields(p.Text), " ")
		if t == "" {
			continue
		}
		if p.User {
			t = clip(t, promptChars)
		} else {
			in.ProseRunes += len([]rune(t))
			t = clip(t, answerChars)
		}
		lines = append(lines, line{p, t})
	}
	// Newest first until the budget is spent, then back in order.
	total, keep := 0, len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		total += len(lines[i].text) + 16
		if total > MaxInputChars {
			break
		}
		keep = i
	}
	lines = lines[keep:]
	var b strings.Builder
	if project != "" {
		fmt.Fprintf(&b, "Project: %s\n", project)
	}
	if len(topics) > 0 {
		fmt.Fprintf(&b, "Existing topics: %s\n", strings.Join(topics, ", "))
	}
	b.WriteString("\nThe session, oldest first:\n")
	for i, l := range lines {
		who := "Agent"
		if l.p.User {
			who = "User"
		}
		fmt.Fprintf(&b, "[%d] %s: %s\n", i+1, who, l.text)
		in.Passages = append(in.Passages, l.p)
	}
	in.Prompt = b.String()
	return in
}

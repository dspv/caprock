package brain

import (
	"fmt"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// System is the extraction's instructions.
const System = `You keep a developer's second brain. You are given the prose of one coding-agent session, or one part of a long one: the user's prompts and the agent's answers, numbered as passages. Pick out the memories worth keeping weeks from now:
- decision: what was chosen, and why;
- finding: what turned out to be true;
- idea: something worth trying later;
- question: something still open.
Always keep an explicit decision or standing rule the user states ("owner decided", "from now on", "rule:", "don't ever") as a decision.
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
	// MaxInputChars is the most transcript one read sends. A session with
	// more unread is read in chunks of this size, oldest first: each read
	// sends the oldest unread passages that fit and moves the cursor only
	// past those, so the next read goes on where it stopped.
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
	// ProseRunes is how much of the agent's prose was sent, before clipping.
	ProseRunes int
	// Through is the event id of the last passage given that the prompt
	// covers: how far a read of it may move the session's cursor. Cut is
	// set when passages after it did not fit and wait for the next read.
	Through int64
	Cut     bool
}

// BuildInput numbers a session's passages, oldest first, and writes the
// prompt: the project, the topics already in the brain, then the passages,
// as many of the oldest as fit in MaxInputChars. What does not fit is left
// for the next read (Through, Cut); nothing is skipped.
func BuildInput(project string, topics []string, passages []store.BrainPassage) Input {
	in := Input{}
	type line struct {
		p    store.BrainPassage
		text string
	}
	var lines []line
	total := 0
	for _, p := range passages {
		t := strings.Join(strings.Fields(p.Text), " ")
		if t == "" {
			in.Through = p.EventID
			continue
		}
		prose := 0
		if p.User {
			t = clip(t, promptChars)
		} else {
			prose = len([]rune(t))
			t = clip(t, answerChars)
		}
		total += len(t) + 16
		if total > MaxInputChars && len(lines) > 0 {
			in.Cut = true
			break
		}
		in.ProseRunes += prose
		in.Through = p.EventID
		lines = append(lines, line{p, t})
	}
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

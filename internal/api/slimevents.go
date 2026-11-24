package api

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/event"
)

// slimResultHead is how much of an erroring result's text a slim tool.post
// keeps: the head its exit code is read from (cockpit resultOutcome reads
// the first 200 characters).
const slimResultHead = 200

// slimToolPost is a tool.post as `?slim=1` sends it, and as the inspector
// held it anyway (ui/src/lib/cockpit.ts slimToolResult): the result's
// outcome and nothing of its body. tool_response and tool_input go;
// `interrupted: true` is kept when the response said so, and an erroring
// result keeps the head of its text as tool_response. Every other field
// stays, and every other kind is returned as it is.
//
// Why on the server: the inspector's read was 531–703 KB per session on the
// owner's live sessions, 30–38% of it tool.post bodies the window threw away
// on arrival (2026-11-24 audit).
func slimToolPost(e event.Event) event.Event {
	if e.Kind != event.KindToolPost || len(e.Payload) == 0 {
		return e
	}
	var p map[string]json.RawMessage
	if json.Unmarshal(e.Payload, &p) != nil || p == nil {
		return e
	}
	r, hadResponse := p["tool_response"]
	if !hadResponse && p["tool_input"] == nil {
		return e
	}
	delete(p, "tool_response")
	delete(p, "tool_input")
	var obj map[string]json.RawMessage
	if json.Unmarshal(r, &obj) == nil && obj != nil {
		var stopped bool
		if json.Unmarshal(obj["interrupted"], &stopped) == nil && stopped {
			p["interrupted"] = json.RawMessage(`true`)
		}
	}
	var isErr bool
	if json.Unmarshal(p["is_error"], &isErr) == nil && isErr {
		if b, err := json.Marshal(clipRunes(resultText(r), slimResultHead)); err == nil {
			p["tool_response"] = b
		}
	}
	b, err := json.Marshal(p)
	if err != nil {
		return e
	}
	e.Payload = b
	return e
}

// resultText is the text of a tool's response as the inspector reads it: a
// string, the first text block of a list, or an object's content, error or
// stderr.
func resultText(r json.RawMessage) string {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	var blocks []struct {
		Text *string `json:"text"`
	}
	if json.Unmarshal(r, &blocks) == nil {
		for _, b := range blocks {
			if b.Text != nil {
				return *b.Text
			}
		}
		return ""
	}
	var o map[string]json.RawMessage
	if json.Unmarshal(r, &o) == nil {
		for _, k := range []string{"content", "error", "stderr"} {
			if json.Unmarshal(o[k], &s) == nil && s != "" {
				return s
			}
		}
	}
	return ""
}

func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for k := range s {
		if i == n {
			return s[:k]
		}
		i++
	}
	return s
}

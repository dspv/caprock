package codex

import (
	"strings"
	"testing"
)

// What happens to a transcript shaped in ways this machine's 100 do not cover.
func TestRobustnessAgainstUnseenShapes(t *testing.T) {
	cases := map[string]string{
		"unknown record types": `{"timestamp":"2026-09-06T08:32:50Z","type":"session_meta","payload":{"session_id":"s","cwd":"/w","base_instructions":{"provenance":{"type":"model","model":"gpt-5-codex"}}}}
{"timestamp":"2026-09-06T08:33:00Z","type":"brand_new_kind","payload":{"whatever":1}}
{"timestamp":"2026-09-06T08:33:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"total_tokens":13}}}}`,

		"payload is not an object": `{"timestamp":"2026-09-06T08:32:50Z","type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}
{"timestamp":"2026-09-06T08:33:00Z","type":"event_msg","payload":"a bare string"}
{"timestamp":"2026-09-06T08:33:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"total_tokens":13}}}}`,

		"token_count with no info": `{"timestamp":"2026-09-06T08:32:50Z","type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}
{"timestamp":"2026-09-06T08:33:00Z","type":"event_msg","payload":{"type":"token_count"}}`,

		"provenance missing model": `{"timestamp":"2026-09-06T08:32:50Z","type":"session_meta","payload":{"session_id":"s","cwd":"/w","base_instructions":{"provenance":{"type":"model"}}}}`,

		"base_instructions is a string": `{"timestamp":"2026-09-06T08:32:50Z","type":"session_meta","payload":{"session_id":"s","cwd":"/w","base_instructions":"plain text prompt"}}`,

		"no timestamps at all": `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"total_tokens":13}}}}`,

		"empty lines scattered": "\n\n" + `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w"}}` + "\n\n\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			s, err := Parse(strings.NewReader(body), "x")
			if err != nil {
				t.Fatalf("failed to parse: %v", err)
			}
			if s.ID != "s" {
				t.Errorf("session id lost: %q", s.ID)
			}
			for _, tn := range s.Turns {
				if tn.Key == "" {
					t.Error("turn with no key")
				}
				if tn.In < 0 || tn.Out < 0 || tn.CacheRead < 0 {
					t.Errorf("negative tokens: %+v", tn)
				}
			}
			t.Logf("ok: model=%q turns=%d tools=%d", s.Model, len(s.Turns), len(s.Tools))
		})
	}
}

// The same failure mode as base_instructions, for every other field this
// package types: a shape we did not expect must cost that field, never the
// session or the file.
func TestUnexpectedFieldTypesDoNotLoseTheSession(t *testing.T) {
	cases := map[string]string{
		"cwd is a number":        `{"type":"session_meta","payload":{"session_id":"s","cwd":42}}`,
		"cli_version is object":  `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w","cli_version":{"major":1}}}`,
		"originator is a list":   `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w","originator":["a"]}}`,
		"session_id is a number": `{"type":"session_meta","payload":{"session_id":7,"id":"s","cwd":"/w"}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			s, err := Parse(strings.NewReader(body), "x")
			if err != nil {
				t.Fatalf("a bad field type lost the whole session: %v", err)
			}
			if s.ID == "" {
				t.Error("session id lost")
			}
		})
	}
}

// A turn_context whose model is not a string must not cost the session either.
func TestBadTurnContextKeepsTheSession(t *testing.T) {
	body := `{"type":"session_meta","payload":{"session_id":"s","cwd":"/w","base_instructions":{"provenance":{"type":"model","model":"gpt-5-codex"}}}}
{"type":"turn_context","payload":{"model":{"name":"weird"}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"total_tokens":13}}}}`
	s, err := Parse(strings.NewReader(body), "x")
	if err != nil {
		t.Fatalf("bad turn_context lost the session: %v", err)
	}
	// The provenance model survives, because turn_context only overrides when
	// it actually parsed.
	if s.Model != "gpt-5-codex" {
		t.Errorf("model should fall back to provenance, got %q", s.Model)
	}
	if len(s.Turns) != 1 {
		t.Errorf("turns lost: %d", len(s.Turns))
	}
}

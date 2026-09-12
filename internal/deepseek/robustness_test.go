package deepseek

import "testing"

// The importer must never lose a whole session to a shape it did not expect —
// the same rule Codex's importer holds to, because DSH is free to change any
// field between releases. The worst case for an unforeseen shape is a missing
// record, never a missing session.
func TestRobustness(t *testing.T) {
	header := `{"type":"session","version":3,"id":"s1","cwd":"/home/u/proj","createdAt":1}` + "\n"
	for _, tc := range []struct {
		name string
		body string
	}{
		{"unknown record kind", `{"type":"future/thing","seq":5,"time":1,"data":{"x":1}}`},
		{"non-object data", `{"type":"assistant/message","seq":6,"time":1,"data":"not an object"}`},
		{"assistant with no usage", `{"type":"assistant/message","seq":7,"time":1,"data":{"message":{"content":[],"source":{"model":"m"}}}}`},
		{"tool with string args", `{"type":"tool/call","seq":8,"time":1,"data":{"name":"bash","arguments":"not json"}}`},
		{"user with no content", `{"type":"user/message","seq":9,"time":1,"data":{}}`},
		{"malformed json", `{not json at all`},
		{"missing seq and time", `{"type":"assistant/message","data":{"message":{"content":[],"source":{"model":"m"}}}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := writeSession(t, header+tc.body+"\n")
			s, err := ParseFile(path)
			if err != nil {
				t.Fatalf("session lost to an unforeseen shape: %v", err)
			}
			if s.ID != "s1" {
				t.Fatalf("session id lost: %q", s.ID)
			}
		})
	}
}

// A transcript being written right now ends in a partial final line. The
// scanner tolerates it: it must parse the records that are complete, not fail
// the whole file.
func TestToleratesTruncatedFinalLine(t *testing.T) {
	content := `{"type":"session","version":3,"id":"s1","cwd":"/home/u/proj","createdAt":1}` + "\n" +
		`{"type":"assistant/message","seq":6,"time":1,"data":{"message":{"content":[],"source":{"model":"m"}},"usage":{"inputTokens":1}}}` + "\n" +
		`{"type":"assistant/message","seq":7,"time":1,"data":{"message":{"con` // truncated
	path := writeSession(t, content)
	s, err := ParseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Turns) != 1 {
		t.Fatalf("turns = %d, want 1 (the complete record before the truncation)", len(s.Turns))
	}
}

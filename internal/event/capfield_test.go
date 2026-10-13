package event

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func decode(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("capped value is not JSON: %v\n%s", err, raw)
	}
	return m
}

// A value within the budget with nothing base64 in it is stored byte for byte.
func TestCapToolFieldLeavesSmallValuesAlone(t *testing.T) {
	in := json.RawMessage(`{"stdout":"ok <b>&","exit_code":0,"z":[1,2]}`)
	if got := CapToolField(in); string(got) != string(in) {
		t.Fatalf("small value changed:\n%s\n%s", in, got)
	}
}

// A long string is clipped on a rune boundary, and the marker says how many
// bytes and line breaks were dropped.
func TestCapToolFieldClipsLongTextWithAMarker(t *testing.T) {
	line := strings.Repeat("日本語テキスト", 10) + "\n"
	long := strings.Repeat(line, 2000)
	raw, _ := json.Marshal(map[string]any{"stdout": long, "exit_code": 2, "interrupted": false})
	m := decode(t, CapToolField(raw))
	out := m["stdout"].(string)
	if !utf8.ValidString(out) {
		t.Fatal("clipped text is not valid UTF-8")
	}
	kept, lines := SplitClip(out)
	if !strings.HasPrefix(long, kept) {
		t.Fatal("the kept part is not the start of the original")
	}
	dropped := len(long) - len(kept)
	if want := "…[truncated " + itoa(dropped) + " bytes, " + itoa(strings.Count(long[len(kept):], "\n")) + " lines]"; !strings.HasSuffix(out, want) {
		t.Fatalf("marker: got %q, want suffix %q", out[len(out)-60:], want)
	}
	if strings.Count(kept, "\n")+lines != 2000 {
		t.Fatalf("lines kept %d + dropped %d != 2000", strings.Count(kept, "\n"), lines)
	}
	if len(out) > MaxToolField+64 {
		t.Fatalf("clipped to %d bytes, over the budget", len(out))
	}
	if m["exit_code"].(float64) != 2 || m["interrupted"] != false {
		t.Fatalf("short fields lost: %v", m)
	}
}

// Every base64 shape the agents send is replaced by a marker naming its
// media type and decoded size, at any size, and the rest of the block stays.
func TestCapToolFieldReplacesImages(t *testing.T) {
	b64 := strings.Repeat("QUJD", 512*1024/3) // 512 KB decoded
	cases := map[string]struct {
		raw  string
		path []string
		want string
	}{
		"API image block": {
			`[{"type":"text","text":"shot"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + b64 + `"}}]`,
			nil, "[image image/png 512 KB not stored]",
		},
		"Claude Code Read of an image": {
			`{"type":"image","file":{"base64":"` + b64 + `","type":"image/jpeg","originalSize":9}}`,
			[]string{"file", "base64"}, "[image image/jpeg 512 KB not stored]",
		},
		"MCP screenshot": {
			`{"content":[{"type":"image","data":"` + b64[:400] + `","mimeType":"image/webp"}]}`,
			nil, "[image image/webp 300 B not stored]",
		},
		"data URI": {
			`{"url":"data:image/gif;base64,` + b64 + `"}`,
			[]string{"url"}, "[image image/gif 512 KB not stored]",
		},
	}
	for name, c := range cases {
		got := string(CapToolField(json.RawMessage(c.raw)))
		if strings.Contains(got, "QUJD") {
			t.Errorf("%s: base64 still stored", name)
		}
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: no marker %q in %s", name, c.want, got)
		}
		if len(c.path) > 0 {
			var v any = decode(t, json.RawMessage(got))
			for _, k := range c.path {
				v = v.(map[string]any)[k]
			}
			if v != c.want {
				t.Errorf("%s: %v = %v", name, c.path, v)
			}
		}
	}
	// The API block keeps its text part.
	if got := string(CapToolField(json.RawMessage(cases["API image block"].raw))); !strings.Contains(got, `"text":"shot"`) {
		t.Errorf("text block lost: %s", got)
	}
}

// One huge field cannot crowd out the short ones beside it: the fields the
// screens read (gitOperation, agentId, exit codes) survive whole.
func TestCapToolFieldKeepsShortFieldsBesideAHugeOne(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"originalFile": strings.Repeat("x", 3<<20),
		"filePath":     "/repo/main.go",
		"gitOperation": map[string]any{"pr": map[string]any{"number": 7, "url": "https://example.com/pr/7", "action": "created"}},
		"agentId":      "a1",
	})
	got := CapToolField(raw)
	if len(got) > MaxToolField+1024 {
		t.Fatalf("capped to %d bytes", len(got))
	}
	m := decode(t, got)
	if m["filePath"] != "/repo/main.go" || m["agentId"] != "a1" {
		t.Fatalf("short fields lost: %v", m)
	}
	pr := m["gitOperation"].(map[string]any)["pr"].(map[string]any)
	if pr["number"].(float64) != 7 || pr["action"] != "created" {
		t.Fatalf("gitOperation lost: %v", pr)
	}
}

// A long array keeps what fits and says how many items it dropped.
func TestCapToolFieldEndsALongArrayWithACount(t *testing.T) {
	items := make([]string, 5000)
	for i := range items {
		items[i] = "/repo/some/rather/long/path/file" + itoa(i) + ".go"
	}
	raw, _ := json.Marshal(map[string]any{"filenames": items})
	m := decode(t, CapToolField(raw))
	got := m["filenames"].([]any)
	last := got[len(got)-1].(string)
	if !strings.HasSuffix(last, "more items not stored]") || len(got) >= 5000 {
		t.Fatalf("array not cut with a count: %d items, last %q", len(got), last)
	}
	if !strings.HasPrefix(last, "["+itoa(5000-(len(got)-1))+" more") {
		t.Fatalf("count wrong: %q with %d kept", last, len(got)-1)
	}
}

func TestSplitClipLeavesOrdinaryTextAlone(t *testing.T) {
	for _, s := range []string{"", "plain", "ends with ]", "…[truncated soon]", "…[truncated 12 bytes, x lines]"} {
		if kept, n := SplitClip(s); kept != s || n != 0 {
			t.Errorf("SplitClip(%q) = %q, %d", s, kept, n)
		}
	}
}

func TestHumanBytes(t *testing.T) {
	for n, want := range map[int]string{0: "0 B", 1023: "1023 B", 1024: "1 KB", 524288: "512 KB", 3 << 20: "3.0 MB"} {
		if got := HumanBytes(n); got != want {
			t.Errorf("HumanBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

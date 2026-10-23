package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every test works on a settings.json in a temporary directory, never the
// account's own ~/.claude.
func writeTemp(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if body != "" {
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReadRetention(t *testing.T) {
	for _, c := range []struct {
		body string
		want Retention
	}{
		{"", Retention{Days: DefaultRetentionDays}},
		{`{"model":"opus"}`, Retention{Days: DefaultRetentionDays}},
		{`{"cleanupPeriodDays": 90}`, Retention{Days: 90, Set: true}},
		{`{"cleanupPeriodDays": 365}`, Retention{Days: 365, Set: true}},
		{`{"cleanupPeriodDays": "365"}`, Retention{Days: DefaultRetentionDays}},
	} {
		got, err := ReadRetention(writeTemp(t, c.body))
		if err != nil || got != c.want {
			t.Errorf("%q: got %+v, %v; want %+v", c.body, got, err, c.want)
		}
	}
	// No file at all is the default too.
	if got, err := ReadRetention(filepath.Join(t.TempDir(), "nope", "settings.json")); err != nil || got.Days != DefaultRetentionDays || got.Set {
		t.Errorf("missing file: %+v, %v", got, err)
	}
}

// The user's file is theirs: the one key is added, every other byte stays
// where it was, including indentation, key order and a trailing newline.
func TestKeepTranscriptsKeepsEveryOtherKeyAndTheFormatting(t *testing.T) {
	body := "{\n    \"model\": \"opus\",\n    \"hooks\": {\"Stop\": [{\"matcher\": \"\"}]},\n    \"permissions\": {\n        \"allow\": [\"Bash(ls)\"]\n    }\n}\n"
	p := writeTemp(t, body)
	changed, err := KeepTranscripts(p, KeepRetentionDays)
	if err != nil || !changed {
		t.Fatalf("changed %v, err %v", changed, err)
	}
	want := "{\n    \"cleanupPeriodDays\": 36500,\n    \"model\": \"opus\",\n    \"hooks\": {\"Stop\": [{\"matcher\": \"\"}]},\n    \"permissions\": {\n        \"allow\": [\"Bash(ls)\"]\n    }\n}\n"
	if got := read(t, p); got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if r, _ := ReadRetention(p); r.Days != KeepRetentionDays || !r.Set {
		t.Fatalf("read back %+v", r)
	}
	// The original is kept beside it.
	if b := ListBackups(p); len(b) != 1 || read(t, b[0]) != body {
		t.Fatalf("backups %v", b)
	}
}

func TestKeepTranscriptsReplacesTheValueInPlace(t *testing.T) {
	p := writeTemp(t, `{"a": 1, "cleanupPeriodDays":   30 , "b": [1,2]}`)
	if changed, err := KeepTranscripts(p, 400); err != nil || !changed {
		t.Fatalf("changed %v, err %v", changed, err)
	}
	if got := read(t, p); got != `{"a": 1, "cleanupPeriodDays":   400 , "b": [1,2]}` {
		t.Fatalf("got %s", got)
	}
}

func TestKeepTranscriptsCompactAndEmptyAndMissing(t *testing.T) {
	p := writeTemp(t, `{"a":1}`)
	if _, err := KeepTranscripts(p, 36500); err != nil {
		t.Fatal(err)
	}
	if got := read(t, p); got != `{"cleanupPeriodDays":36500,"a":1}` {
		t.Fatalf("compact: %s", got)
	}
	for _, body := range []string{"{}", "  \n"} {
		p := writeTemp(t, body)
		if _, err := KeepTranscripts(p, 36500); err != nil {
			t.Fatal(err)
		}
		if got := read(t, p); got != "{\n  \"cleanupPeriodDays\": 36500\n}\n" {
			t.Fatalf("%q: %s", body, got)
		}
	}
	missing := filepath.Join(t.TempDir(), ".claude", "settings.json")
	if changed, err := KeepTranscripts(missing, 36500); err != nil || !changed {
		t.Fatalf("missing: %v %v", changed, err)
	}
	if r, _ := ReadRetention(missing); r.Days != 36500 {
		t.Fatalf("missing: %+v", r)
	}
}

// An unparsable file is refused and left exactly as it was: Claude Code
// would refuse it too, and the user's edits are in it.
func TestKeepTranscriptsRefusesInvalidJSON(t *testing.T) {
	for _, body := range []string{
		`{ "permissions": { "allow": [ "Bash(ls)", ] `,
		"{\n  \"/Users/x/Vibe_Code/**)\",\n  \"/Users/x/Vibe_Code/**)\"\n",
		`["not", "an", "object"]`,
	} {
		p := writeTemp(t, body)
		if _, err := KeepTranscripts(p, 36500); err == nil {
			t.Errorf("%q: written", body)
		}
		if got := read(t, p); got != body {
			t.Errorf("%q: changed to %q", body, got)
		}
		if b := ListBackups(p); len(b) != 0 {
			t.Errorf("%q: backups %v", body, b)
		}
		if _, err := ReadRetention(p); err == nil {
			t.Errorf("%q: read as valid", body)
		}
	}
}

func TestKeepTranscriptsIsIdempotent(t *testing.T) {
	p := writeTemp(t, "{\n  \"model\": \"opus\"\n}\n")
	if changed, err := KeepTranscripts(p, 36500); err != nil || !changed {
		t.Fatalf("first: %v %v", changed, err)
	}
	once := read(t, p)
	changed, err := KeepTranscripts(p, 36500)
	if err != nil || changed {
		t.Fatalf("second: changed %v, err %v", changed, err)
	}
	if read(t, p) != once || strings.Count(once, RetentionKey) != 1 {
		t.Fatalf("second write changed the file: %s", read(t, p))
	}
}

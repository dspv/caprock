package desktop

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// withHistory writes a history file into a temp home and points the package at
// it, returning nothing — the test just calls Latest().
func withHistory(t *testing.T, body string) {
	t.Helper()
	home := t.TempDir()
	var dir string
	switch runtime.GOOS {
	case "darwin":
		dir = filepath.Join(home, "Library", "Application Support", "Claude")
	case "windows":
		t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
		dir = filepath.Join(home, "AppData", "Roaming", "Claude")
	default:
		t.Setenv("XDG_CONFIG_HOME", "")
		dir = filepath.Join(home, ".config", "Claude")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if body != "" {
		if err := os.WriteFile(filepath.Join(dir, "plan-usage-history.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := userHomeDir
	userHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { userHomeDir = old })
}

func sampleFile(t *testing.T, samples ...map[string]any) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{"version": 2, "samples": samples})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sample(atMs int64, fh, sd int) map[string]any {
	return map[string]any{"t": atMs, "org": "o", "u": map[string]any{"fh": fh, "sd": sd, "xu": 0}}
}

func fixedNow(t *testing.T, at time.Time) {
	t.Helper()
	old := Now
	Now = func() time.Time { return at }
	t.Cleanup(func() { Now = old })
}

func TestLatestReadsNewestSample(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	fixedNow(t, now)
	withHistory(t, sampleFile(t,
		sample(now.Add(-30*time.Minute).UnixMilli(), 3, 2),
		sample(now.Add(-2*time.Minute).UnixMilli(), 8, 5),
		sample(now.Add(-10*time.Minute).UnixMilli(), 6, 4), // out of order on purpose
	))

	r, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	if r.FiveHourPct != 8 || r.SevenDayPct != 5 {
		t.Fatalf("got %d%%/%d%%, want the newest sample 8%%/5%%", r.FiveHourPct, r.SevenDayPct)
	}
	if r.Stale {
		t.Error("a two-minute-old sample is current, not stale")
	}
}

// The app only writes while it is running, so an old reading describes the past
// and must say so rather than be shown as the current figure.
func TestStaleWhenTheAppHasBeenClosed(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	fixedNow(t, now)
	withHistory(t, sampleFile(t, sample(now.Add(-3*time.Hour).UnixMilli(), 40, 30)))

	r, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	if !r.Stale {
		t.Fatal("a three-hour-old sample must be marked stale")
	}
	if r.FiveHourPct != 40 {
		t.Fatalf("the figure itself is still reported: got %d", r.FiveHourPct)
	}
}

// Most people do not use the desktop app at all, so absence is a normal
// outcome and must not read as an error anywhere upstream.
func TestUnavailableCases(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	cases := map[string]string{
		"no file at all":         "",
		"not json":               "this is not json",
		"no samples":             `{"version":2,"samples":[]}`,
		"samples missing fields": `{"version":2,"samples":[{"t":1787244657859,"u":{}}]}`,
		"reshaped file":          `{"version":3,"history":[{"time":1,"pct":5}]}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			fixedNow(t, now)
			withHistory(t, body)
			if _, err := Latest(); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("got %v, want ErrUnavailable", err)
			}
		})
	}
}

// A percentage outside 0-100, or a timestamp that cannot be real, means this is
// not the file we think it is — better to show nothing than a wrong number.
func TestImplausibleValuesAreRejected(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	for _, s := range []map[string]any{
		sample(now.UnixMilli(), 140, 5),
		sample(now.UnixMilli(), -1, 5),
		sample(now.UnixMilli(), 5, 101),
		sample(now.AddDate(0, 0, 5).UnixMilli(), 5, 5),                        // future
		sample(time.Date(2019, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(), 5, 5), // predates the app
	} {
		fixedNow(t, now)
		withHistory(t, sampleFile(t, s))
		if _, err := Latest(); !errors.Is(err, ErrUnavailable) {
			t.Errorf("sample %v was accepted, want rejected", s["u"])
		}
	}
}

// The file carries fields we ignore; adding more must not break the read.
func TestUnknownFieldsAreIgnored(t *testing.T) {
	now := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	fixedNow(t, now)
	withHistory(t, `{"version":9,"newTopLevel":true,"samples":[
		{"t":`+itoa(now.Add(-time.Minute).UnixMilli())+`,"org":"o","somethingNew":1,"u":{"fh":11,"sd":9,"xu":0,"zz":3}}]}`)
	r, err := Latest()
	if err != nil {
		t.Fatal(err)
	}
	if r.FiveHourPct != 11 || r.SevenDayPct != 9 {
		t.Fatalf("got %d/%d, want 11/9", r.FiveHourPct, r.SevenDayPct)
	}
}

func itoa(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

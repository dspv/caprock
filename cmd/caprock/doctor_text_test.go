package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/daemon"
)

// The doctor's text is pinned by one fixture that the dashboard's *Copy
// report* is pinned by too (ui/src/lib/footprint.test.ts), so the panel and
// the command print the same report. CAPROCK_UPDATE_GOLDEN=1 rewrites the
// text from printDoctor; the UI test then says whether footprintText agrees.
func TestDoctorTextMatchesFixture(t *testing.T) {
	dir := filepath.Join("..", "..", "testdata", "footprint")
	raw, err := os.ReadFile(filepath.Join(dir, "doctor.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f daemon.FootprintReport
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	// The actions' times print in local time; the fixture is UTC.
	saved := time.Local
	time.Local = time.UTC
	defer func() { time.Local = saved }()
	var out bytes.Buffer
	printDoctor(&out, &f)
	golden := filepath.Join(dir, "doctor.txt")
	if os.Getenv("CAPROCK_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(golden, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), out.Bytes()) {
		t.Errorf("doctor text differs from %s:\n--- got\n%s\n--- want\n%s", golden, out.String(), want)
	}
}

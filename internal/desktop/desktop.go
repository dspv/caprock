// Package desktop reads the plan-usage history the Claude desktop app keeps on
// disk, so the dashboard can say whether your plan limits were spent somewhere
// other than Claude Code.
//
// What this can and cannot tell you is the whole design constraint. The file
// holds nothing but a timestamp and two percentages — the five-hour and
// seven-day plan windows. There are no tokens, no cost, and no conversation
// content, so this can never say what the desktop app *cost*; it can only say
// how much of a window it consumed. Presenting it as anything more would be an
// invented number (engineering rule 6).
//
// It is also written only while the app is running: on a real machine that
// meant 27 samples in a day where a five-minute interval would give ~290. So
// the reading is reported with its age, and a stale one says so rather than
// implying the number is current.
//
// Nothing is stored. This is read on request, from a file the user's own
// machine already has — no new outbound call, no new database table.
package desktop

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Reading is the most recent plan-usage sample the desktop app recorded.
type Reading struct {
	// FiveHourPct and SevenDayPct are percentages of each plan window, 0-100.
	FiveHourPct int `json:"five_hour_pct"`
	SevenDayPct int `json:"seven_day_pct"`
	// At is when the app took the sample (unix ms).
	At int64 `json:"at"`
	// Stale is true when the sample is old enough that it likely predates the
	// app being closed, so the figure describes the past rather than now.
	Stale bool `json:"stale"`
}

// staleAfter is how old a sample may be before it stops describing "now". The
// app samples every five minutes while it runs, so anything much beyond that
// means it is closed.
const staleAfter = 20 * time.Minute

// maxFileSize bounds the read. The file grows to a few hundred KB over a month
// of samples; this is a generous ceiling that still refuses a pathological one.
const maxFileSize = 8 << 20

// userHomeDir is indirected so tests can inject a home on every OS.
var userHomeDir = os.UserHomeDir

// Now is indirected for tests.
var Now = time.Now

// ErrUnavailable means there is no readable history — the app is not installed,
// has never run, or keeps its data somewhere this build does not know about.
// It is not a failure: most users do not use the desktop app at all.
var ErrUnavailable = errors.New("no Claude desktop usage history on this machine")

// historyPath returns where the desktop app keeps plan-usage history.
func historyPath() (string, error) {
	home, err := userHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Claude", "plan-usage-history.json"), nil
	case "windows":
		// The app follows the usual Electron convention under %APPDATA%.
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "Claude", "plan-usage-history.json"), nil
		}
		return filepath.Join(home, "AppData", "Roaming", "Claude", "plan-usage-history.json"), nil
	default:
		if cfg := os.Getenv("XDG_CONFIG_HOME"); cfg != "" {
			return filepath.Join(cfg, "Claude", "plan-usage-history.json"), nil
		}
		return filepath.Join(home, ".config", "Claude", "plan-usage-history.json"), nil
	}
}

// file mirrors the parts of the on-disk format we rely on. The field names are
// the app's own single-letter keys; everything else in the file is ignored, so
// an added field cannot break the read.
type file struct {
	Samples []struct {
		T int64 `json:"t"`
		U struct {
			FH *int `json:"fh"`
			SD *int `json:"sd"`
		} `json:"u"`
	} `json:"samples"`
}

// Latest returns the newest usable sample, or ErrUnavailable.
func Latest() (Reading, error) {
	path, err := historyPath()
	if err != nil {
		return Reading{}, ErrUnavailable
	}
	f, err := os.Open(path) //nolint:gosec // path is derived from the OS home dir
	if err != nil {
		return Reading{}, ErrUnavailable
	}
	defer func() { _ = f.Close() }()

	var parsed file
	if err := json.NewDecoder(io.LimitReader(f, maxFileSize)).Decode(&parsed); err != nil {
		// An unreadable or reshaped file is the same outcome as no file: we
		// have nothing true to show, and guessing would be worse.
		return Reading{}, ErrUnavailable
	}

	// Samples are written in order, but scan for the newest rather than trust
	// that — a truncated or merged file should not produce a stale answer.
	var newest Reading
	found := false
	for _, s := range parsed.Samples {
		if s.T <= 0 || s.U.FH == nil || s.U.SD == nil {
			continue
		}
		if !found || s.T > newest.At {
			newest = Reading{FiveHourPct: *s.U.FH, SevenDayPct: *s.U.SD, At: s.T}
			found = true
		}
	}
	if !found || !plausible(newest) {
		return Reading{}, ErrUnavailable
	}
	newest.Stale = Now().Sub(time.UnixMilli(newest.At)) > staleAfter
	return newest, nil
}

// plausible rejects a sample that cannot describe a real plan window, so a
// reshaped file surfaces as "unavailable" rather than as a wrong percentage.
func plausible(r Reading) bool {
	if r.FiveHourPct < 0 || r.FiveHourPct > 100 || r.SevenDayPct < 0 || r.SevenDayPct > 100 {
		return false
	}
	// A timestamp in the future, or from before the desktop app existed, means
	// this is not the file we think it is.
	t := time.UnixMilli(r.At)
	return t.Year() >= 2023 && t.Before(Now().AddDate(0, 0, 1))
}

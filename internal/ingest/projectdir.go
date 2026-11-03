package ingest

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

// ProjectDirName is Claude Code's name for a cwd's folder under
// <config dir>/projects: every character that is not an ASCII letter or digit
// becomes "-" (so "/Users/a/my.app" is "-Users-a-my-app").
func ProjectDirName(cwd string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, cwd)
}

// TranscriptCwd is the first working directory a transcript's lines name:
// the folder its session was started in. "" when none of the first lines
// says one.
func TranscriptCwd(path string) string {
	f, err := os.Open(path) //nolint:gosec // a transcript path the daemon recorded itself
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for n := 0; n < 200 && sc.Scan(); n++ {
		var line struct {
			Cwd string `json:"cwd"`
		}
		if json.Unmarshal(sc.Bytes(), &line) == nil && line.Cwd != "" {
			return line.Cwd
		}
	}
	return ""
}

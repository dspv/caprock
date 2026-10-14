package store

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// goneFromDisk reports whether a session with no pid has lost what it was
// made of: the transcript it was read from (when it was read from one), or
// the directory it ran in.
//
// Without a pid the sweep had nothing to ask but the clock, so such a row
// stayed live for EndAfter (24 hours). On 2026-10-14 a test script wrote nine
// synthetic transcripts under ~/.claude/projects and removed them moments
// later; the nine sessions read from them sat in the sidebar as "working" with
// nothing behind them, and would have stayed for a day. A deleted file is a
// fact, as an exited process is: nothing will ever be appended to it.
//
// Only "does not exist" counts. A permission error or a slow disk says nothing
// about the session, and ending one on a guess is what ADR-028 removed.
// transcript_path is trusted only when has_transcript is set — the file was
// read, so it existed — because a hook can name a transcript Claude Code has
// not written yet.
func goneFromDisk(cwd, transcript string, hasTranscript bool) bool {
	if hasTranscript && missing(transcript) {
		return true
	}
	return missing(cwd)
}

// missing is true only for an absolute path the OS says does not exist.
func missing(path string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	_, err := os.Stat(path)
	return errors.Is(err, fs.ErrNotExist)
}

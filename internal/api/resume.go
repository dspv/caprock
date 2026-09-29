package api

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/store"
)

// ResumeInfo says whether a session can be carried on from here, and if not,
// why (FB-036).
//
// The button used to be gated on who started the session and which agent it
// was, and on nothing that decides whether a resume works. On the owner's
// machine it told the truth for about 30 of 297 ended sessions: about 65
// offered a resume whose transcript Claude Code had already deleted — a
// terminal that opened and died — and a dozen that could be resumed offered
// nothing, because Caprock had started them.
type ResumeInfo struct {
	OK bool `json:"ok"`
	// Reason is shown in place of the button when OK is false.
	Reason string `json:"reason,omitempty"`
	// Command resumes the session from the user's own terminal, when the
	// agent has such a command. Offered even when Caprock cannot run it.
	Command string `json:"command,omitempty"`
}

// resumeInfo is nil when there is nothing to resume: a live session Caprock
// started is typed into, not resumed.
func (s *Server) resumeInfo(sess store.Session) *ResumeInfo {
	if sess.Owned && sess.Status != store.StatusEnded {
		return nil
	}
	agent := sess.Agent
	if agent == "" {
		agent = "claude"
	}
	switch agent {
	case "claude":
	case "codex":
		return &ResumeInfo{Reason: "Caprock continues Claude Code sessions only; resume this one in Codex.", Command: "codex resume " + sess.SessionID}
	case "opencode":
		return &ResumeInfo{Reason: "Caprock continues Claude Code sessions only; resume this one in OpenCode.", Command: "opencode --session " + sess.SessionID}
	default:
		return &ResumeInfo{Reason: "Caprock continues Claude Code sessions only."}
	}
	info := &ResumeInfo{OK: true, Command: "claude --resume " + sess.SessionID}
	if sess.Cwd != "" {
		// Claude Code looks the conversation up under the directory it is
		// started in, so the command has to start there.
		info.Command = "cd " + strconv.Quote(sess.Cwd) + " && " + info.Command
	}
	if sess.Cwd != "" {
		if st, err := os.Stat(sess.Cwd); err != nil || !st.IsDir() {
			info.OK, info.Reason = false, "The folder it ran in no longer exists: "+sess.Cwd
			return info
		}
	}
	if !transcriptOnDisk(sess) {
		// `claude --resume` reads the conversation from this file; without
		// it the new terminal prints "No conversation found" and exits.
		info.OK = false
		info.Reason = "Claude Code has deleted its transcript (it keeps them 30 days by default, see cleanupPeriodDays)."
		info.Command = ""
		return info
	}
	if s.d.Agents == nil || !s.d.Agents.Available() {
		info.OK, info.Reason = false, "Caprock cannot find claude to start it; run the command in a terminal."
	}
	return info
}

// transcriptOnDisk reports whether the session's own conversation file exists
// — where the recorded path says, or where Claude Code keeps it for the cwd.
func transcriptOnDisk(sess store.Session) bool {
	var candidates []string
	if sess.TranscriptPath != "" {
		candidates = append(candidates, ingest.MainTranscript(sess.TranscriptPath, sess.SessionID))
	}
	if root, err := ingest.DefaultRoot(); err == nil && sess.Cwd != "" {
		candidates = append(candidates, filepath.Join(root, projectDirName(sess.Cwd), sess.SessionID+".jsonl"))
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}

// projectDirName is Claude Code's name for a cwd's folder under
// ~/.claude/projects: every character that is not a letter or digit becomes
// "-" (so "/Users/a/my.app" is "-Users-a-my-app").
func projectDirName(cwd string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, cwd)
}

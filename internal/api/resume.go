package api

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/chatimport"
	"github.com/dspv/caprock/internal/hermes"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/store"
)

// ResumeInfo says whether a session can be carried on from here, and if not,
// why (FB-036).
//
// The button used to be gated on who started the session and which agent it
// was, and on nothing that decides whether a resume works. On the owner's
// machine it told the truth for 39 of 116 ended Claude Code sessions: 65
// offered a resume that failed — 44 transcripts Claude Code had already
// deleted, 21 folders gone, each a terminal that opened and died — and 12 that
// could be resumed offered nothing, because Caprock had started them.
type ResumeInfo struct {
	OK bool `json:"ok"`
	// Reason is shown in place of the button when OK is false.
	Reason string `json:"reason,omitempty"`
	// Command resumes the session from the user's own terminal, when the
	// agent has such a command. Offered even when Caprock cannot run it.
	Command string `json:"command,omitempty"`
	// PermissionMode is the mode continuing it here starts in, when the
	// request names none (continueMode): the one the session was last running
	// in, else the spawn preference. Absent when neither says one, and when it
	// cannot be continued here. Shown beside the button, so a session that
	// never asks is never continued by surprise — and one that always asked
	// does not come back asking for nothing.
	PermissionMode string `json:"permission_mode,omitempty"`
}

// resumeInfo is nil when there is nothing to resume: a live session Caprock
// started is typed into, not resumed.
func (s *Server) resumeInfo(ctx context.Context, sess store.Session) *ResumeInfo {
	info := s.resumeState(sess)
	if info != nil && info.OK {
		info.PermissionMode = s.continueMode(ctx, sess.SessionID)
	}
	return info
}

// continueMode is the permission mode a session is carried on in when the
// request does not name one: the mode its own hooks last reported — so a
// session run with permissions skipped is continued with them skipped, and
// one in plan mode stays in plan mode — else the spawn preference, else ""
// (the agent's own default). Used for a resume and for a relay alike.
func (s *Server) continueMode(ctx context.Context, sessionID string) string {
	if sessionID != "" {
		reported, err := store.LastPermissionMode(ctx, s.d.Store.DB(), sessionID)
		if err != nil {
			s.d.Log.Warn("could not read the session's permission mode", "component", "api", "session", sessionID, "err", err)
		}
		if m := agents.CarriedMode(reported); m != "" {
			return m
		}
	}
	return s.spawnMode()
}

// spawnMode is the stated preference for new sessions, or "".
func (s *Server) spawnMode() string {
	if s.d.Settings == nil {
		return ""
	}
	return s.d.Settings.Get().SpawnMode
}

// defaultSpawnMode fills permission_mode on a start request that names none:
// a resume or a relay carries the source session's mode (continueMode), and
// anything else gets the spawn preference. A request with its own command is
// left alone — Caprock does not guess flags for a binary it did not build the
// argv of. Every caller gets this, not only the dashboard's buttons: the
// phone and the project terminal post the same request.
func (s *Server) defaultSpawnMode(ctx context.Context, req map[string]any) {
	if m, _ := req["permission_mode"].(string); m != "" {
		return
	}
	if c, _ := req["command"].(string); c != "" {
		return
	}
	source, _ := req["resume"].(string)
	if source == "" {
		source, _ = req["relay_from"].(string)
	}
	if m := s.continueMode(ctx, source); m != "" {
		req["permission_mode"] = m
	}
}

// resumeState is resumeInfo without the mode: whether, and how, the session
// can be continued.
func (s *Server) resumeState(sess store.Session) *ResumeInfo {
	// Caprock's own live session has its terminal; there is nothing to
	// continue. Unless this daemon no longer holds that terminal (FB-040).
	if sess.Owned && sess.Status != store.StatusEnded && (s.d.Agents == nil || s.d.Agents.Holds(sess.SessionID)) {
		return nil
	}
	agent := sess.Agent
	if agent == "" {
		agent = "claude"
	}
	switch agent {
	case "claude":
	case "codex", "opencode", "hermes":
		return s.resumeOther(sess, agent)
	case chatimport.SourceClaudeAI, chatimport.SourceChatGPT:
		// An imported conversation (ADR-074): its history is a copy, and the
		// service it lives on has no way in for a program on this machine.
		return &ResumeInfo{Reason: "Imported from " + chatimport.SourceName(agent) + ": it can be read here, and carried on in " + chatimport.SourceName(agent) + " itself."}
	default:
		return &ResumeInfo{Reason: "Caprock continues Claude Code, Codex, OpenCode and Hermes sessions."}
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
			// The command used to keep its `cd` into that folder, which fails
			// before claude ever starts. Measured with 2.1.309 (2026-10-24),
			// `claude --resume <id>` looks only under the folder it is started
			// in (claudeStartDir), so the folder the conversation began in is
			// named when the transcript says it and it is still there.
			info.Command = ""
			if transcriptOnDisk(sess) {
				info.Command = "claude --resume " + sess.SessionID
				info.Reason += ". Claude Code can still resume it from another folder."
				if dir := claudeStartDir(sess, sess.Cwd); dir != sess.Cwd {
					info.Command = "cd " + strconv.Quote(dir) + " && " + info.Command
					info.Reason = "The folder it ran in no longer exists: " + sess.Cwd + ". Claude Code can still resume it from the folder it began in, " + dir + "."
				}
			}
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
	// Found, but perhaps only from the folder it began in (claudeStartDir):
	// the command starts there, and POST /v1/agents does too.
	if dir := claudeStartDir(sess, sess.Cwd); dir != sess.Cwd {
		info.Command = "cd " + strconv.Quote(dir) + " && claude --resume " + sess.SessionID
	}
	if s.d.Agents == nil || !s.d.Agents.Has("claude") {
		info.OK, info.Reason = false, "Caprock cannot find claude to start it; run the command in a terminal."
	}
	return info
}

// resumeOther answers for Codex, OpenCode and Hermes, whose conversations
// live in their own stores rather than in a transcript Caprock can look for.
// The agent's own id is the one its resume flag takes: for a session Caprock
// started, that is the linked id (sessions.native_id), not Caprock's.
func (s *Server) resumeOther(sess store.Session, agent string) *ResumeInfo {
	name, flag := "Codex", "codex resume "
	switch agent {
	case "opencode":
		name, flag = "OpenCode", "opencode --session "
	case "hermes":
		name, flag = "Hermes", "hermes chat --resume "
	}
	native := sess.NativeID
	if native == "" {
		if sess.Owned {
			// Started here and never linked: nothing was sent, so the agent
			// never made a thread or a session to go back to.
			return &ResumeInfo{Reason: "Nothing was sent in this session, so " + name + " has nothing to continue. Start a new one."}
		}
		native = sess.SessionID
	}
	info := &ResumeInfo{OK: true, Command: flag + native}
	if sess.Cwd != "" {
		info.Command = "cd " + strconv.Quote(sess.Cwd) + " && " + info.Command
		if st, err := os.Stat(sess.Cwd); err != nil || !st.IsDir() {
			info.OK, info.Reason = false, "The folder it ran in no longer exists: "+sess.Cwd
			info.Command = ""
			if agent == "codex" || agent == "hermes" {
				// Codex finds a thread by id from any folder, and Hermes a
				// session in its one state database.
				info.Command = flag + native
			}
			return info
		}
	}
	if sess.Status != store.StatusEnded {
		// Two processes on one thread would append to one rollout between
		// them; Claude Code's answer is a fork, and the forks these two CLIs
		// make copy the history with its cost, which Caprock would count
		// twice. So it waits for the session to end.
		info.OK, info.Reason = false, "It is still running. Caprock continues a "+name+" session once it has ended."
		return info
	}
	if agent == "hermes" && hermes.DBPath() == "" {
		// `hermes chat --resume` reads the session from state.db, the same
		// file Caprock read it from; without it there is nothing to load.
		info.OK, info.Reason, info.Command = false, "Hermes's state database is no longer there, so it has nothing to continue.", ""
		return info
	}
	if s.d.Agents == nil || !s.d.Agents.Has(agent) {
		info.OK, info.Reason = false, "Caprock cannot find "+agent+" to start it; run the command in a terminal."
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

// claudeStartDir is the folder `claude --resume <id>` has to start in to
// find the session's conversation, given the folder a request names.
//
// Claude Code keeps a transcript under ~/.claude/projects/<the folder it was
// started in, every character not a letter or digit made "-">, and a resume
// by id looks only there: started anywhere else it prints "No conversation
// found with session ID: …" and exits 1 (measured with 2.1.309,
// 2026-10-24). A session's recorded folder follows its `cd`s, so a session
// started in ~/work and moved into ~/work/app is recorded in ~/work/app, and
// continuing it there failed at once, every time.
//
// The transcript says where it began (its lines carry the cwd). When the
// asked folder does not find it and the one it began in does — the folder
// its project directory is named after, still on disk — that one is the
// answer. Anything less certain keeps the asked folder: a guess that
// started a session somewhere else would be worse than an exit whose
// reason the tab shows.
func claudeStartDir(sess store.Session, cwd string) string {
	if cwd == "" {
		cwd = sess.Cwd
	}
	if root, err := ingest.DefaultRoot(); err == nil && cwd != "" {
		if st, err := os.Stat(filepath.Join(root, projectDirName(cwd), sess.SessionID+".jsonl")); err == nil && !st.IsDir() {
			return cwd
		}
	}
	if sess.TranscriptPath == "" {
		return cwd
	}
	tp := ingest.MainTranscript(sess.TranscriptPath, sess.SessionID)
	if st, err := os.Stat(tp); err != nil || st.IsDir() {
		return cwd
	}
	proj := filepath.Base(filepath.Dir(tp))
	if cwd != "" && projectDirName(cwd) == proj {
		// Another configuration directory's projects (a subscription), the
		// same folder name: found.
		return cwd
	}
	if began := transcriptCwd(tp); began != "" && began != cwd && projectDirName(began) == proj {
		if st, err := os.Stat(began); err == nil && st.IsDir() {
			return began
		}
	}
	return cwd
}

// transcriptCwd is the first working directory a transcript's lines name:
// the folder its session was started in. "" when none of the first lines
// says one.
func transcriptCwd(path string) string {
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

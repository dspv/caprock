package daemon

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/relay"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
	"github.com/dspv/caprock/internal/userenv"
)

// Continue a session on another provider or sign-in (ADR-090).
//
// A Claude Code session that hit its plan's limit is carried on elsewhere,
// three ways:
//
//   - On DeepSeek or Kimi: `claude --resume <id> --fork-session` in the same
//     configuration directory, with the provider's environment. The same
//     conversation, under a new session id whose parent is the original.
//   - On another Claude Code sign-in: Claude Code finds a conversation only
//     under <config dir>/projects/<cwd, every non-alphanumeric made "-">/,
//     so the transcript is copied (never moved) into the other directory,
//     under a new session id, and resumed there. The same conversation; the
//     copy's earlier turns are the original's, priced once (the
//     cross-session check of migration 0029).
//   - On Codex: a new Codex session in the same folder, whose first message
//     is the relay brief (internal/relay) — a summary, not the conversation.
//
// The original's process is Caprock's own (anything else is refused, rule
// 7), so it is ended once the new one has started; a failed start leaves it
// as it was.

// targetKind is what a continue-on target is.
type targetKind int

const (
	targetProvider targetKind = iota + 1 // deepseek, kimi
	targetSignIn                         // a Claude Code sign-in: own or added
	targetCodex                          // Codex: own or added
)

// ContinueOn is api.SessionContinuer.
// A move by hand replaces any return the automatic one had planned.
func (a *agentAdapter) ContinueOn(ctx context.Context, id, target string) (api.ContinueOnResult, error) {
	res, err := a.d.continueOn(ctx, id, target, false)
	if err != nil {
		return res, err
	}
	a.d.limits.forget(id)
	a.d.publishContinued(res)
	return res, nil
}

// subscriptionName is a session's subscription in continue-on's terms.
func subscriptionName(sub string) string {
	if sub == "" {
		return subs.DefaultID
	}
	return sub
}

func (d *Daemon) continueOn(ctx context.Context, id, target string, auto bool) (api.ContinueOnResult, error) {
	db := d.store.DB()
	sess, err := store.GetSession(ctx, db, id)
	if errors.Is(err, sql.ErrNoRows) {
		return api.ContinueOnResult{}, api.ErrContinueNotFound
	}
	if err != nil {
		return api.ContinueOnResult{}, err
	}
	if !sess.Owned || d.mgr == nil {
		return api.ContinueOnResult{}, api.ErrContinueNotOwned
	}
	if a := sess.Agent; a != "" && a != agents.AgentClaude {
		return api.ContinueOnResult{}, api.ContinueRefusal{Msg: "only a Claude Code session is continued elsewhere; this one is " + agentName(a)}
	}
	from := subscriptionName(sess.Subscription)
	kind, sub, err := d.continueTarget(target)
	if err != nil {
		return api.ContinueOnResult{}, err
	}
	if target == from {
		return api.ContinueOnResult{}, api.ContinueRefusal{Msg: "this session already runs on it"}
	}
	res := api.ContinueOnResult{ContinuedFrom: id, Target: target, From: from, Auto: auto}
	mode := d.carriedMode(ctx, id)
	if kind == targetCodex {
		if err := d.continueOnCodex(ctx, sess, sub, mode, &res); err != nil {
			return api.ContinueOnResult{}, err
		}
	} else if err := d.continueOnClaude(ctx, sess, kind, target, sub, mode, &res); err != nil {
		return api.ContinueOnResult{}, err
	}
	if _, held := d.mgr.Get(id); held {
		if err := d.mgr.End(id); err != nil {
			d.log.Warn("continued elsewhere, but the original did not stop", "component", "continue-on", "session", id, "err", err)
		} else {
			res.StoppedOriginal = true
		}
	}
	d.log.Info("continued a session elsewhere", "component", "continue-on", "from", id, "to", res.SessionID, "target", target, "how", res.How, "auto", auto)
	return res, nil
}

// publishContinued tells the app a session moved: the toast and its Undo.
func (d *Daemon) publishContinued(res api.ContinueOnResult) {
	if d.bus != nil {
		d.bus.Publish(bus.Frame{Type: bus.FrameContinued, Data: res})
	}
}

// continueTarget says what target names, refusing one that is unknown or
// cannot be used now.
func (d *Daemon) continueTarget(target string) (targetKind, string, error) {
	cfg := d.config()
	switch target {
	case subs.DeepSeekID:
		if strings.TrimSpace(cfg.DeepSeekAPIKey) == "" {
			return 0, "", api.ContinueRefusal{Msg: "no DeepSeek key is set; add it in Settings → Subscriptions"}
		}
		return targetProvider, "", nil
	case subs.KimiID:
		if strings.TrimSpace(cfg.KimiAPIKey) == "" {
			return 0, "", api.ContinueRefusal{Msg: "no Kimi key is set; add it in Settings → Subscriptions"}
		}
		return targetProvider, "", nil
	case subs.DefaultID:
		return targetSignIn, "", nil
	case agents.AgentCodex:
		if !d.mgr.AgentAvailable(agents.AgentCodex) {
			return 0, "", api.ContinueRefusal{Msg: "Codex is not installed here"}
		}
		return targetCodex, "", nil
	}
	s, ok := subs.Find(cfg.Subscriptions, target)
	if !ok {
		return 0, "", api.ContinueRefusal{Msg: fmt.Sprintf("no subscription %q; see Settings → Subscriptions", target)}
	}
	if s.Agent == subs.AgentCodex {
		if !d.mgr.AgentAvailable(agents.AgentCodex) {
			return 0, "", api.ContinueRefusal{Msg: "Codex is not installed here"}
		}
		return targetCodex, s.ID, nil
	}
	return targetSignIn, s.ID, nil
}

// carriedMode is the permission mode the continuation starts in: the one the
// session last ran in, else the spawn preference (as a resume's is).
func (d *Daemon) carriedMode(ctx context.Context, id string) string {
	reported, _ := store.LastPermissionMode(ctx, d.store.DB(), id)
	if m := agents.CarriedMode(reported); m != "" {
		return m
	}
	return d.config().SpawnPermissionMode
}

// ownClaudeDir is the user's own Claude Code configuration directory: the
// one whose projects/ the daemon reads (Options.TranscriptRoot, tests), else
// the login shell's CLAUDE_CONFIG_DIR, else ~/.claude.
func (d *Daemon) ownClaudeDir() string {
	if d.opt.TranscriptRoot != "" {
		return filepath.Dir(d.opt.TranscriptRoot)
	}
	home, _ := os.UserHomeDir()
	env := userenv.Cached()
	getenv := func(k string) string {
		for i := len(env) - 1; i >= 0; i-- {
			if v, ok := strings.CutPrefix(env[i], k+"="); ok {
				return v
			}
		}
		return ""
	}
	return subs.DefaultPaths(subs.AgentClaude, home, getenv).Dir
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if ca == cb {
		return true
	}
	if ra, err := filepath.EvalSymlinks(ca); err == nil {
		if rb, err := filepath.EvalSymlinks(cb); err == nil {
			return ra == rb
		}
	}
	return false
}

func (d *Daemon) continueOnClaude(ctx context.Context, sess store.Session, kind targetKind, target, sub, mode string, res *api.ContinueOnResult) error {
	if sess.TranscriptPath == "" {
		return api.ContinueRefusal{Msg: "Caprock has not seen this session's transcript, so there is no conversation to continue"}
	}
	tp := ingest.MainTranscript(sess.TranscriptPath, sess.SessionID)
	if st, err := os.Stat(tp); err != nil || st.IsDir() {
		return api.ContinueRefusal{Msg: "Claude Code's transcript of this session is gone, so there is no conversation to continue"}
	}
	proj := filepath.Base(filepath.Dir(tp))
	srcConfig := filepath.Dir(filepath.Dir(filepath.Dir(tp)))
	start := claudeStartFolder(sess, tp, proj)
	if start == "" {
		return api.ContinueRefusal{Msg: "the folder this session began in no longer exists, so Claude Code would not find its conversation"}
	}
	sr := agents.SpawnRequest{Agent: agents.AgentClaude, Cwd: start, PermissionMode: mode, Subscription: target}
	srcIsProfile := subs.OfDir(d.opt.DataDir, srcConfig) != ""
	switch kind {
	case targetProvider:
		if !srcIsProfile && !samePath(srcConfig, d.ownClaudeDir()) {
			return api.ContinueRefusal{Msg: "this session's conversation is in a configuration directory Caprock does not manage"}
		}
		sr.Resume, sr.Fork = sess.SessionID, true
		res.How = "resume"
		dir := ""
		if srcIsProfile {
			dir = srcConfig
		}
		if err := d.resolveSubscriptionIn(&sr, nil, dir); err != nil {
			return api.ContinueRefusal{Msg: err.Error()}
		}
	case targetSignIn:
		dst := d.ownClaudeDir()
		if sub != "" {
			dst = subs.Dir(d.opt.DataDir, sub)
		}
		if strings.HasPrefix(strings.ToLower(sess.Model), "claude-") {
			// Another Claude account: the model it was on is still Claude's.
			sr.Model = sess.Model
		}
		if err := d.resolveSubscriptionIn(&sr, nil, ""); err != nil {
			return api.ContinueRefusal{Msg: err.Error()}
		}
		if samePath(dst, srcConfig) {
			// A provider session in this sign-in's own directory.
			sr.Resume, sr.Fork = sess.SessionID, true
			res.How = "resume"
			break
		}
		newID := d.mgr.NewSessionID()
		out := filepath.Join(dst, "projects", proj, newID+".jsonl")
		if err := copyTranscript(tp, out, sess.SessionID, newID); err != nil {
			return fmt.Errorf("copy the conversation to the other sign-in: %w", err)
		}
		sr.Resume, sr.Fork = newID, false
		res.How = "copy"
	}
	ag, err := d.mgr.Spawn(ctx, sr)
	if err != nil {
		return api.ContinueRefusal{Msg: err.Error()}
	}
	if err := store.SetParent(ctx, d.store.DB(), ag.SessionID, sess.SessionID); err != nil {
		d.log.Warn("could not record what the session continues", "component", "continue-on", "err", err)
	}
	res.SessionID, res.Cwd, res.SameConversation = ag.SessionID, ag.Cwd, true
	res.Note = "The same conversation, continued on " + d.targetLabel(target) + "."
	return nil
}

func (d *Daemon) continueOnCodex(ctx context.Context, sess store.Session, sub, mode string, res *api.ContinueOnResult) error {
	if !isDir(sess.Cwd) {
		return api.ContinueRefusal{Msg: "the folder this session worked in no longer exists"}
	}
	b, err := relay.Build(ctx, d.store.DB(), sess, time.Now())
	if err != nil {
		return err
	}
	text := b.Text
	if r := []rune(text); len(r) > relay.MaxPromptRunes {
		text = string(r[:relay.MaxPromptRunes])
	}
	req := map[string]any{"agent": agents.AgentCodex, "cwd": sess.Cwd, "prompt": text, "relay_from": sess.SessionID,
		"subscription": subscriptionName(sub)}
	if agents.IsPermissionMode(mode) {
		req["permission_mode"] = mode
	}
	id, cwd, err := (&agentAdapter{m: d.mgr, d: d}).Spawn(ctx, req)
	if err != nil {
		return api.ContinueRefusal{Msg: err.Error()}
	}
	res.SessionID, res.Cwd, res.How = id, cwd, "summary"
	res.Note = "A new Codex session, started with a summary of this one's work: not the same conversation."
	return nil
}

// targetLabel names a target for the note.
func (d *Daemon) targetLabel(target string) string {
	switch target {
	case subs.DeepSeekID:
		return "DeepSeek"
	case subs.KimiID:
		return "Kimi"
	case subs.DefaultID:
		return d.config().OwnLabel(subs.AgentClaude)
	case agents.AgentCodex:
		return "Codex"
	}
	if s, ok := subs.Find(d.config().Subscriptions, target); ok {
		return s.Label
	}
	return target
}

func isDir(p string) bool {
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// claudeStartFolder is the folder `claude --resume` must start in to find a
// conversation kept under the project folder proj: the session's own folder
// when its name is proj, else the one the transcript began in; "" when
// neither is on disk.
func claudeStartFolder(sess store.Session, tp, proj string) string {
	if isDir(sess.Cwd) && ingest.ProjectDirName(sess.Cwd) == proj {
		return sess.Cwd
	}
	if began := ingest.TranscriptCwd(tp); isDir(began) && ingest.ProjectDirName(began) == proj {
		return began
	}
	return ""
}

// copyTranscript copies a Claude Code transcript to out under a new session
// id: each line's sessionId (and session_id) naming from becomes to, and
// nothing else changes — Claude Code writes compact JSON, so the field is
// replaced as bytes rather than by re-encoding a line it owns. The copy is
// written beside out and renamed into place, and never replaces a file.
func copyTranscript(src, out, from, to string) error {
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s already exists", out)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		return err
	}
	in, err := os.Open(src) //nolint:gosec // the session's own transcript, recorded by the daemon
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	tmp, err := os.CreateTemp(filepath.Dir(out), ".caprock-copy-*.jsonl.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	pairs := [][2][]byte{
		{[]byte(`"sessionId":"` + from + `"`), []byte(`"sessionId":"` + to + `"`)},
		{[]byte(`"session_id":"` + from + `"`), []byte(`"session_id":"` + to + `"`)},
	}
	r := bufio.NewReaderSize(in, 1<<20)
	w := bufio.NewWriterSize(tmp, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			for _, p := range pairs {
				line = bytes.ReplaceAll(line, p[0], p[1])
			}
			if _, werr := w.Write(line); werr != nil {
				_ = tmp.Close()
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			_ = tmp.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s already exists", out)
	}
	return os.Rename(tmpName, out)
}

package daemon

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/hooks"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

// Changing an owned session's permission mode while it runs (ADR-054). The
// keystrokes and the footer are the agent manager's (agents/modeswitch.go);
// here is what decides whether a switch may happen now — the session's
// prompt and turn, read as the message queue reads them — and the restart,
// which is a continue under the session's own id.

// claudeBypassConsented reports whether Claude Code's one-time bypass warning
// was accepted in the settings a session started with configDir reads: the
// subscription's own directory (ADR-048), or the user's.
func claudeBypassConsented(configDir string) bool {
	sp := ""
	if configDir != "" {
		sp = filepath.Join(configDir, "settings.json")
	} else {
		p, err := hooks.DefaultSettingsPath()
		if err != nil {
			return false
		}
		sp = p
	}
	ok, err := hooks.BypassAccepted(sp)
	return err == nil && ok
}

// inSessionModes are the modes Shift+Tab reaches in a process with facts.
func inSessionModes(f agents.LaunchFacts) []string {
	out := []string{agents.ModeDefault, agents.ModeAccept, agents.ModePlan}
	if f.Bypass {
		out = append(out, agents.ModeBypass)
	}
	return append(out, agents.ModeAuto)
}

// restartModes are the modes only a new process has.
func restartModes(f agents.LaunchFacts) []string {
	var out []string
	if !f.Bypass {
		out = append(out, agents.ModeBypass)
	}
	return append(out, agents.ModeDontAsk)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// PermissionMode is an owned session's mode and what can change it.
func (a *agentAdapter) PermissionMode(ctx context.Context, id string) (api.PermissionModeView, bool) {
	ag, ok := a.m.Get(id)
	if !ok || a.m.IsShell(id) {
		return api.PermissionModeView{}, false
	}
	v := api.PermissionModeView{SessionID: id}
	if ag.Kind != "" && ag.Kind != agents.AgentClaude {
		// Codex, OpenCode, Gemini: their modes are not read or switched here.
		return v, true
	}
	mode, src, facts, _ := a.m.SessionMode(id)
	v.Mode, v.Source, v.Switchable = mode, string(src), true
	v.InSession, v.Restart = inSessionModes(facts), restartModes(facts)
	if a.d.queue != nil {
		v.Waiting, _ = a.d.queue.waiting(ctx, ag)
	}
	return v, true
}

// modeErr builds the refusal the API answers with.
func modeErr(status int, code, msg, mode string) error {
	return &api.ModeError{Status: status, Code: code, Msg: msg, Mode: mode}
}

// SetPermissionMode switches an owned Claude Code session to mode: by
// Shift+Tab when this process can reach it, or — asked for explicitly, with
// the agent at its prompt — by resuming the same conversation in a new
// process started in that mode.
func (a *agentAdapter) SetPermissionMode(ctx context.Context, id, mode string, restart bool) (api.PermissionModeView, error) {
	want := agents.CanonicalMode(mode)
	ag, ok := a.m.Get(id)
	if !ok || a.m.IsShell(id) {
		return api.PermissionModeView{}, modeErr(http.StatusConflict, "not_owned",
			"Caprock did not start this session, so its mode changes only in its own terminal (Shift+Tab).", "")
	}
	if ag.Kind != "" && ag.Kind != agents.AgentClaude {
		return api.PermissionModeView{}, modeErr(http.StatusUnprocessableEntity, "unsupported",
			"Caprock changes the mode of Claude Code sessions only.", "")
	}
	view, _ := a.PermissionMode(ctx, id)
	switch view.Waiting {
	case api.WaitingPermission, api.WaitingQuestion:
		return view, modeErr(http.StatusConflict, "prompt", "The session is asking something; answer it first.", view.Mode)
	}
	facts := agents.ReadLaunch(ag.Command)
	if restart {
		return a.restartInMode(ctx, ag, want, facts, view)
	}
	if !contains(view.InSession, want) {
		return view, modeErr(http.StatusUnprocessableEntity, "restart",
			"This session was not started able to reach that mode; restart it in that mode to change it.", view.Mode)
	}
	if view.Waiting == api.WaitingTurn && agents.CrossesBypass(view.Mode, want, facts.Bypass) {
		return view, modeErr(http.StatusConflict, "busy",
			"The way there passes through bypass, and the agent is working; switch when the turn ends.", view.Mode)
	}
	sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	got, err := a.m.SwitchMode(sctx, id, want)
	if err != nil {
		code, status := "stuck", http.StatusUnprocessableEntity
		switch {
		case errors.Is(err, agents.ErrModeMenu):
			code, status = "prompt", http.StatusConflict
		case errors.Is(err, agents.ErrModeUnreachable):
			code = "unreachable"
			if want == agents.ModeAuto {
				err = errors.New("auto mode is not in this session's Shift+Tab cycle: the account or the model does not offer it")
			}
		}
		return view, modeErr(status, code, err.Error(), got)
	}
	a.d.log.Info("switched an owned session's permission mode", "component", "daemon", "session_id", id, "mode", got)
	view, _ = a.PermissionMode(ctx, id)
	return view, nil
}

// restartInMode stops an owned session and resumes its conversation, under
// its own id, in a new process started in mode. Only at the prompt: a turn
// cut off mid-way loses the work in flight.
func (a *agentAdapter) restartInMode(ctx context.Context, ag *agents.Agent, want string, facts agents.LaunchFacts, view api.PermissionModeView) (api.PermissionModeView, error) {
	id := ag.SessionID
	if view.Waiting == api.WaitingTurn {
		return view, modeErr(http.StatusConflict, "busy", "The agent is working; restart it when the turn has ended.", view.Mode)
	}
	if want == agents.ModeBypass && !claudeBypassConsented(a.configDirOf(ctx, id)) {
		return view, modeErr(http.StatusConflict, "bypass_consent",
			"Bypass needs a one-time consent first: in Caprock on this computer, start a session in Bypass and accept the warning.", view.Mode)
	}
	// The flag for the ordinary mode is "manual": with none, a
	// permissions.defaultMode in the user's settings would decide instead.
	flag := want
	if want == agents.ModeDefault {
		flag = "manual"
	}
	a.m.SetRestarting(id, true)
	// Cleared a moment after the new process is up: each terminal's socket
	// reads the flag as the old process exits, and must not miss it.
	defer time.AfterFunc(3*time.Second, func() { a.m.SetRestarting(id, false) })
	cols, rows, err := a.m.StopForRestart(ctx, id)
	if err != nil {
		return view, modeErr(http.StatusConflict, "stuck", "Could not stop the session to restart it: "+err.Error(), view.Mode)
	}
	req := map[string]any{"cwd": ag.Cwd, "resume": id, "permission_mode": flag, "cols": cols, "rows": rows}
	if facts.Model != "" {
		req["model"] = facts.Model
	}
	if _, _, err := a.Spawn(context.WithoutCancel(ctx), req); err != nil {
		return view, modeErr(http.StatusConflict, "stuck",
			"The session stopped but did not start again: "+err.Error()+" — continue it from its page.", "")
	}
	a.d.log.Info("restarted an owned session in another permission mode", "component", "daemon", "session_id", id, "mode", want)
	nv, _ := a.PermissionMode(ctx, id)
	if nv.Source == string(agents.SourceLaunch) || nv.Mode == "" {
		nv.Mode, nv.Source = want, string(agents.SourceLaunch)
	}
	return nv, nil
}

// configDirOf is the configuration directory a session runs with: its
// subscription's (ADR-048), or "" for the user's own.
func (a *agentAdapter) configDirOf(ctx context.Context, id string) string {
	sess, err := store.GetSession(ctx, a.d.store.DB(), id)
	if err != nil || sess.Subscription == "" || sess.Subscription == subs.DefaultID || sess.Subscription == subs.DeepSeekID {
		return ""
	}
	return subs.Dir(a.d.opt.DataDir, sess.Subscription)
}

// Restarting reports whether a session is being restarted in another mode.
func (a *agentAdapter) Restarting(id string) bool { return a.m.Restarting(id) }

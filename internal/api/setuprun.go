package api

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/readiness"
)

// Setting a computer up from another one (issue #1088, ADR-099 amendment of
// 2026-11-26): the laptop's *Set up this computer*, on the linked computer's
// page, runs each step there on a click — an install with winget or
// Homebrew, an agent's install or sign-in, the GitHub CLI's sign-in by device
// flow, Claude in Chrome's "Enabled by default".
//
// The command is never the caller's: the step names one of this computer's
// own checklist rows (GET /v1/setup) and the command is that row's, so a
// linked computer can run here only what this checklist says it would type.
// It runs in a shell tab started for it in the home folder, so its output is
// a terminal the laptop opens with *Show output*, and anything it asks can be
// answered there.

// setupRunStale is how long a finished run is still listed.
const setupRunStale = time.Hour

// setupRunQuiet is how long a run that never showed a program in front of
// its shell's prompt is taken to be running: a command that ends before the
// first look, or one the shell could not start.
const setupRunQuiet = 20 * time.Second

// setupRun is one step started here.
type setupRun struct {
	key, step, agent, shell, command string
	started                          time.Time
	// busy: a program was seen in front of the prompt; idle after that is
	// the end.
	busy     bool
	finished time.Time
	// answered are the GitHub CLI's questions already answered.
	answered map[string]bool
}

// SetupRunView is a run as GET /v1/setup/runs lists it.
type SetupRunView struct {
	Key   string `json:"key"`
	Step  string `json:"step"`
	Agent string `json:"agent,omitempty"`
	// Shell is the shell tab it runs in: *Show output* opens it.
	Shell string `json:"shell"`
	// State is running or finished; finished says nothing of success, which
	// the checklist's next read says (the row ticks, or not).
	State string `json:"state"`
	// Line is the last line it printed.
	Line string `json:"line,omitempty"`
	// Code is the GitHub CLI's one-time code, while its sign-in waits for it.
	Code      string `json:"code,omitempty"`
	StartedAt int64  `json:"started_at"`
}

// The shell operations a run needs beyond ShellController; the daemon's
// shell adapter has them.
type setupShells interface {
	RunAtPrompt(id, text string)
	ShellScreen(id string) ([]string, bool)
	ShellKeys(id, text string) error
}

// ChromeDefaulter turns Claude in Chrome's "Enabled by default" on here
// (hooks.ChromeDefaultKey); the daemon's setupAdapter implements it.
type ChromeDefaulter interface {
	EnableChromeDefault() error
}

// setupStepCommand is the command a step runs, from this computer's own
// checklist; "" when there is none to run (done, or no single command).
func setupStepCommand(rep readiness.Report, step, agent string) string {
	switch step {
	case readiness.KeyGit:
		for _, it := range rep.Items {
			if it.Key == readiness.KeyGit && it.State != readiness.OK {
				return it.Command
			}
		}
	case readiness.KeyAgent:
		for _, a := range rep.Agents {
			if a.ID == agent && a.On && a.State != readiness.OK {
				return a.Command
			}
		}
	case readiness.ToolNode, readiness.ToolGH, readiness.ToolGHAuth:
		for _, t := range rep.Tools {
			if t.ID == step && t.State != readiness.OK {
				return t.Command
			}
		}
	}
	return ""
}

// handleSetupRun is POST /v1/setup/run {"step", "agent"?}: one step of this
// computer's checklist, run here. A step with a command starts a shell tab in
// the home folder and runs it there (200, the run); the same step still
// running answers that run, never a second. chrome_default writes Claude
// Code's setting and answers the checklist. Contract: .ai/03-contracts.md §
// Setup checklist.
func (s *Server) handleSetupRun(w http.ResponseWriter, r *http.Request) {
	if s.d.Setup == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "the setup checklist is unavailable"})
		return
	}
	var body struct {
		Step  string `json:"step"`
		Agent string `json:"agent,omitempty"`
	}
	if !decodeLimited(w, r, 1<<10, &body, `{"step": "git|agent|node|gh|gh_auth|chrome_default", "agent"?: "<id>"}`) {
		return
	}
	if body.Step == readiness.ToolChrome {
		cd, ok := s.d.Setup.(ChromeDefaulter)
		if !ok {
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "this daemon cannot change Claude in Chrome's setting"})
			return
		}
		if err := cd.EnableChromeDefault(); err != nil {
			s.fail(w, err)
			return
		}
		s.handleSetup(w, r)
		return
	}
	shells, ok := s.d.Shells.(setupShells)
	if s.d.Shells == nil || !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "shells are unavailable"})
		return
	}
	in, err := s.d.Setup.SetupFacts(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	in.Link = s.setupLink()
	command := setupStepCommand(readiness.Build(in), body.Step, body.Agent)
	if command == "" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "nothing to run for " + body.Step + ": it is done, or has no command here"})
		return
	}
	key := body.Step
	if body.Step == readiness.KeyAgent {
		key += ":" + body.Agent
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	if run := s.setupRuns[key]; run != nil {
		if v := s.viewRun(run, shells); v.State == "running" {
			writeJSON(w, http.StatusOK, v)
			return
		}
	}
	home := homeRoot()
	if home == "" {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "no home folder to run it in"})
		return
	}
	sh, err := s.d.Shells.StartShell(context.WithoutCancel(r.Context()), home, 120, 32)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	shells.RunAtPrompt(sh.ID, command)
	run := &setupRun{key: key, step: body.Step, agent: body.Agent, shell: sh.ID, command: command, started: time.Now(), answered: map[string]bool{}}
	if s.setupRuns == nil {
		s.setupRuns = map[string]*setupRun{}
	}
	s.setupRuns[key] = run
	s.d.Log.Info("setup step started", "component", "api", "step", key, "shell_id", sh.ID)
	writeJSON(w, http.StatusOK, s.viewRun(run, shells))
	s.PublishShells()
}

// handleSetupRuns is GET /v1/setup/runs: the steps started here this last
// hour, each running or finished, with its last line and, for the GitHub
// CLI's sign-in, its one-time code.
func (s *Server) handleSetupRuns(w http.ResponseWriter, r *http.Request) {
	shells, ok := s.d.Shells.(setupShells)
	if s.d.Shells == nil || !ok {
		writeJSON(w, http.StatusOK, map[string]any{"runs": []SetupRunView{}})
		return
	}
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	out := []SetupRunView{}
	for k, run := range s.setupRuns {
		v := s.viewRun(run, shells)
		if v.State == "finished" && time.Since(run.finished) > setupRunStale {
			delete(s.setupRuns, k)
			continue
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": out})
}

// viewRun reads a run's state from its shell. The caller holds setupMu.
func (s *Server) viewRun(run *setupRun, shells setupShells) SetupRunView {
	v := SetupRunView{Key: run.key, Step: run.step, Agent: run.agent, Shell: run.shell, StartedAt: run.started.UnixMilli(), State: "running"}
	program, alive := "", false
	for _, sh := range s.d.Shells.Shells() {
		if sh.ID == run.shell {
			program, alive = sh.Program, true
			break
		}
	}
	screen, _ := shells.ShellScreen(run.shell)
	if run.finished.IsZero() {
		switch {
		case !alive:
			run.finished = time.Now()
		case program != "":
			run.busy = true
		case run.busy || time.Since(run.started) > setupRunQuiet:
			run.finished = time.Now()
		}
	}
	if !run.finished.IsZero() {
		v.State = "finished"
	}
	v.Line = lastLine(screen, v.State == "finished")
	if run.step == readiness.ToolGHAuth && v.State == "running" {
		v.Code = s.answerGH(run, screen, shells)
	}
	return v
}

// ghCode is the GitHub CLI's one-time code line: "! First copy your one-time
// code: ABCD-1234" (gh 2.103.3, read from its binary 2026-11-26).
var ghCode = regexp.MustCompile(`one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})`)

// answerGH answers the two questions `gh auth login --web` asks in a
// terminal, each once, with its default — whether Git uses the sign-in (yes),
// and Enter to open the browser, after which it waits for the code — and
// returns the code while it is on the screen and the sign-in not done. The
// user's click on Sign in is the consent to both: the row says Git there
// uses the same sign-in.
func (s *Server) answerGH(run *setupRun, screen []string, shells setupShells) string {
	code, done := "", false
	for _, l := range screen {
		switch {
		case strings.Contains(l, "Authenticate Git with your GitHub credentials?") && !run.answered["git"]:
			run.answered["git"] = shells.ShellKeys(run.shell, "\r") == nil
		case strings.Contains(l, "in your browser...") && !run.answered["browser"]:
			run.answered["browser"] = shells.ShellKeys(run.shell, "\r") == nil
		case strings.Contains(l, "Logged in as"):
			done = true
		}
		if m := ghCode.FindStringSubmatch(l); m != nil {
			code = m[1]
		}
	}
	if done {
		return ""
	}
	return code
}

// lastLine is the last line a run printed: the last non-blank row, or once it
// has finished the one above it, since the shell's prompt is back under it.
func lastLine(screen []string, finished bool) string {
	var rows []string
	for _, l := range screen {
		if t := strings.TrimSpace(l); t != "" {
			rows = append(rows, t)
		}
	}
	if finished && len(rows) > 1 {
		rows = rows[:len(rows)-1]
	}
	if len(rows) == 0 {
		return ""
	}
	l := rows[len(rows)-1]
	if utf8.RuneCountInString(l) > 200 {
		l = string([]rune(l)[:200]) + "…"
	}
	return l
}

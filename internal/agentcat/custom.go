package agentcat

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/dspv/caprock/internal/config"
)

// Custom agents (ADR-046): a coding agent the user adds by name, command and
// an argument template, started in a Caprock terminal like the built-ins. A
// Premium feature: the list is kept whatever the licence says, and offered
// and started only while it is active.

// CustomPrefix is how a custom agent is named in a spawn request and on its
// sessions: "custom:aider".
const CustomPrefix = "custom:"

// Limits on what PUT /v1/agents/custom accepts. Generous for any real CLI,
// and small enough that a config file cannot be made to hold a novel.
const (
	maxCustomAgents = 20
	maxArgs         = 32
	maxModels       = 50
	maxField        = 512
)

var customID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

// slug makes an id from a name: "Aider (local)" → "aider-local".
func slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case b.Len() > 0 && !dash:
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.TrimRight(b.String(), "-")
	if len(s) > 32 {
		s = strings.TrimRight(s[:32], "-")
	}
	return s
}

func clean(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > maxField {
		return "", fmt.Errorf("%q is longer than %d bytes", s[:40]+"…", maxField)
	}
	for _, r := range s {
		if r == 0 || r == '\n' || r == '\r' || (unicode.IsControl(r) && r != '\t') {
			return "", errors.New("a field holds a line break or a control character")
		}
	}
	return s, nil
}

// builtinIDs may not be reused as a custom id, so `custom:claude` never
// reads as Claude Code anywhere an id is shown bare.
var builtinIDs = map[string]bool{"claude": true, "codex": true, "opencode": true, "gemini": true, "grok": true, "deepseek": true, "hermes": true, "shell": true}

// ValidateCustom checks and normalises a list for storing: names and commands
// present, ids made from names when absent and unique, fields single-line and
// bounded.
func ValidateCustom(in []config.CustomAgent) ([]config.CustomAgent, error) {
	if len(in) > maxCustomAgents {
		return nil, fmt.Errorf("at most %d custom agents", maxCustomAgents)
	}
	out := make([]config.CustomAgent, 0, len(in))
	seen := map[string]bool{}
	for i, a := range in {
		name, err := clean(a.Name)
		if err != nil {
			return nil, fmt.Errorf("agent %d: %w", i+1, err)
		}
		if name == "" {
			return nil, fmt.Errorf("agent %d has no name", i+1)
		}
		if len(name) > 40 {
			return nil, fmt.Errorf("%s: a name is at most 40 characters", name)
		}
		cmd, err := clean(a.Command)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if cmd == "" {
			return nil, fmt.Errorf("%s has no command", name)
		}
		if strings.ContainsAny(cmd, " \t") && !strings.ContainsAny(cmd, `/\`) {
			// "aider --yes" in the command field: the arguments belong in
			// Args, where each is one argument rather than a shell string.
			return nil, fmt.Errorf("%s: the command is one program; put its arguments in Arguments", name)
		}
		id := strings.TrimSpace(a.ID)
		if id == "" {
			id = slug(name)
		}
		if !customID.MatchString(id) {
			return nil, fmt.Errorf("%s: the id is lowercase letters, digits and dashes", name)
		}
		if builtinIDs[id] {
			id += "-custom"
		}
		if seen[id] {
			return nil, fmt.Errorf("two agents are called %q", id)
		}
		seen[id] = true
		if len(a.Args) > maxArgs {
			return nil, fmt.Errorf("%s: at most %d arguments", name, maxArgs)
		}
		args := make([]string, 0, len(a.Args))
		for _, x := range a.Args {
			c, err := clean(x)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			if c != "" {
				args = append(args, c)
			}
		}
		if len(a.Models) > maxModels {
			return nil, fmt.Errorf("%s: at most %d models", name, maxModels)
		}
		var models []string
		for _, m := range a.Models {
			c, err := clean(m)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			if c != "" {
				models = append(models, c)
			}
		}
		out = append(out, config.CustomAgent{ID: id, Name: name, Command: cmd, Args: args, Models: models})
	}
	return out, nil
}

// FindCustom returns the custom agent a spawn request names ("custom:<id>").
func FindCustom(list []config.CustomAgent, agent string) (config.CustomAgent, bool) {
	id, ok := strings.CutPrefix(agent, CustomPrefix)
	if !ok {
		return config.CustomAgent{}, false
	}
	for _, a := range list {
		if a.ID == id {
			return a, true
		}
	}
	return config.CustomAgent{}, false
}

// HasPlaceholder reports whether an argument template uses {name}.
func HasPlaceholder(args []string, name string) bool {
	for _, a := range args {
		if strings.Contains(a, "{"+name+"}") {
			return true
		}
	}
	return false
}

// Argv fills a custom agent's argument template. `{prompt}` and `{model}`
// are replaced (the agent starts in the session's folder, so it needs no
// placeholder for it); an argument whose placeholder has no value is left
// out, and so is the flag right before it when the argument was the
// placeholder alone ("-m", "{model}"). Each argument stays one argument —
// nothing is split or passed through a shell.
func Argv(args []string, prompt, model string) []string {
	vals := map[string]string{"prompt": prompt, "model": model}
	out := make([]string, 0, len(args))
	for _, a := range args {
		missing, alone := false, false
		filled := a
		for k, v := range vals {
			ph := "{" + k + "}"
			if !strings.Contains(filled, ph) {
				continue
			}
			if v == "" {
				missing = true
				alone = strings.TrimSpace(a) == ph
				break
			}
			filled = strings.ReplaceAll(filled, ph, v)
		}
		if missing {
			if alone && len(out) > 0 && strings.HasPrefix(out[len(out)-1], "-") && !HasAnyPlaceholder(out[len(out)-1]) {
				out = out[:len(out)-1]
			}
			continue
		}
		out = append(out, filled)
	}
	return out
}

// HasAnyPlaceholder reports whether s holds {prompt} or {model}.
func HasAnyPlaceholder(s string) bool {
	return strings.Contains(s, "{prompt}") || strings.Contains(s, "{model}")
}

// CustomEntries lists the custom agents for the picker. resolve finds a
// command's binary ("" when absent); licensed says whether the licence
// covers them.
func CustomEntries(list []config.CustomAgent, resolve func(string) string, licensed bool) []Entry {
	out := make([]Entry, 0, len(list))
	for _, a := range list {
		e := Entry{ID: CustomPrefix + a.ID, Label: a.Name, Custom: true, Locked: !licensed, Models: []Model{}, Prompt: HasPlaceholder(a.Args, "prompt")}
		for _, m := range a.Models {
			e.Models = append(e.Models, Model{ID: m, Label: m})
		}
		e.Installed = resolve(a.Command) != ""
		e.Ready = e.Installed && licensed
		if !e.Installed {
			e.Setup = &Setup{Reason: "not_installed", Text: fmt.Sprintf("%q was not found on this machine.", a.Command)}
		}
		out = append(out, e)
	}
	return out
}

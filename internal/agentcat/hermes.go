package agentcat

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// Hermes Agent (Nous Research's `hermes`) keeps its state in HERMES_HOME,
// default ~/.hermes, or %LOCALAPPDATA%\hermes on native Windows (its README
// and hermes_constants.py, v0.21.6, read 2026-10-15). Its config.yaml names
// the default model under `model:` as `default:` ("Both \"default\" and
// \"model\" work as the key name here", cli-config.yaml.example). A machine
// where that is empty has not run `hermes model`, which picks a provider and
// signs in — the user's own step: Caprock never enters credentials.

func hermesHome(env Env) string {
	if v := env.get("HERMES_HOME"); v != "" {
		return v
	}
	if env.GOOS == "windows" {
		if la := env.get("LOCALAPPDATA"); la != "" {
			return filepath.Join(la, "hermes")
		}
		return filepath.Join(env.Home, "AppData", "Local", "hermes")
	}
	return filepath.Join(env.Home, ".hermes")
}

// hermesHasModel reports whether config.yaml names a default model. Only
// whether there is one is read; the value is never kept or shown.
func hermesHasModel(env Env) bool {
	f, err := os.Open(filepath.Join(hermesHome(env), "config.yaml"))
	if err != nil {
		return false
	}
	defer f.Close()
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t\r")
		if line == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			in = strings.HasPrefix(line, "model:")
			if in {
				// `model: some/model` on one line.
				if v := cleanYAML(strings.TrimPrefix(line, "model:")); v != "" {
					return true
				}
			}
			continue
		}
		if !in {
			continue
		}
		t := strings.TrimSpace(line)
		for _, key := range []string{"default:", "model:"} {
			if strings.HasPrefix(t, key) && cleanYAML(strings.TrimPrefix(t, key)) != "" {
				return true
			}
		}
	}
	return false
}

// cleanYAML is a scalar with its comment and quotes taken off.
func cleanYAML(v string) string {
	if i := strings.Index(v, " #"); i >= 0 {
		v = v[:i]
	}
	v = strings.TrimSpace(v)
	v = strings.Trim(v, `"'`)
	if v == "~" || v == "null" {
		return ""
	}
	return strings.TrimSpace(v)
}

func hermesEntry(env Env, ok, win bool) Entry {
	e := Entry{ID: "hermes", Label: "Hermes", Installed: ok, Observed: true, Prompt: true, TypedModel: true, Models: []Model{}}
	if !ok {
		// github.com/NousResearch/hermes-agent README, read 2026-10-15.
		cmd := "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
		if win {
			cmd = "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
		}
		e.Setup = notInstalled("Hermes", cmd, "https://github.com/NousResearch/hermes-agent")
		return e
	}
	e.Ready = true
	if !hermesHasModel(env) {
		// A hint, not a block: Hermes asks on its own first start too.
		e.Setup = &Setup{Reason: "no_provider", Text: "Hermes has no model chosen on this machine; pick a provider and sign in once with its own setup.", Command: "hermes model", Docs: "https://github.com/NousResearch/hermes-agent"}
	}
	return e
}

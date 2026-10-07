package agents

import (
	"strings"
	"testing"
)

func TestCarriedModePassesOnlyWhatTheFlagAccepts(t *testing.T) {
	for in, want := range map[string]string{
		"bypassPermissions": "bypassPermissions",
		"acceptEdits":       "acceptEdits",
		"plan":              "plan",
		"auto":              "auto",
		"default":           "", // Claude Code's word for its own default: no flag starts it
		"":                  "",
		"somethingNew":      "",
	} {
		if got := CarriedMode(in); got != want {
			t.Errorf("CarriedMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// A carried mode reaches Claude Code's argv on a resume and on a fork alike.
//
// Bypass is the exception: it is spelled --dangerously-skip-permissions,
// because --permission-mode bypassPermissions leaves the session asking (see
// claudeLaunch). The owner's "never asks" has to actually never ask.
func TestResumeCarriesTheModeOntoTheCommandLine(t *testing.T) {
	for _, fork := range []bool{false, true} {
		l, err := claudeLaunch(launchInput{SessionID: "new", Resume: "old", Fork: fork, Mode: "acceptEdits"})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for i, a := range l.args {
			if a == "--permission-mode" && i+1 < len(l.args) && l.args[i+1] == "acceptEdits" {
				found = true
			}
		}
		if !found {
			t.Errorf("fork=%v: argv %v has no --permission-mode acceptEdits", fork, l.args)
		}
	}
}

// Bypass never asks, so it is the orchestrator's own flag rather than a mode
// that keeps prompting. The two are never combined: Claude Code takes one.
func TestBypassSkipsPermissionsOutright(t *testing.T) {
	for _, fork := range []bool{false, true} {
		l, err := claudeLaunch(launchInput{SessionID: "new", Resume: "old", Fork: fork, Mode: "bypassPermissions"})
		if err != nil {
			t.Fatal(err)
		}
		skip, mode := false, false
		for _, a := range l.args {
			switch a {
			case "--dangerously-skip-permissions":
				skip = true
			case "--permission-mode":
				mode = true
			}
		}
		if !skip || mode {
			t.Errorf("fork=%v: argv %v, want --dangerously-skip-permissions and no --permission-mode", fork, l.args)
		}
	}
}

// Caprock writes files the user then refers to by path — a pasted screenshot
// — outside every working directory. Naming them keeps a user who has the
// read block on from being asked about Caprock's own files.
func TestOwnDirectoriesAreAllowedToBeRead(t *testing.T) {
	l, err := claudeLaunch(launchInput{SessionID: "s", AddDirs: []string{"/data/paste", "/data/chats"}})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for i, a := range l.args {
		if a == "--add-dir" && i+1 < len(l.args) {
			got = append(got, l.args[i+1])
		}
	}
	if len(got) != 2 || got[0] != "/data/paste" || got[1] != "/data/chats" {
		t.Errorf("argv %v, want --add-dir for each of /data/paste and /data/chats", l.args)
	}
}

// A project's instructions are appended to Claude Code's own system prompt,
// on a start and on a resume; none, no flag.
func TestProjectPromptIsAppended(t *testing.T) {
	for _, in := range []launchInput{
		{SessionID: "s", SystemPrompt: "Answer in British English."},
		{SessionID: "s", Resume: "old", SystemPrompt: "Answer in British English."},
	} {
		l, err := claudeLaunch(in)
		if err != nil {
			t.Fatal(err)
		}
		at := -1
		for i, a := range l.args {
			if a == "--append-system-prompt" {
				at = i
			}
		}
		if at < 0 || at+1 >= len(l.args) || l.args[at+1] != "Answer in British English." {
			t.Errorf("resume=%q: argv %v, want --append-system-prompt with the text", in.Resume, l.args)
		}
		for _, a := range l.args {
			if a == "--system-prompt" {
				t.Errorf("argv %v replaces Claude Code's own system prompt", l.args)
			}
		}
	}
	l, _ := claudeLaunch(launchInput{SessionID: "s"})
	for _, a := range l.args {
		if a == "--append-system-prompt" {
			t.Errorf("argv %v has a prompt flag with no prompt", l.args)
		}
	}
}

// Codex takes the project's instructions as a config override, quoted as TOML
// so quotes and newlines survive; codex-cli 0.161.0 followed such a rule.
func TestProjectPromptReachesCodex(t *testing.T) {
	text := "Rules:\n- Say \"hi\" first."
	want := `developer_instructions="Rules:\u000A- Say \"hi\" first."`
	for _, in := range []launchInput{
		{SessionID: "s", Cwd: t.TempDir(), SystemPrompt: text},
		{SessionID: "s", Cwd: t.TempDir(), Resume: "old", SystemPrompt: text},
	} {
		l, err := codexLaunch(in)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for i, a := range l.args {
			if a == want && i > 0 && l.args[i-1] == "-c" {
				found = true
			}
		}
		if !found {
			t.Errorf("resume=%q: argv %q, want -c %s", in.Resume, l.args, want)
		}
	}
	l, _ := codexLaunch(launchInput{SessionID: "s", Cwd: t.TempDir()})
	for _, a := range l.args {
		if strings.HasPrefix(a, "developer_instructions=") {
			t.Errorf("argv %v has instructions with none set", l.args)
		}
	}
}

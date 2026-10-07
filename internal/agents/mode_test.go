package agents

import "testing"

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

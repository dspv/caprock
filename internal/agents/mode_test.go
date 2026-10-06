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
func TestResumeCarriesTheModeOntoTheCommandLine(t *testing.T) {
	for _, fork := range []bool{false, true} {
		l, err := claudeLaunch(launchInput{SessionID: "new", Resume: "old", Fork: fork, Mode: "bypassPermissions"})
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for i, a := range l.args {
			if a == "--permission-mode" && i+1 < len(l.args) && l.args[i+1] == "bypassPermissions" {
				found = true
			}
		}
		if !found {
			t.Errorf("fork=%v: argv %v has no --permission-mode bypassPermissions", fork, l.args)
		}
	}
}

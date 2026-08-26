package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const userSettings = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(git *)"],
    "deny": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {"type": "command", "command": "/usr/local/bin/my-guard.sh"}
        ]
      }
    ],
    "Notification": [
      {"hooks": [{"type": "command", "command": "say done"}]}
    ]
  },
  "model": "opus",
  "zzz_last": 1
}
`

func write(t *testing.T, dir, content string) string {
	t.Helper()
	p := filepath.Join(dir, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestInstallIsNonDestructiveAndUninstallReverts(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, userSettings)
	shim := filepath.Join(dir, "Application Support", "caprock", "caprock-hook")

	backup, err := Install(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if backup == "" {
		t.Fatal("expected a backup path")
	}
	if b, _ := os.ReadFile(backup); string(b) != userSettings {
		t.Fatal("backup differs from original")
	}
	after, _ := os.ReadFile(p)
	s := string(after)
	// Every foreign key/value survives, in order.
	for _, needle := range []string{`"$schema"`, `"permissions"`, `"Bash(git *)"`, `my-guard.sh`, `say done`, `"model": "opus"`, `"zzz_last": 1`} {
		if !strings.Contains(s, needle) {
			t.Errorf("lost %s:\n%s", needle, s)
		}
	}
	if strings.Index(s, `"$schema"`) > strings.Index(s, `"permissions"`) || strings.Index(s, `"model"`) > strings.Index(s, `"zzz_last"`) {
		t.Errorf("key order changed:\n%s", s)
	}
	// The user's PreToolUse guard is still first; ours appended.
	if strings.Index(s, "my-guard.sh") > strings.Index(s, "caprock-hook") {
		t.Errorf("our entry was not appended after the user's:\n%s", s)
	}
	// Path with spaces is quoted.
	if !strings.Contains(s, `\"`+shim+`\"`) && !strings.Contains(s, `"\"`) {
		t.Errorf("shim path with spaces not quoted:\n%s", s)
	}
	st, err := Inspect(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Installed) != len(Events) || len(st.Missing) != 0 {
		t.Fatalf("status after install: %+v", st)
	}
	// Idempotent: second install writes nothing and makes no second backup.
	b2, err := Install(p, shim)
	if err != nil || b2 != "" {
		t.Fatalf("second install: backup=%q err=%v", b2, err)
	}
	again, _ := os.ReadFile(p)
	if string(again) != s {
		t.Fatal("second install changed the file")
	}
	matches, _ := filepath.Glob(p + ".caprock-backup-*")
	if len(matches) != 1 {
		t.Fatalf("backups: %v", matches)
	}

	removed, err := Uninstall(p, shim)
	if err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	reverted, _ := os.ReadFile(p)
	// Semantically identical to the original (re-rendered with the same indent).
	want, _ := MarshalIndent(mustParse(t, userSettings))
	if string(reverted) != string(want) {
		t.Fatalf("uninstall did not revert cleanly:\n--- got\n%s\n--- want\n%s", reverted, want)
	}
	if removed, _ := Uninstall(p, shim); removed {
		t.Fatal("second uninstall removed something")
	}
}

func TestInstallCreatesMissingFileAndUninstallDropsEmptyHooks(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude", "settings.json")
	shim := filepath.Join(dir, "caprock-hook")
	backup, err := Install(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if backup != "" {
		t.Fatalf("no original ⇒ no backup, got %q", backup)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), `"SessionStart"`) || !strings.Contains(string(b), `"timeout": 5`) {
		t.Fatalf("content:\n%s", b)
	}
	if _, err := Uninstall(p, shim); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if strings.TrimSpace(string(b)) != "{}" {
		t.Fatalf("expected empty object after uninstall, got %q", b)
	}
}

func TestInstallRefusesUnparsableSettings(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks": {`)
	if _, err := Install(p, "/x/caprock-hook"); err == nil {
		t.Fatal("expected error on unparsable settings")
	}
	if b, _ := os.ReadFile(p); string(b) != `{"hooks": {` {
		t.Fatal("unparsable file was modified")
	}
}

func TestUninstallRecognisesMovedShim(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/old/place/caprock-hook","timeout":5}]}]}}`)
	removed, err := Uninstall(p, "/new/place/caprock-hook")
	if err != nil || !removed {
		t.Fatalf("moved shim not removed: %v %v", removed, err)
	}
}

func TestOrderedJSONRoundTrip(t *testing.T) {
	src := `{"b":1,"a":[true,null,{"z":"q","y":2.5}],"c":{"n":12345678901234567890}}`
	v := mustParse(t, src)
	out, err := MarshalIndent(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Index(s, `"b"`) > strings.Index(s, `"a"`) || strings.Index(s, `"z"`) > strings.Index(s, `"y"`) {
		t.Fatalf("order lost:\n%s", s)
	}
	if !strings.Contains(s, "12345678901234567890") {
		t.Fatalf("big number mangled:\n%s", s)
	}
	if _, err := ParseOrdered([]byte(`{"a":1} trailing`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

// Events is a contract: the shim registers for exactly these 8 Claude Code hook
// events. Pinning them here means dropping or renaming one fails a test instead
// of silently shrinking what Caprock observes.
func TestEventsListIsPinned(t *testing.T) {
	want := []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "PreCompact", "StopFailure"}
	if len(Events) != len(want) {
		t.Fatalf("event count changed: got %d (%v), want %d", len(Events), Events, len(want))
	}
	for i, e := range want {
		if Events[i] != e {
			t.Fatalf("event %d: got %q, want %q", i, Events[i], e)
		}
	}
}

func mustParse(t *testing.T, s string) any {
	t.Helper()
	v, err := ParseOrdered([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// The daemon inspects with the data-dir shim path, but a Homebrew / `go install`
// layout with no sibling caprock-hook registers the self-hook form
// (`/opt/homebrew/bin/caprock hook`). Inspect must recognize that as ours, or a
// working install reads as 0/N events registered. This is the bug behind
// `caprock status` showing 0/8 while `caprock hooks status` showed 8/8.
func TestInspectRecognisesSelfHookForm(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/homebrew/bin/caprock hook","timeout":5}]}]}}`)
	// Inspect with the data-dir shim path (what the daemon passes) — a different
	// path from the self-hook command that was actually installed.
	st, err := Inspect(p, filepath.Join(dir, "caprock-hook"))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range st.Installed {
		if ev == "Stop" {
			found = true
		}
	}
	if !found {
		t.Fatalf("self-hook form not recognized as ours: installed=%v", st.Installed)
	}
}

// Uninstall must also recognize the self-hook form (`caprock hook`), or a
// brew/go-install user cannot cleanly remove hooks and ends up with duplicates.
func TestUninstallRecognisesSelfHookForm(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/homebrew/bin/caprock hook","timeout":5}]}]}}`)
	removed, err := Uninstall(p, filepath.Join(dir, "caprock-hook"))
	if err != nil || !removed {
		t.Fatalf("self-hook form not removed: removed=%v err=%v", removed, err)
	}
}

func TestStatuslineInstallIsIdempotentAndNonDestructive(t *testing.T) {
	dir := t.TempDir()
	cmd := "/opt/homebrew/bin/caprock statusline"
	// Start from a settings file with an unrelated key and existing hooks.
	p := write(t, dir, `{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/caprock-hook"}]}]}}`)

	// Nothing installed yet.
	if ours, present, _ := StatuslineInstalled(p, cmd); ours || present {
		t.Fatalf("statusline reported present before install: ours=%v present=%v", ours, present)
	}
	// Install.
	if _, err := InstallStatusline(p, cmd); err != nil {
		t.Fatal(err)
	}
	if ours, present, _ := StatuslineInstalled(p, cmd); !ours || !present {
		t.Fatalf("statusline not ours after install: ours=%v present=%v", ours, present)
	}
	// Idempotent: second install changes nothing (empty backup).
	if backup, err := InstallStatusline(p, cmd); err != nil || backup != "" {
		t.Fatalf("re-install not a no-op: backup=%q err=%v", backup, err)
	}
	// The unrelated key and the hooks survived.
	rb, _ := os.ReadFile(p)
	root := mustParse(t, string(rb))
	obj := root.(*Object)
	if v, _ := obj.Get("model"); v != "opus" {
		t.Fatalf("unrelated key clobbered: %v", v)
	}
	if _, ok := obj.Get("hooks"); !ok {
		t.Fatal("hooks clobbered by statusline install")
	}
	// Uninstall removes only ours.
	removed, err := UninstallStatusline(p, cmd)
	if err != nil || !removed {
		t.Fatalf("uninstall: removed=%v err=%v", removed, err)
	}
	if _, present, _ := StatuslineInstalled(p, cmd); present {
		t.Fatal("statusline still present after uninstall")
	}
}

func TestStatuslineDoesNotClobberUsersOwn(t *testing.T) {
	dir := t.TempDir()
	cmd := "/opt/homebrew/bin/caprock statusline"
	p := write(t, dir, `{"statusLine":{"type":"command","command":"/usr/bin/my-prompt"}}`)
	// Detected as present-but-not-ours.
	ours, present, err := StatuslineInstalled(p, cmd)
	if err != nil || ours || !present {
		t.Fatalf("user statusLine misread: ours=%v present=%v err=%v", ours, present, err)
	}
	// Uninstall must NOT remove the user's own.
	if removed, _ := UninstallStatusline(p, cmd); removed {
		t.Fatal("uninstall removed the user's own statusLine")
	}
}

func TestStatuslineRecognisesSelfForm(t *testing.T) {
	if !isOurStatusline("/opt/homebrew/bin/caprock statusline", "/somewhere/else/caprock statusline") {
		t.Fatal("self-form statusline not recognized by base name")
	}
	if isOurStatusline("/usr/bin/other-tool status", "x") {
		t.Fatal("unrelated command matched as ours")
	}
}

// A caprock installed under a path with spaces registers as `"…/caprock"
// statusline` — the path quoted, the subcommand outside. isOurStatusline must
// still recognize it (else install/uninstall would duplicate or miss it).
func TestStatuslineRecognisesQuotedPathForm(t *testing.T) {
	quoted := `"/Users/My Name/bin/caprock" statusline`
	if !isOurStatusline(quoted, "/whatever/caprock statusline") {
		t.Fatalf("quoted-path statusline not recognized: %s", quoted)
	}
	// A quoted path that is NOT caprock is not ours.
	if isOurStatusline(`"/Users/My Name/bin/other" statusline`, "x") {
		t.Fatal("non-caprock quoted path matched as ours")
	}
	// A quoted path with the wrong subcommand is not ours.
	if isOurStatusline(`"/Users/My Name/bin/caprock" hook`, "x") {
		t.Fatal("wrong subcommand matched as statusline")
	}
}

// A "hooks" key that is not a JSON object — null, an array, a string — used to
// reach hasOurEntry as a nil *Object and panic with a SIGSEGV on `caprock up`,
// the very first command a new user runs. Realistic: a user who tried hooks and
// cleared them, or another tool that wrote an empty array. Install must return
// an error that names the file and what is wrong, and must never overwrite the
// user's value.
func TestInstallRefusesNonObjectHooksKey(t *testing.T) {
	for _, tc := range []struct{ name, content, want string }{
		{"null", `{"hooks": null}`, "null"},
		{"array", `{"hooks": []}`, "an array"},
		{"string", `{"hooks": "caprock-hook"}`, "a string"},
		{"number", `{"hooks": 1}`, "a number"},
		{"bool", `{"hooks": true}`, "a boolean"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			p := write(t, dir, tc.content)
			shim := filepath.Join(dir, "caprock-hook")

			// Must not panic, and must fail loudly.
			backup, err := Install(p, shim)
			if err == nil {
				t.Fatalf("expected an error for hooks=%s, got backup=%q", tc.name, backup)
			}
			// The message names the file, the key's actual kind, and the remedy.
			for _, needle := range []string{p, `"hooks"`, tc.want, "not a JSON object", "will not overwrite"} {
				if !strings.Contains(err.Error(), needle) {
					t.Errorf("error message missing %q: %v", needle, err)
				}
			}
			if backup != "" {
				t.Errorf("no write should have happened, got backup %q", backup)
			}
			// The user's file is untouched, byte for byte.
			if b, _ := os.ReadFile(p); string(b) != tc.content {
				t.Errorf("settings.json was modified:\n got %s\nwant %s", b, tc.content)
			}
			// Inspect already nil-checks; it must stay non-panicking too, and
			// report every event missing rather than claiming an install.
			st, err := Inspect(p, shim)
			if err != nil {
				t.Fatalf("Inspect: %v", err)
			}
			if len(st.Installed) != 0 || len(st.Missing) != len(Events) {
				t.Fatalf("Inspect on a non-object hooks key: %+v", st)
			}
			// Uninstall must be a clean no-op, not a panic.
			if removed, err := Uninstall(p, shim); removed || err != nil {
				t.Fatalf("Uninstall: removed=%v err=%v", removed, err)
			}
		})
	}
}

// On a machine with no ~/.claude/settings.json, `caprock up` runs Install
// (which creates the file) and then the statusline install, whose backupOnce
// saw a file that now existed and snapshotted it. The resulting
// `.caprock-backup-*` held Caprock's own hooks while being named as the user's
// restore point. There was no original, so there must be no backup.
func TestFirstRunBackupIsNotOurOwnOutput(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude", "settings.json")
	shim := filepath.Join(dir, "caprock-hook")
	slCmd := filepath.Join(dir, "caprock") + " statusline"

	// No settings.json exists: Install creates it and makes no backup.
	if backup, err := Install(p, shim); err != nil || backup != "" {
		t.Fatalf("install on a fresh machine: backup=%q err=%v", backup, err)
	}
	// The statusline install follows in the same `caprock up` run.
	if backup, err := InstallStatusline(p, slCmd); err != nil || backup != "" {
		t.Fatalf("statusline backed up a file we created ourselves: backup=%q err=%v", backup, err)
	}
	matches, _ := filepath.Glob(p + ".caprock-backup-*")
	if len(matches) != 0 {
		b, _ := os.ReadFile(matches[0])
		t.Fatalf("first run left %d backup(s) of our own output: %v\n%s", len(matches), matches, b)
	}

	// A real user file, by contrast, must still be backed up exactly once.
	dir2 := t.TempDir()
	p2 := write(t, dir2, userSettings)
	shim2 := filepath.Join(dir2, "caprock-hook")
	backup, err := Install(p2, shim2)
	if err != nil || backup == "" {
		t.Fatalf("a pre-existing settings.json must be backed up: backup=%q err=%v", backup, err)
	}
	if b, _ := os.ReadFile(backup); string(b) != userSettings {
		t.Fatalf("backup is not the user's original:\n%s", b)
	}
}

// A Windows shim path has no spaces and is still destroyed unquoted: Claude
// Code runs command hooks through bash, which reads every backslash as an
// escape. Reported from a real install, where the whole of
// `C:\Users\las\AppData\Roaming\caprock\caprock-hook.exe` reached the shell as
// `C:UserslasAppDataRoamingcaprockcaprock-hook.exe` and every hook silently
// failed — the only symptom being one "command not found" line.
//
// Written with a literal Windows path rather than filepath.Join so it runs the
// same on every OS: the bug is in what we write into settings.json, not in how
// the host resolves paths.
func TestWindowsShimPathIsQuoted(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, userSettings)
	const shim = `C:\Users\las\AppData\Roaming\caprock\caprock-hook.exe`

	if _, err := Install(p, shim); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	s := string(got)

	// Quoted *and* written with forward slashes: bash reads a backslash as an
	// escape, so a quoted backslash path is one unquoting away from breaking
	// again, and Windows accepts forward slashes in every API.
	if want := `\"C:/Users/las/AppData/Roaming/caprock/caprock-hook.exe\"`; !strings.Contains(s, want) {
		t.Errorf("expected a quoted forward-slash path:\n%s", s)
	}
	if strings.Contains(s, `caprock\\caprock-hook`) {
		t.Errorf("backslashes survived into the command:\n%s", s)
	}

	// And the install must still be recognised as ours, or `caprock status`
	// reports 0/N hooks on a machine where they are installed correctly.
	st, err := Inspect(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Missing) != 0 {
		t.Errorf("quoted entry not recognised; missing = %v", st.Missing)
	}
}

// An entry written before the always-quote fix — bare, no spaces in the path —
// must keep being recognised, or upgrading reports every hook missing and
// offers to install what is already there.
func TestUnquotedLegacyEntryStillRecognised(t *testing.T) {
	dir := t.TempDir()
	const shim = `C:\Users\las\AppData\Roaming\caprock\caprock-hook.exe`

	// Hand-write the pre-fix shape: command with no surrounding quotes.
	legacy := `{"hooks":{`
	for i, ev := range Events {
		if i > 0 {
			legacy += ","
		}
		legacy += `"` + ev + `":[{"hooks":[{"type":"command","command":"` +
			strings.ReplaceAll(shim, `\`, `\\`) + `","timeout":5}]}]`
	}
	legacy += `}}`
	p := write(t, dir, legacy)

	st, err := Inspect(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Missing) != 0 {
		t.Errorf("legacy unquoted entry not recognised; missing = %v", st.Missing)
	}
}

// The fallback registration is `<exe> hook`: a path and an argument. Quoting
// the whole string sends bash after a binary literally named
// "…/caprock.exe hook", which exists nowhere — so only the path is quoted.
func TestSelfHookFormQuotesOnlyThePath(t *testing.T) {
	dir := t.TempDir()
	p := write(t, dir, userSettings)
	const shim = `C:\Program Files\caprock\caprock.exe hook`

	if _, err := Install(p, shim); err != nil {
		t.Fatal(err)
	}
	s, _ := os.ReadFile(p)
	if want := `\"C:/Program Files/caprock/caprock.exe\" hook`; !strings.Contains(string(s), want) {
		t.Errorf("expected the path quoted and `hook` left outside:\n%s", s)
	}
	// Still ours, or status reports a working install as broken.
	st, err := Inspect(p, shim)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Missing) != 0 {
		t.Errorf("self-hook entry not recognised; missing = %v", st.Missing)
	}
}

// These tests never touch the real home directory and never invoke launchctl,
// systemctl or schtasks. Everything they assert is a pure function of a Plan
// whose Home is a t.TempDir(), which is what lets one machine check all three
// platforms' output — and what keeps the Windows CI job green (engineering
// rule 2) without a Windows-only escape hatch.
package service

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// testPlan builds a plan for one target OS rooted in a temp home. Paths are
// deliberately given a space and an ampersand: the two characters that break a
// plist, a systemd unit and a .cmd in three different ways.
func testPlan(t *testing.T, goos string) Plan {
	t.Helper()
	home := t.TempDir()
	return Plan{
		Exe:     filepath.Join(home, "Applications", "cap rock", "caprock"),
		DataDir: filepath.Join(home, "Application Support", "caprock & co"),
		Port:    4173,
		Home:    home,
		GOOS:    goos,
	}
}

// --- the shape of what gets run -------------------------------------------

// --foreground is the single most important flag in this package: every one of
// the three supervisors tracks the process it started, so a daemon that
// double-forks looks like an instant exit and gets restarted forever.
func TestArgsAlwaysRunInTheForeground(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		args := strings.Join(testPlan(t, goos).Args(), " ")
		if !strings.Contains(args, "--foreground") {
			t.Errorf("%s: args %q lack --foreground; the supervisor would restart the daemon forever", goos, args)
		}
		// A login agent opening a browser tab at every boot is a bug report.
		if !strings.Contains(args, "--no-open") {
			t.Errorf("%s: args %q lack --no-open", goos, args)
		}
		// Hook/statusline registration is a consent decision. It belongs to an
		// interactive `caprock up`, never to a background login agent.
		if !strings.Contains(args, "--no-hooks") {
			t.Errorf("%s: args %q lack --no-hooks — a login agent must not edit settings.json", goos, args)
		}
	}
}

// The user's chosen port must survive a reboot; defaulting to 4173 silently
// would move the dashboard out from under them.
func TestArgsCarryThePort(t *testing.T) {
	p := testPlan(t, "darwin")
	p.Port = 5999
	args := strings.Join(p.Args(), " ")
	if !strings.Contains(args, "--port 5999") {
		t.Errorf("args = %q; want the configured port 5999", args)
	}
	// Port 0 means "not set" — it must not appear as `--port 0`.
	p.Port = 0
	if args := strings.Join(p.Args(), " "); strings.Contains(args, "--port") {
		t.Errorf("args = %q; want no --port when the port is unset", args)
	}
}

// --hive is optional and must not appear unless asked for: a login agent that
// silently starts an orchestrator would be a very unwelcome surprise.
func TestArgsIncludeHiveOnlyWhenRequested(t *testing.T) {
	p := testPlan(t, "linux")
	if strings.Contains(strings.Join(p.Args(), " "), "--hive") {
		t.Fatal("args carry --hive with no hive dir set")
	}
	p.HiveDir = "/tmp/hive"
	if !strings.Contains(strings.Join(p.Args(), " "), "--hive /tmp/hive") {
		t.Errorf("args = %v; want --hive /tmp/hive", p.Args())
	}
}

// --- per-platform file paths ----------------------------------------------

func TestPathPerPlatform(t *testing.T) {
	cases := []struct {
		goos string
		want []string // path fragments that must all be present
	}{
		{"darwin", []string{"Library", "LaunchAgents", "dev.caprock.daemon.plist"}},
		{"linux", []string{".config", "systemd", "user", "caprock.service"}},
		{"windows", []string{"Start Menu", "Programs", "Startup", "caprock.cmd"}},
	}
	for _, tc := range cases {
		p := testPlan(t, tc.goos)
		// XDG_CONFIG_HOME/APPDATA from the developer's own environment would
		// otherwise leak into the expected path.
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("APPDATA", "")
		got, err := p.Path()
		if err != nil {
			t.Fatalf("%s: Path: %v", tc.goos, err)
		}
		if !strings.HasPrefix(got, p.Home) {
			t.Errorf("%s: path %q is outside the home %q — this command must never write elsewhere", tc.goos, got, p.Home)
		}
		for _, frag := range tc.want {
			if !strings.Contains(got, frag) {
				t.Errorf("%s: path = %q; want it to contain %q", tc.goos, got, frag)
			}
		}
	}
}

// An OS with no mechanism must say so with an actionable message rather than
// writing a file nothing reads.
func TestUnsupportedPlatformFailsClearly(t *testing.T) {
	p := testPlan(t, "plan9")
	if p.Supported() {
		t.Fatal("plan9 reported as supported")
	}
	_, err := p.Path()
	if err == nil {
		t.Fatal("Path on an unsupported OS returned no error")
	}
	if !strings.Contains(err.Error(), "caprock up") {
		t.Errorf("error %q does not tell the user what to do instead", err)
	}
	if _, _, err := p.Render(); err == nil {
		t.Error("Render on an unsupported OS returned no error")
	}
}

// Nothing here may ever resolve into ~/.claude — that directory belongs to
// Claude Code, and `caprock service` has no business in it.
func TestNeverWritesIntoClaudeDir(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		p := testPlan(t, goos)
		path, err := p.Path()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(filepath.ToSlash(path), "/.claude") {
			t.Errorf("%s: definition path %q is inside ~/.claude", goos, path)
		}
		body, _, err := p.Render()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(filepath.ToSlash(string(body)), "/.claude") {
			t.Errorf("%s: rendered file references ~/.claude", goos)
		}
	}
}

// --- macOS: the plist -----------------------------------------------------

// The keys asserted here are exactly the ones whose absence produces a broken
// or hostile agent: no RunAtLoad = no autostart at all; no
// KeepAlive/SuccessfulExit=false = launchd fights `caprock down` and restarts
// the daemon the user just stopped.
func TestPlistCarriesTheLoadBearingKeys(t *testing.T) {
	p := testPlan(t, "darwin")
	body, mode, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{
		"<key>Label</key>",
		"<string>" + Label + "</string>",
		"<key>RunAtLoad</key>",
		"<key>KeepAlive</key>",
		"<key>SuccessfulExit</key>",
		"<key>ProcessType</key>",
		"<string>Adaptive</string>",
		"<key>StandardOutPath</key>",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("plist is missing %s", want)
		}
	}
	// SuccessfulExit must be false, not true: true would mean "restart it when
	// it exits cleanly", i.e. exactly the behaviour `caprock down` must not hit.
	i := strings.Index(s, "<key>SuccessfulExit</key>")
	if i < 0 || !strings.Contains(s[i:min(i+60, len(s))], "<false/>") {
		t.Error("SuccessfulExit is not <false/> — launchd would fight `caprock down`")
	}
	if mode != 0o644 {
		t.Errorf("plist mode = %o; want 0644 (launchd must be able to read it)", mode)
	}
}

// A home directory or data dir containing `&` produces XML launchd refuses to
// parse — which fails silently as "autostart just doesn't work".
func TestPlistEscapesXML(t *testing.T) {
	p := testPlan(t, "darwin")
	p.DataDir = `/Users/a&b/<data>`
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if strings.Contains(s, "a&b") || strings.Contains(s, "<data>") {
		t.Errorf("plist contains unescaped XML metacharacters:\n%s", s)
	}
	if !strings.Contains(s, "a&amp;b") || !strings.Contains(s, "&lt;data&gt;") {
		t.Errorf("plist did not escape & and <>:\n%s", s)
	}
}

// The whole point of os.Executable(): a bare "caprock" depends on a PATH that
// login agents do not have.
func TestPlistUsesTheAbsoluteExecutablePath(t *testing.T) {
	p := testPlan(t, "darwin")
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "<string>"+plistEscape(p.Exe)+"</string>") {
		t.Errorf("plist does not run the absolute path %q", p.Exe)
	}
}

// A custom data dir must survive the reboot, or the user gets a second, empty
// database at every login.
func TestPlistCarriesTheDataDir(t *testing.T) {
	p := testPlan(t, "darwin")
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, "CAPROCK_DATA_DIR") || !strings.Contains(s, plistEscape(p.DataDir)) {
		t.Errorf("plist does not pass CAPROCK_DATA_DIR=%q:\n%s", p.DataDir, s)
	}
}

// --- Linux: the systemd unit ----------------------------------------------

func TestUnitCarriesTheLoadBearingDirectives(t *testing.T) {
	p := testPlan(t, "linux")
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{"[Unit]", "[Service]", "[Install]", "Type=simple", "ExecStart=", "WantedBy=default.target"} {
		if !strings.Contains(s, want) {
			t.Errorf("unit is missing %q", want)
		}
	}
	// on-failure, never always: `caprock down` exits 0 and must stay down.
	if !strings.Contains(s, "Restart=on-failure") {
		t.Error("unit lacks Restart=on-failure")
	}
	if strings.Contains(s, "Restart=always") {
		t.Error("unit uses Restart=always — systemd would fight `caprock down`")
	}
	// StartLimit* moved from [Service] to [Unit] in systemd v229. Under
	// [Service] a modern systemd ignores them with only a log warning, so a
	// daemon that cannot bind its port would restart every 5s forever. Getting
	// the section wrong fails silently, which is why it is pinned here.
	unitSection := s[strings.Index(s, "[Unit]"):strings.Index(s, "[Service]")]
	for _, d := range []string{"StartLimitIntervalSec=", "StartLimitBurst="} {
		if !strings.Contains(unitSection, d) {
			t.Errorf("%s is not in the [Unit] section — systemd v229+ ignores it under [Service]:\n%s", d, s)
		}
	}
}

// systemd splits ExecStart on whitespace and expands `%`. An unescaped path
// with a space produces a unit that fails to start with a confusing message.
func TestUnitEscapesSpacesAndPercent(t *testing.T) {
	p := testPlan(t, "linux")
	p.Exe = "/opt/my apps/caprock"
	p.DataDir = "/data/100%/caprock"
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, `ExecStart="/opt/my apps/caprock"`) {
		t.Errorf("ExecStart did not quote a path with a space:\n%s", s)
	}
	if strings.Contains(s, "/data/100%/caprock") {
		t.Errorf("unit left a bare %% in a value — systemd reads it as a specifier:\n%s", s)
	}
	if !strings.Contains(s, "/data/100%%/caprock") {
		t.Errorf("unit did not escape %% as %%%%:\n%s", s)
	}
}

// XDG_CONFIG_HOME is what systemd itself honours; ignoring it writes the unit
// where systemd will never look.
func TestUnitDirHonoursXDGConfigHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/xdg/conf")
	if got := linuxUserUnitDir("/home/u"); got != filepath.Join("/xdg/conf", "systemd", "user") {
		t.Errorf("unit dir = %q; want it under XDG_CONFIG_HOME", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	if got := linuxUserUnitDir("/home/u"); got != filepath.Join("/home/u", ".config", "systemd", "user") {
		t.Errorf("unit dir = %q; want the ~/.config default", got)
	}
}

// A machine without a systemd user session must get a sentence it can act on,
// not a leaked "Failed to connect to bus".
func TestNoSystemdErrorIsActionable(t *testing.T) {
	msg := errNoSystemd.Error()
	if !strings.Contains(msg, "systemctl --user") {
		t.Errorf("error %q does not name what is missing", msg)
	}
	if !strings.Contains(msg, "caprock up") {
		t.Errorf("error %q does not say what to do instead", msg)
	}
}

// --- Windows: the Startup script ------------------------------------------

func TestStartupCmdShape(t *testing.T) {
	t.Setenv("APPDATA", "")
	p := testPlan(t, "windows")
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.HasPrefix(s, "@echo off") {
		t.Errorf("script does not start with @echo off:\n%s", s)
	}
	// `start ""` — the empty title is mandatory when the command is quoted, or
	// cmd opens an empty console named after the path instead of running it.
	if !strings.Contains(s, `start "" /b `) {
		t.Errorf(`script lacks 'start "" /b' — cmd would treat the quoted path as a window title:`+"\n%s", s)
	}
	if !strings.Contains(s, "CAPROCK_DATA_DIR") {
		t.Error("script does not set CAPROCK_DATA_DIR")
	}
	// cmd.exe is not reliably LF-tolerant in a Startup script.
	if !strings.Contains(s, "\r\n") {
		t.Error("script does not use CRLF line endings")
	}
	if strings.Contains(strings.ReplaceAll(s, "\r\n", ""), "\n") {
		t.Error("script mixes bare LF with CRLF")
	}
}

// `C:\Program Files\caprock\caprock.exe` is the ordinary case, not an edge one.
func TestStartupCmdQuotesPathsWithSpaces(t *testing.T) {
	t.Setenv("APPDATA", "")
	p := testPlan(t, "windows")
	p.Exe = `C:\Program Files\caprock\caprock.exe`
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"C:\Program Files\caprock\caprock.exe"`) {
		t.Errorf("script did not quote a path with a space:\n%s", body)
	}
}

// APPDATA is the documented location; the fallback keeps a stripped environment
// working rather than failing at install time.
func TestWindowsStartupDirPrefersAppData(t *testing.T) {
	t.Setenv("APPDATA", `C:\Users\u\AppData\Roaming`)
	got, err := windowsStartupDir(`C:\Users\u`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `C:\Users\u\AppData\Roaming`) {
		t.Errorf("startup dir = %q; want it under %%APPDATA%%", got)
	}
	t.Setenv("APPDATA", "")
	got, err = windowsStartupDir(`C:\Users\u`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, filepath.Join("AppData", "Roaming")) {
		t.Errorf("fallback startup dir = %q; want the AppData\\Roaming default", got)
	}
	if _, err := windowsStartupDir(""); err == nil {
		t.Error("no home and no APPDATA returned no error")
	}
}

// --- install / uninstall / idempotency ------------------------------------

// Running install twice must leave exactly one file with identical contents,
// and the second run must report "already installed" rather than an error.
func TestWriteIsIdempotent(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("APPDATA", "")
		p := testPlan(t, goos)

		present, _, _, err := p.Installed()
		if err != nil {
			t.Fatalf("%s: Installed on a clean home: %v", goos, err)
		}
		if present {
			t.Fatalf("%s: reported installed before anything was written", goos)
		}

		path1, err := p.Write()
		if err != nil {
			t.Fatalf("%s: first write: %v", goos, err)
		}
		first, err := os.ReadFile(path1)
		if err != nil {
			t.Fatal(err)
		}

		path2, err := p.Write()
		if err != nil {
			t.Fatalf("%s: second write: %v", goos, err)
		}
		if path1 != path2 {
			t.Errorf("%s: second write went to a different path (%q vs %q)", goos, path1, path2)
		}
		second, _ := os.ReadFile(path2)
		if string(first) != string(second) {
			t.Errorf("%s: writing the same plan twice produced different contents", goos)
		}

		// Exactly one file, not two.
		entries, err := os.ReadDir(filepath.Dir(path1))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 {
			names := make([]string, 0, len(entries))
			for _, e := range entries {
				names = append(names, e.Name())
			}
			t.Errorf("%s: %d files in %s (%v); install duplicated something", goos, len(entries), filepath.Dir(path1), names)
		}

		present, current, _, err := p.Installed()
		if err != nil {
			t.Fatal(err)
		}
		if !present || !current {
			t.Errorf("%s: after install, Installed = (present %v, current %v); want both true", goos, present, current)
		}
	}
}

// A definition written by an older binary (different path, different port) must
// read as "installed but stale", so install refreshes it instead of leaving a
// service that points at a binary that moved.
func TestInstalledDetectsAStaleDefinition(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	p := testPlan(t, "darwin")
	if _, err := p.Write(); err != nil {
		t.Fatal(err)
	}

	moved := p
	moved.Exe = filepath.Join(p.Home, "somewhere", "else", "caprock")
	present, current, _, err := moved.Installed()
	if err != nil {
		t.Fatal(err)
	}
	if !present {
		t.Fatal("a definition on disk was not reported as present")
	}
	if current {
		t.Error("a definition pointing at a different binary was reported as current — install would never refresh it")
	}

	// Rewriting brings it back in sync, which is what `service install` does.
	if _, err := moved.Write(); err != nil {
		t.Fatal(err)
	}
	if _, current, _, err = moved.Installed(); err != nil || !current {
		t.Errorf("after rewrite: current = %v, err = %v; want true, nil", current, err)
	}
}

// Line-ending normalization: without it, a Windows install would read as stale
// on every single status call.
func TestInstalledIgnoresLineEndingDrift(t *testing.T) {
	t.Setenv("APPDATA", "")
	p := testPlan(t, "windows")
	path, err := p.Write()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a checkout/editor that normalized CRLF to LF.
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(string(body), "\r\n", "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	_, current, _, err := p.Installed()
	if err != nil {
		t.Fatal(err)
	}
	if !current {
		t.Error("an LF-normalized copy of our own file was reported as stale")
	}
}

// Uninstall must be a clean no-op when nothing is installed — running it twice,
// or on a machine that never installed anything, is not an error.
func TestRemoveIsACleanNoOp(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Setenv("XDG_CONFIG_HOME", "")
		t.Setenv("APPDATA", "")
		p := testPlan(t, goos)

		removed, path, err := p.Remove()
		if err != nil {
			t.Fatalf("%s: Remove with nothing installed: %v", goos, err)
		}
		if removed {
			t.Errorf("%s: Remove reported a removal with nothing installed", goos)
		}
		if path == "" {
			t.Errorf("%s: Remove did not report where it looked", goos)
		}

		if _, err := p.Write(); err != nil {
			t.Fatal(err)
		}
		removed, path, err = p.Remove()
		if err != nil || !removed {
			t.Fatalf("%s: Remove after install = (%v, %v); want (true, nil)", goos, removed, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s: %s still exists after Remove", goos, path)
		}
		// The second uninstall is the one users actually run by accident.
		if removed, _, err := p.Remove(); err != nil || removed {
			t.Errorf("%s: second Remove = (%v, %v); want (false, nil)", goos, removed, err)
		}
	}
}

// Mechanism is what `service status` prints; a wrong or empty name there is a
// lie about what was installed.
func TestMechanismNamesThePlatformTool(t *testing.T) {
	for goos, want := range map[string]string{
		"darwin":  "launchd",
		"linux":   "systemd",
		"windows": "Startup",
		"plan9":   "unsupported",
	} {
		if got := (Plan{GOOS: goos}).Mechanism(); !strings.Contains(got, want) {
			t.Errorf("%s: Mechanism = %q; want it to mention %q", goos, got, want)
		}
	}
}

// The service log belongs in the data dir, beside caprock.log — never in a
// system location and never in ~/.claude.
func TestLogPathIsInTheDataDir(t *testing.T) {
	p := testPlan(t, runtime.GOOS)
	if got := p.LogPath(); filepath.Dir(got) != p.DataDir {
		t.Errorf("log path %q is not in the data dir %q", got, p.DataDir)
	}
}

// NewPlan must produce an absolute Exe even when handed a relative one, because
// a login agent's working directory is not the user's.
func TestNewPlanMakesTheExecutableAbsolute(t *testing.T) {
	p, err := NewPlan(filepath.Join(".", "caprock"), t.TempDir(), 4173, "")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p.Exe) {
		t.Errorf("Exe = %q; want an absolute path", p.Exe)
	}
	if p.Home == "" {
		t.Error("NewPlan did not resolve a home directory")
	}
}

// Background + LowPriorityIO reads like the obviously correct choice for a
// watcher, and it was in the first version of this file. It is wrong here: the
// daemon also serves the dashboard, and macOS throttles the I/O of a process it
// has been told is batch work. Measured on a 190k-event database, the same
// binary answering the same query took 1.2s under launchd with Background
// against 185ms from a terminal — a dashboard that felt broken, from one plist
// key. This pins the reason so the tempting value cannot come back quietly.
func TestPlistDoesNotThrottleTheDashboard(t *testing.T) {
	p := testPlan(t, "darwin")
	body, _, err := p.Render()
	if err != nil {
		t.Fatal(err)
	}
	got := string(body)
	for _, bad := range []string{"<string>Background</string>", "<key>LowPriorityIO</key>"} {
		if strings.Contains(got, bad) {
			t.Errorf("plist contains %s, which throttles the daemon's I/O and makes the dashboard take seconds to answer", bad)
		}
	}
	if !strings.Contains(got, "<string>Adaptive</string>") {
		t.Errorf("plist should declare ProcessType=Adaptive so a serving process is promoted out of the background band:\n%s", got)
	}
}

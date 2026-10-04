package nativeterm

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

var resumeArgv = []string{"claude", "--resume", "0b6f2c1e-1111-4a2b-9c3d-123456789abc"}

// A folder name with every character a shell treats specially that a real
// folder can carry: a space, both quotes, a dollar, a backtick, a semicolon.
const nastyCwd = `/Users/me/dev/my "app" $HOME 'x' ` + "`date`" + `; rm -rf ~`

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"claude":         "claude",
		"--resume":       "--resume",
		"/Users/me/dev":  "/Users/me/dev",
		"my dir":         "'my dir'",
		"it's":           `'it'\''s'`,
		"$HOME":          "'$HOME'",
		"":               "''",
		"a;b":            "'a;b'",
		"`date`":         "'`date`'",
		`back\slash`:     `'back\slash'`,
		"x\"y":           `'x"y'`,
		"ses_ABC123.def": "ses_ABC123.def",
	}
	for in, want := range cases {
		if got := ShellQuote(in); got != want {
			t.Errorf("ShellQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

// The quoting is proved by a real shell, not by reading it: the folder
// reached by the line must be the folder named, byte for byte, and nothing
// in the name may run.
func TestLineSurvivesARealShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell quoting")
	}
	base := t.TempDir()
	for _, name := range []string{"my dir", `quote " and ' both`, "$HOME and `date` and $(id)", "semi; colon & amp | pipe", "back\\slash", "ünïcödé пробел"} {
		dir := filepath.Join(base, name)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		line := Line(dir, []string{"pwd"})
		out, err := exec.Command("/bin/sh", "-c", line).CombinedOutput()
		if err != nil {
			t.Fatalf("%q: %v: %s", name, err, out)
		}
		got := strings.TrimSpace(string(out))
		real, _ := filepath.EvalSymlinks(dir)
		if got != dir && got != real {
			t.Errorf("%q: shell landed in %q", name, got)
		}
	}
}

func TestAppleScriptString(t *testing.T) {
	got := AppleScriptString(`cd '/a "b"\c' && claude`)
	want := `"cd '/a \"b\"\\c' && claude"`
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestYAMLString(t *testing.T) {
	got := YAMLString("a \"b\" \\ c\td")
	want := `"a \"b\" \\ c\x09d"`
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestBuildRefusesUnsafeInput(t *testing.T) {
	term := Terminal{ID: "terminal", Name: "Terminal", path: "/System/Applications/Utilities/Terminal.app"}
	for _, argv := range [][]string{
		{"claude", "--resume", "x'; rm -rf ~; '"},
		{"claude", "--resume", "$(id)"},
		{"claude", "--resume", "a b"},
		{},
	} {
		if _, err := Build("darwin", term, Request{Cwd: "/tmp", Argv: argv, Scratch: "/tmp", Name: "x"}); err == nil {
			t.Errorf("argv %q accepted", argv)
		}
	}
	if _, err := Build("darwin", term, Request{Cwd: "/tmp/a\nb", Argv: resumeArgv, Scratch: "/tmp", Name: "x"}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("newline in cwd: %v", err)
	}
	if _, err := Build("windows", Terminal{ID: "cmd", path: "cmd.exe"}, Request{Cwd: `C:\a"b`, Argv: resumeArgv}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("quote in a Windows cwd: %v", err)
	}
}

func TestBuildDarwin(t *testing.T) {
	req := Request{Cwd: nastyCwd, Argv: resumeArgv, Shell: "/bin/zsh", Scratch: "/data/open", Name: "caprock-1"}
	line := Line(nastyCwd, resumeArgv)

	t.Run("terminal", func(t *testing.T) {
		p, err := Build("darwin", Terminal{ID: "terminal", path: "/System/Applications/Utilities/Terminal.app"}, req)
		if err != nil {
			t.Fatal(err)
		}
		if p.Command != "/usr/bin/open" || !reflect.DeepEqual(p.Args, []string{"-a", "/System/Applications/Utilities/Terminal.app", filepath.Join("/data/open", "caprock-1.command")}) || !p.Wait {
			t.Fatalf("plan %+v", p)
		}
		want := "#!/bin/sh\nrm -f \"$0\"\ncd " + ShellQuote(nastyCwd) + " || exit 1\nclaude --resume " + resumeArgv[2] + "\nexec \"${SHELL:-/bin/zsh}\" -l\n"
		if p.File == nil || p.File.Content != want {
			t.Fatalf("script:\n%s\nwant:\n%s", p.File.Content, want)
		}
	})
	t.Run("iterm2", func(t *testing.T) {
		p, err := Build("darwin", Terminal{ID: "iterm2", path: "/Applications/iTerm.app"}, req)
		if err != nil {
			t.Fatal(err)
		}
		if p.Command != "/usr/bin/osascript" || len(p.Args) != 2 || p.Args[0] != "-e" {
			t.Fatalf("plan %+v", p)
		}
		if !strings.Contains(p.Args[1], "write text "+AppleScriptString(line)) || !strings.Contains(p.Args[1], `application id "com.googlecode.iterm2"`) {
			t.Fatalf("script:\n%s", p.Args[1])
		}
	})
	t.Run("ghostty", func(t *testing.T) {
		p, err := Build("darwin", Terminal{ID: "ghostty", path: "/Applications/Ghostty.app"}, req)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"-na", "/Applications/Ghostty.app", "--args", "--working-directory=" + nastyCwd, "-e", "/bin/zsh", "-l", "-i", "-c", line + "; exec /bin/zsh -l"}
		if p.Command != "/usr/bin/open" || !reflect.DeepEqual(p.Args, want) {
			t.Fatalf("args %q", p.Args)
		}
	})
	t.Run("wezterm", func(t *testing.T) {
		p, _ := Build("darwin", Terminal{ID: "wezterm", path: "/Applications/WezTerm.app"}, req)
		want := []string{"-na", "/Applications/WezTerm.app", "--args", "start", "--cwd", nastyCwd, "--", "/bin/zsh", "-l", "-i", "-c", line + "; exec /bin/zsh -l"}
		if !reflect.DeepEqual(p.Args, want) {
			t.Fatalf("args %q", p.Args)
		}
	})
	t.Run("kitty", func(t *testing.T) {
		p, _ := Build("darwin", Terminal{ID: "kitty", path: "/Applications/kitty.app"}, req)
		want := []string{"-na", "/Applications/kitty.app", "--args", "--directory", nastyCwd, "/bin/zsh", "-l", "-i", "-c", line + "; exec /bin/zsh -l"}
		if !reflect.DeepEqual(p.Args, want) {
			t.Fatalf("args %q", p.Args)
		}
	})
	t.Run("warp", func(t *testing.T) {
		r := req
		r.Scratch, r.Name = "/Users/me/.warp/launch_configurations", "caprock-open"
		p, err := Build("darwin", Terminal{ID: "warp", path: "/Applications/Warp.app"}, r)
		if err != nil {
			t.Fatal(err)
		}
		if p.File == nil || p.File.Path != filepath.Join("/Users/me/.warp/launch_configurations", "caprock-open.yaml") {
			t.Fatalf("file %+v", p.File)
		}
		if !strings.Contains(p.File.Content, "cwd: "+YAMLString(nastyCwd)) || !strings.Contains(p.File.Content, "exec: "+YAMLString(Line("", resumeArgv))) {
			t.Fatalf("yaml:\n%s", p.File.Content)
		}
		if len(p.Args) != 1 || !strings.HasPrefix(p.Args[0], "warp://launch/") {
			t.Fatalf("args %q", p.Args)
		}
	})
	t.Run("a shell that is not a path is not trusted", func(t *testing.T) {
		r := req
		r.Shell = "zsh; rm -rf ~"
		p, _ := Build("darwin", Terminal{ID: "kitty", path: "/Applications/kitty.app"}, r)
		if p.Args[5] != "/bin/zsh" {
			t.Fatalf("shell %q", p.Args[5])
		}
	})
}

func TestBuildLinux(t *testing.T) {
	cwd := "/home/me/my app"
	req := Request{Cwd: cwd, Argv: resumeArgv, Shell: "/usr/bin/fish"}
	run := []string{"/usr/bin/fish", "-l", "-i", "-c", Line(cwd, resumeArgv) + "; exec /usr/bin/fish -l"}
	cases := map[string][]string{
		"env":            append([]string{"-e"}, run...),
		"xterm":          append([]string{"-e"}, run...),
		"alacritty":      append([]string{"-e"}, run...),
		"konsole":        append([]string{"-e"}, run...),
		"ghostty":        append([]string{"-e"}, run...),
		"gnome-terminal": append([]string{"--"}, run...),
		"kitty":          run,
		"wezterm":        append([]string{"start", "--"}, run...),
	}
	for id, want := range cases {
		p, err := Build("linux", Terminal{ID: id, path: "/usr/bin/" + id}, req)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if p.Command != "/usr/bin/"+id || p.Dir != cwd || p.Wait || !reflect.DeepEqual(p.Args, want) {
			t.Errorf("%s: %+v", id, p)
		}
	}
	// No shell known: /bin/sh, never the daemon's guess.
	p, _ := Build("linux", Terminal{ID: "xterm", path: "/usr/bin/xterm"}, Request{Cwd: cwd, Argv: resumeArgv})
	if p.Args[1] != "/bin/sh" {
		t.Errorf("default shell %q", p.Args[1])
	}
}

func TestBuildWindows(t *testing.T) {
	cwd := `C:\Users\me\my app;v2`
	p, err := Build("windows", Terminal{ID: "wt", path: `C:\Users\me\AppData\Local\Microsoft\WindowsApps\wt.exe`}, Request{Cwd: cwd, Argv: resumeArgv})
	if err != nil {
		t.Fatal(err)
	}
	// Windows Terminal splits its command line on `;` unless escaped.
	want := []string{"-w", "new", "-d", `C:\Users\me\my app\;v2`, "cmd.exe", "/k", "claude", "--resume", resumeArgv[2]}
	if !reflect.DeepEqual(p.Args, want) || p.NewConsole {
		t.Fatalf("wt: %+v", p)
	}
	p, _ = Build("windows", Terminal{ID: "cmd", path: "cmd.exe"}, Request{Cwd: cwd, Argv: resumeArgv})
	if !reflect.DeepEqual(p.Args, []string{"/k", "claude", "--resume", resumeArgv[2]}) || p.Dir != cwd || !p.NewConsole {
		t.Fatalf("cmd: %+v", p)
	}
	p, _ = Build("windows", Terminal{ID: "powershell", path: "powershell.exe"}, Request{Cwd: cwd, Argv: resumeArgv})
	if !reflect.DeepEqual(p.Args, []string{"-NoExit", "-Command", "claude --resume " + resumeArgv[2]}) || p.Dir != cwd || !p.NewConsole {
		t.Fatalf("powershell: %+v", p)
	}
}

func fakeProbe(goos string, dirs, execs []string, env ...string) Probe {
	set := func(xs []string) map[string]bool {
		m := map[string]bool{}
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	d, x := set(dirs), set(execs)
	return Probe{GOOS: goos, Env: env, Home: "/Users/me", IsDir: func(p string) bool { return d[filepath.ToSlash(p)] }, IsExec: func(p string) bool { return x[filepath.ToSlash(p)] }}
}

func ids(ts []Terminal) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.ID)
	}
	return out
}

func TestDetect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("paths in the fakes are POSIX")
	}
	// macOS: what is installed, in preference order — Ghostty and iTerm2
	// before the Terminal that ships with the system, Warp last.
	mac := fakeProbe("darwin", []string{"/System/Applications/Utilities/Terminal.app", "/Applications/Warp.app", "/Applications/iTerm.app", "/Users/me/Applications/Ghostty.app"}, nil)
	if got := ids(Detect(mac)); !reflect.DeepEqual(got, []string{"ghostty", "iterm2", "terminal", "warp"}) {
		t.Fatalf("darwin: %v", got)
	}
	// Linux: looked up on the user's PATH, $TERMINAL first.
	lin := fakeProbe("linux", nil, []string{"/usr/bin/xterm", "/opt/bin/foot", "/usr/bin/konsole"}, "PATH=/opt/bin:/usr/bin", "TERMINAL=foot")
	got := Detect(lin)
	if !reflect.DeepEqual(ids(got), []string{"env", "konsole", "xterm"}) || got[0].Name != "foot" || got[0].path != "/opt/bin/foot" {
		t.Fatalf("linux: %+v", got)
	}
	// $TERMINAL naming something that is not there is not offered.
	lin = fakeProbe("linux", nil, []string{"/usr/bin/xterm"}, "PATH=/usr/bin", "TERMINAL=nope")
	if got := ids(Detect(lin)); !reflect.DeepEqual(got, []string{"xterm"}) {
		t.Fatalf("linux, bad $TERMINAL: %v", got)
	}
	// Windows: cmd is always there.
	win := fakeProbe("windows", nil, nil, `PATH=C:\Windows`)
	if got := ids(Detect(win)); !reflect.DeepEqual(got, []string{"cmd"}) {
		t.Fatalf("windows: %v", got)
	}
}

func TestPick(t *testing.T) {
	ts := []Terminal{{ID: "ghostty"}, {ID: "terminal"}}
	if p, _ := Pick(ts, "terminal"); p.ID != "terminal" {
		t.Errorf("preferred: %s", p.ID)
	}
	if p, _ := Pick(ts, "kitty"); p.ID != "ghostty" {
		t.Errorf("preferred not installed: %s", p.ID)
	}
	if _, ok := Pick(nil, ""); ok {
		t.Error("nothing installed")
	}
}

func TestEnvDropsNestingMarkers(t *testing.T) {
	got := Env([]string{"PATH=/bin", "CLAUDECODE=1", "TERM=xterm-256color", "CLAUDE_CODE_ENTRYPOINT=cli", "HOME=/h"})
	if !reflect.DeepEqual(got, []string{"PATH=/bin", "HOME=/h"}) {
		t.Fatalf("%v", got)
	}
}

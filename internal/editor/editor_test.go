package editor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/dspv/caprock/internal/nativeterm"
)

// fakeMac is a Mac with VS Code (and its CLI), Zed without its CLI, and
// GoLand from JetBrains Toolbox in ~/Applications.
func fakeMac() nativeterm.Probe {
	dirs := map[string]bool{
		"/Applications/Visual Studio Code.app": true,
		"/Applications/Zed.app":                true,
		"/Users/me/Applications/GoLand.app":    true,
	}
	execs := map[string]bool{
		"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code": true,
	}
	return nativeterm.Probe{
		GOOS: "darwin", Home: "/Users/me",
		IsDir:  func(p string) bool { return dirs[p] },
		IsExec: func(p string) bool { return execs[p] },
	}
}

func TestDetectMac(t *testing.T) {
	es := Detect(fakeMac())
	var ids []string
	for _, e := range es {
		ids = append(ids, e.ID)
	}
	if want := []string{"vscode", "zed", "goland"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("detected %v, want %v", ids, want)
	}
	if es[0].cli == "" || es[1].cli != "" {
		t.Fatalf("CLI: vscode %q (want set), zed %q (want empty)", es[0].cli, es[1].cli)
	}
}

func TestDetectLinuxUsesTheLoginPath(t *testing.T) {
	p := nativeterm.Probe{
		GOOS:  "linux",
		Env:   []string{"PATH=relative:/opt/zed/bin:/usr/bin"},
		IsDir: func(string) bool { return false },
		IsExec: func(p string) bool {
			return p == "/opt/zed/bin/zeditor" || p == "/usr/bin/code" || p == "relative/cursor"
		},
	}
	es := Detect(p)
	if len(es) != 2 || es[0].ID != "vscode" || es[1].ID != "zed" || es[1].app != "/opt/zed/bin/zeditor" {
		t.Fatalf("detected %+v", es)
	}
}

func TestNoEditorsOnWindows(t *testing.T) {
	p := fakeMac()
	p.GOOS = "windows"
	if es := Detect(p); len(es) != 0 {
		t.Fatalf("windows detected %+v", es)
	}
	if _, err := Build("windows", Editor{ID: "vscode"}, `C:\x`, 0); err == nil {
		t.Fatal("windows built a plan")
	}
}

func TestPick(t *testing.T) {
	es := Detect(fakeMac())
	if e, _ := Pick(es, "zed"); e.ID != "zed" {
		t.Fatalf("preferred zed, got %s", e.ID)
	}
	if e, _ := Pick(es, "cursor"); e.ID != "vscode" {
		t.Fatalf("preferred not installed: got %s, want the first", e.ID)
	}
	if _, ok := Pick(nil, ""); ok {
		t.Fatal("picked from nothing")
	}
}

// The argv each editor gets, read from its own documentation. Every path is
// one word, last or joined to its line: never a shell string.
func TestBuildArgv(t *testing.T) {
	es := Detect(fakeMac())
	vscode, zed, goland := es[0], es[1], es[2]
	const dir = `/Users/me/dev/my "app" $(id); rm -rf ~`
	const file = dir + "/main.go"
	cases := []struct {
		name string
		e    Editor
		path string
		line int
		want nativeterm.Plan
	}{
		{"folder", vscode, dir, 0, nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-a", "/Applications/Visual Studio Code.app", dir}, Wait: true}},
		{"vscode line", vscode, file, 42, nativeterm.Plan{Command: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", Args: []string{"-g", file + ":42"}, Wait: true}},
		{"zed without its cli opens the file", zed, file, 42, nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-a", "/Applications/Zed.app", file}, Wait: true}},
		{"jetbrains line", goland, file, 7, nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-na", "/Users/me/Applications/GoLand.app", "--args", "--line", "7", file}, Wait: true}},
		{"jetbrains folder", goland, dir, 0, nativeterm.Plan{Command: "/usr/bin/open", Args: []string{"-a", "/Users/me/Applications/GoLand.app", dir}, Wait: true}},
	}
	for _, c := range cases {
		got, err := Build("darwin", c.e, c.path, c.line)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
	zedCLI := Editor{ID: "zed", app: "/Applications/Zed.app", cli: "/Applications/Zed.app/Contents/MacOS/cli"}
	if got, _ := Build("darwin", zedCLI, file, 3); !reflect.DeepEqual(got.Args, []string{file + ":3"}) || got.Command != zedCLI.cli {
		t.Errorf("zed line: %+v", got)
	}
	linux, _ := Build("linux", Editor{ID: "idea", app: "/usr/bin/idea"}, file, 9)
	if linux.Command != "/usr/bin/idea" || !reflect.DeepEqual(linux.Args, []string{"--line", "9", file}) || linux.Wait {
		t.Errorf("linux idea: %+v", linux)
	}
	if _, err := Build("darwin", Editor{ID: "notepad"}, file, 0); err == nil {
		t.Error("an editor off the list got a plan")
	}
}

func TestCheckPath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ok := []struct {
		path string
		line int
	}{{dir, 0}, {file, 0}, {file, 12}}
	for _, c := range ok {
		if err := CheckPath(c.path, c.line, os.Stat); err != nil {
			t.Errorf("%s:%d refused: %v", c.path, c.line, err)
		}
	}
	bad := []struct {
		path string
		line int
	}{
		{"", 0},
		{"relative/path", 0},
		{"-n", 0},
		{dir + "/../" + filepath.Base(dir), 0},
		{dir + "/new\nline", 0},
		{filepath.Join(dir, "missing"), 0},
		{dir, 3},
		{file, -1},
		{file, MaxLine + 1},
	}
	for _, c := range bad {
		if err := CheckPath(c.path, c.line, os.Stat); !errors.Is(err, ErrBadPath) {
			t.Errorf("%q:%d: got %v, want ErrBadPath", c.path, c.line, err)
		}
	}
}

func TestOpenerRunsThePlanAndNeverAShell(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("no editors on this OS")
	}
	dir := t.TempDir()
	var ran []nativeterm.Plan
	o := &Opener{
		Env:       func() []string { return []string{"PATH=/nowhere"} },
		Preferred: func() string { return "" },
		Run: func(_ context.Context, p nativeterm.Plan, _ []string) error {
			ran = append(ran, p)
			return nil
		},
	}
	o.once.Do(func() {}) // detection skipped: the list is set by hand
	o.found = []Editor{{ID: "vscode", Name: "VS Code", app: "/Applications/Visual Studio Code.app"}, {ID: "zed", Name: "Zed", app: "/usr/bin/zed"}}
	e, err := o.Open(context.Background(), "", dir, 0)
	if err != nil || e.ID != "vscode" || len(ran) != 1 {
		t.Fatalf("open: %v %+v %+v", err, e, ran)
	}
	if last := ran[0].Args[len(ran[0].Args)-1]; last != dir {
		t.Fatalf("the folder is not the last word: %v", ran[0].Args)
	}
	if _, err := o.Open(context.Background(), "cursor", dir, 0); !errors.Is(err, ErrNoEditor) {
		t.Fatalf("named and missing: %v", err)
	}
	if _, err := o.Open(context.Background(), "", "relative", 0); !errors.Is(err, ErrBadPath) {
		t.Fatalf("relative path: %v", err)
	}
	if len(ran) != 1 {
		t.Fatalf("a refused open ran something: %+v", ran)
	}
	ids, pref := o.List()
	if len(ids) != 2 || pref != "vscode" {
		t.Fatalf("list: %+v %q", ids, pref)
	}
}

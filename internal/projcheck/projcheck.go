// Package projcheck finds the commands a repository already uses to check
// itself: its Makefile targets, its package.json scripts, and the stock
// commands of the toolchains it declares (go.mod, Cargo.toml, pyproject.toml).
//
// It exists for the Tasks screen's templates. A task is done only when its
// done_criteria exit 0, so a template that prefills `go test ./...` into a
// JavaScript repository hands the user a task that can never go green. The
// screen asks this package instead of guessing, and offers nothing it did not
// find — an empty list is an honest answer, a wrong command is not.
//
// Detection reads files and never runs anything: no `make -n`, no package
// manager, no network. A target or script is reported only when the file
// names it.
package projcheck

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Kind is what a check proves. The templates ask for kinds, not commands.
type Kind string

// The kinds a check can prove.
const (
	KindAll       Kind = "all" // the project's own umbrella check (`make check`)
	KindTest      Kind = "test"
	KindLint      Kind = "lint"
	KindTypecheck Kind = "typecheck"
	KindBuild     Kind = "build"
)

// Check is one command the repository already has.
type Check struct {
	Command string `json:"command"`
	Kind    Kind   `json:"kind"`
	// Source is the file that names it: "Makefile", "package.json", "go.mod".
	Source string `json:"source"`
}

// maxFile caps one manifest read. A Makefile or package.json past this is
// not one a person wrote by hand, and reading it is not worth the time.
const maxFile = 1 << 20

// Detect returns the checks dir declares, project entry points first: a
// Makefile target is how the project itself says "run the tests", so it
// outranks the toolchain's stock command for the same kind. A missing or
// unreadable dir is an empty list, never an error.
func Detect(dir string) []Check {
	out := []Check{}
	if dir == "" {
		return out
	}
	seen := map[string]bool{}
	for _, group := range [][]Check{makeChecks(dir), packageChecks(dir), toolchainChecks(dir)} {
		for _, c := range group {
			if !seen[c.Command] {
				seen[c.Command] = true
				out = append(out, c)
			}
		}
	}
	return out
}

func read(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil || len(b) > maxFile {
		return nil, false
	}
	return b, true
}

func exists(dir, name string) bool {
	fi, err := os.Stat(filepath.Join(dir, name))
	return err == nil && !fi.IsDir()
}

// makeTargets maps a target name to what it proves. Only the conventional
// names: a target called `ci` or `verify` could mean anything.
var makeTargets = []struct {
	name string
	kind Kind
}{
	{"check", KindAll},
	{"test", KindTest},
	{"lint", KindLint},
	{"vet", KindLint},
	{"typecheck", KindTypecheck},
	{"build", KindBuild},
}

// targetRe matches a rule line — `name:` or `a b:` — and not an assignment
// (`NAME := x`, `NAME ::= x`). Recipe lines start with a tab and are skipped
// before this runs.
var targetRe = regexp.MustCompile(`^([A-Za-z0-9_.\- ]+?)\s*::?([^=]|$)`)

func makeChecks(dir string) []Check {
	var src string
	var body []byte
	for _, name := range []string{"GNUmakefile", "Makefile", "makefile"} {
		if b, ok := read(filepath.Join(dir, name)); ok {
			src, body = name, b
			break
		}
	}
	if body == nil {
		return nil
	}
	targets := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 0, 64<<10), maxFile)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || line[0] == '\t' || line[0] == '#' || line[0] == '.' {
			continue
		}
		m := targetRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		for _, t := range strings.Fields(m[1]) {
			targets[t] = true
		}
	}
	var out []Check
	for _, t := range makeTargets {
		if targets[t.name] {
			out = append(out, Check{Command: "make " + t.name, Kind: t.kind, Source: src})
		}
	}
	return out
}

// npmPlaceholder is in the test script `npm init` writes. That script always
// fails, so a repository carrying it has no tests, whatever package.json says.
const npmPlaceholder = "no test specified"

var packageScripts = []struct {
	names []string
	kind  Kind
}{
	{[]string{"test"}, KindTest},
	{[]string{"lint"}, KindLint},
	{[]string{"typecheck", "type-check", "tsc"}, KindTypecheck},
	{[]string{"build"}, KindBuild},
}

func packageChecks(dir string) []Check {
	b, ok := read(filepath.Join(dir, "package.json"))
	if !ok {
		return nil
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(b, &pkg) != nil || len(pkg.Scripts) == 0 {
		return nil
	}
	pm := "npm"
	switch {
	case exists(dir, "pnpm-lock.yaml"):
		pm = "pnpm"
	case exists(dir, "yarn.lock"):
		pm = "yarn"
	case exists(dir, "bun.lockb"), exists(dir, "bun.lock"):
		pm = "bun"
	}
	var out []Check
	for _, s := range packageScripts {
		for _, name := range s.names {
			script := strings.TrimSpace(pkg.Scripts[name])
			if script == "" || (name == "test" && strings.Contains(script, npmPlaceholder)) {
				continue
			}
			out = append(out, Check{Command: runScript(pm, name), Kind: s.kind, Source: "package.json"})
			break
		}
	}
	return out
}

// runScript is how each package manager runs a package.json script. `bun
// test` is bun's own test runner rather than the script, so bun always says
// `run`; npm needs `run` for everything but test.
func runScript(pm, name string) string {
	switch {
	case pm == "bun":
		return "bun run " + name
	case pm == "npm" && name == "test":
		return "npm test"
	case pm == "npm":
		return "npm run " + name
	case pm == "yarn":
		return "yarn " + name
	default:
		return pm + " run " + name
	}
}

func toolchainChecks(dir string) []Check {
	var out []Check
	if exists(dir, "go.mod") {
		out = append(out,
			Check{Command: "go test ./...", Kind: KindTest, Source: "go.mod"},
			Check{Command: "go vet ./...", Kind: KindLint, Source: "go.mod"},
			Check{Command: "go build ./...", Kind: KindBuild, Source: "go.mod"},
		)
	}
	if exists(dir, "Cargo.toml") {
		out = append(out,
			Check{Command: "cargo test", Kind: KindTest, Source: "Cargo.toml"},
			Check{Command: "cargo check", Kind: KindTypecheck, Source: "Cargo.toml"},
		)
	}
	// Python has no stock test command, so pytest is offered only when the
	// project names it: in its config, or with a conftest.py.
	py, _ := read(filepath.Join(dir, "pyproject.toml"))
	switch {
	case exists(dir, "pytest.ini"):
		out = append(out, Check{Command: "pytest", Kind: KindTest, Source: "pytest.ini"})
	case exists(dir, "conftest.py"):
		out = append(out, Check{Command: "pytest", Kind: KindTest, Source: "conftest.py"})
	case bytes.Contains(py, []byte("pytest")):
		out = append(out, Check{Command: "pytest", Kind: KindTest, Source: "pyproject.toml"})
	}
	switch {
	case exists(dir, "ruff.toml"):
		out = append(out, Check{Command: "ruff check .", Kind: KindLint, Source: "ruff.toml"})
	case bytes.Contains(py, []byte("[tool.ruff")):
		out = append(out, Check{Command: "ruff check .", Kind: KindLint, Source: "pyproject.toml"})
	}
	switch {
	case exists(dir, "mypy.ini"):
		out = append(out, Check{Command: "mypy .", Kind: KindTypecheck, Source: "mypy.ini"})
	case bytes.Contains(py, []byte("[tool.mypy")):
		out = append(out, Check{Command: "mypy .", Kind: KindTypecheck, Source: "pyproject.toml"})
	}
	return out
}

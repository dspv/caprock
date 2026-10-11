package projcheck

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func files(t *testing.T, m map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range m {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func commands(cs []Check) []string {
	out := []string{}
	for _, c := range cs {
		out = append(out, c.Command)
	}
	return out
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  []string
	}{
		{"nothing", map[string]string{"README.md": "hi"}, []string{}},
		{
			// The project's own targets first; the toolchain's stock commands
			// after, and only for what the Makefile does not already say.
			"makefile and go",
			map[string]string{
				"Makefile": "BIN := x\n.PHONY: test lint\ncheck: lint test\n\tgo vet ./...\ntest:\n\tgo test ./...\nlint vet: \n\t@true\nrelease::\n\techo\n",
				"go.mod":   "module x\n",
			},
			[]string{"make check", "make test", "make lint", "make vet", "go test ./...", "go vet ./...", "go build ./..."},
		},
		{
			// `npm init` writes a test script that always fails: no tests.
			"npm placeholder test",
			map[string]string{"package.json": `{"scripts":{"test":"echo \"Error: no test specified\" && exit 1","lint":"eslint ."}}`},
			[]string{"npm run lint"},
		},
		{
			"pnpm with typecheck",
			map[string]string{"package.json": `{"scripts":{"test":"vitest","type-check":"tsc --noEmit","build":"vite build"}}`, "pnpm-lock.yaml": ""},
			[]string{"pnpm run test", "pnpm run type-check", "pnpm run build"},
		},
		{"yarn", map[string]string{"package.json": `{"scripts":{"test":"jest"}}`, "yarn.lock": ""}, []string{"yarn test"}},
		{"bun runs the script, not its own runner", map[string]string{"package.json": `{"scripts":{"test":"vitest"}}`, "bun.lock": ""}, []string{"bun run test"}},
		{"broken package.json", map[string]string{"package.json": `{"scripts":`}, []string{}},
		{"cargo", map[string]string{"Cargo.toml": "[package]\n"}, []string{"cargo test", "cargo check"}},
		{
			"python names its tools",
			map[string]string{"pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n"},
			[]string{"pytest", "ruff check .", "mypy ."},
		},
		// A pyproject that mentions none of them gets nothing: guessing pytest
		// would hand the user a task that can never pass.
		{"bare python", map[string]string{"pyproject.toml": "[project]\nname='x'\n"}, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := commands(Detect(files(t, c.files)))
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestDetectKindsAndSources(t *testing.T) {
	dir := files(t, map[string]string{"Makefile": "check:\n\ttrue\n", "go.mod": "module x\n"})
	got := Detect(dir)
	if got[0] != (Check{Command: "make check", Kind: KindAll, Source: "Makefile"}) {
		t.Fatalf("first check = %+v", got[0])
	}
	if got[1] != (Check{Command: "go test ./...", Kind: KindTest, Source: "go.mod"}) {
		t.Fatalf("second check = %+v", got[1])
	}
}

func TestDetectMissingDir(t *testing.T) {
	if got := Detect(filepath.Join(t.TempDir(), "absent")); got == nil || len(got) != 0 {
		t.Fatalf("missing dir: %#v, want an empty non-nil list", got)
	}
	if got := Detect(""); got == nil || len(got) != 0 {
		t.Fatalf("empty dir: %#v", got)
	}
}

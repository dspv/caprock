package hidewin

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// allowed are the files that may call exec.Command directly, and why.
var allowed = map[string]string{
	"internal/hidewin/hidewin.go":      "the wrappers themselves",
	"internal/nativeterm/run.go":       "opens a terminal the user asked to see; sets its own console flags",
	"internal/ptyhost/client.go":       "the holder sets a hidden console of its own (detachAttempts)",
	"internal/wtsetup/proc_windows.go": "runs inside the session's own console (ConPTY); shellCommand hides itself",
	"internal/keepawake/child_unix.go": "macOS and Linux only",
	"internal/secret/secret.go":        "macOS keychain only",
	"internal/service/darwin.go":       "launchctl, macOS only",
	"internal/service/linux.go":        "systemctl, Linux only",
	"internal/wtsetup/proc_unix.go":    "macOS and Linux only",
	"cmd/caprock/main.go":              "starts the daemon itself; setDetached hides its console",
}

// TestEveryCommandIsHidden fails when daemon code starts a process with
// exec.Command or exec.CommandContext instead of this package: on Windows that
// child flashes a console window and steals the keyboard focus.
func TestEveryCommandIsHidden(t *testing.T) {
	root := filepath.Join("..", "..")
	var bad []string
	for _, top := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, top), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			rel = filepath.ToSlash(rel)
			if strings.HasPrefix(rel, "internal/api/dist") || allowed[rel] != "" {
				return nil
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				return err
			}
			ast.Inspect(f, func(n ast.Node) bool {
				sel, ok := n.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if x, ok := sel.X.(*ast.Ident); ok && x.Name == "exec" && (sel.Sel.Name == "Command" || sel.Sel.Name == "CommandContext") {
					bad = append(bad, rel)
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(bad) > 0 {
		t.Errorf("start these through hidewin.Command/CommandContext, or a Windows user gets a console window flashing: %v", bad)
	}
}

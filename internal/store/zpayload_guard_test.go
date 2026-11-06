package store

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// plainPayloadReads are the functions allowed to read events.payload bare,
// each with why that is right. Everything else that names the column in SQL
// reads it through ZPayload, ZPayloadE or ZPayloadOf (ADR-093).
//
// A bare read of a compressed row never fails: the stored form is a JSONB
// string, so json_extract gives NULL. A function belongs here only when the
// rows it reads are never compressed — not a tool.pre or tool.post — or when
// it copies or measures the stored value without reading what is in it.
var plainPayloadReads = map[string]string{
	// Prose and lifecycle rows: never compressed.
	"internal/codex/ingest.go:(*Ingester).syncText":                  "turn.assistant text",
	"internal/codex/ingest.go:(*Ingester).applyText":                 "turn.assistant text, guarded by json_valid",
	"internal/ingest/repair.go:RepairAssistantText":                  "turn.assistant text",
	"internal/ingest/repair.go:RepairEmptyAssistantText":             "turn.assistant text",
	"internal/ingest/repair.go:updateText":                           "a turn.assistant row by id",
	"internal/opencode/ingest.go:(*Ingester).refreshText":            "turn.assistant text, guarded by json_valid",
	"internal/rollup/compaction_stats.go:(*Recorder).compactionCost": "context.compacted",
	"internal/store/brain.go:BrainNoteSource":                        "turn.assistant text",
	"internal/store/brain_gaps.go:BrainOldWindow":                    "turn.user and turn.assistant",
	"internal/store/brain_runs.go:BrainPassagesBetween":              "turn.user and turn.assistant",
	"internal/store/compaction_stats.go:ReinitCompactionStat":        "context.compacted and turn.assistant",
	"internal/store/compaction_stats.go:mainCallWhere":               "turn.assistant",
	"internal/store/compaction_stats.go:SetCompactionSummary":        "turn.assistant",
	"internal/store/compactions.go:compactionQuery":                  "context.* and turn.assistant",
	"internal/store/glance.go:agentSplit":                            "turn.assistant",
	"internal/store/hermes.go:HermesSpend":                           "turn.assistant",
	"internal/store/projects.go:ProjectActivityByDir":                "agent.stop only, guarded by its kind",
	"internal/store/queries.go:MergeAssistantText":                   "turn.assistant",
	"internal/store/queries.go:FirstPrompts":                         "turn.user",
	"internal/store/queries.go:sessionQueryFilter":                   "turn.user",
	"internal/store/queries.go:assistantTextWhere":                   "turn.assistant",
	"internal/store/queries.go:MainThreadWhere":                      "prose; tool rows use mainThreadToolWhere",
	"internal/store/queries.go:SessionNotes":                         "turn.assistant",
	"internal/store/queries.go:SearchNotes":                          "turn.assistant and turn.user",
	"internal/store/queries.go:WhereWeLeftOff":                       "turn.assistant",
	"internal/store/queries.go:HandoffCoverage":                      "turn.assistant",
	"internal/store/remove.go:sessionDayTurns":                       "turn.assistant",
	"internal/store/turns.go:PromptTexts":                            "turn.user rows by id",
	// Only while tool_fields is filling, which compression waits for; the
	// expressions must stay exactly idx_events_agent_task's to use it.
	"internal/store/subagents.go:agentTaskID": "the pending tool_fields fill",
	// The stored value itself, not what it holds.
	"internal/store/compact.go:(*Store).CompactPayloadsStep":     "base64 compaction: text rows only, and finished before compression starts",
	"internal/store/move.go:(*Store).MoveEventsStep":             "copies the stored value as it is",
	"internal/store/zpayload.go:(*Store).CompressPayloadsStep":   "the job itself",
	"internal/store/zpayload.go:(*Store).DecompressPayloadsStep": "the job itself",
	"internal/store/zpayload.go:(*Store).applyZstd":              "the job itself",
	"internal/store/zpayload_stats.go:sampleCompression":         "the job's own estimate, plain rows only",
	"internal/store/storage.go:eventBreakdown":                   "the stored size and the frame header",
}

// payloadRef is the column as SQL names it, with or without a table alias.
var payloadRef = regexp.MustCompile(`\b(?:[a-z_][a-z0-9_]*\.)?payload\b`)

// looksLikeSQL tells a statement or a fragment of one from a JSON key or a
// log message that happens to say "payload".
var looksLikeSQL = regexp.MustCompile(`(?i)\b(select|update|insert|where|from|json_\w+|instr|like)\b|->|^[a-z_]+\.payload$`)

// allowedRef reports whether one occurrence of the column, at i in s, neither
// reads what the payload holds nor needs to: written, measured or typed.
func allowedRef(s string, i int) bool {
	before := strings.TrimRight(s[:i], " \t\n")
	after := strings.TrimLeft(s[i:], "abcdefghijklmnopqrstuvwxyz_.")
	switch {
	case strings.HasSuffix(before, "typeof("), strings.HasSuffix(before, "octet_length("), strings.HasSuffix(before, "zjson("):
		return true
	case strings.HasSuffix(strings.ToUpper(before), "SET") && strings.HasPrefix(strings.TrimLeft(after, " "), "="):
		return true // SET payload = …: a write
	}
	// INSERT INTO t(…, payload, …): a column list, before VALUES or SELECT.
	up := strings.ToUpper(s[:i])
	if ins := strings.LastIndex(up, "INSERT INTO"); ins >= 0 &&
		!strings.Contains(up[ins:], "VALUES") && !strings.Contains(up[ins:], "SELECT") {
		return true
	}
	return false
}

// TestEveryPayloadReadKnowsCompression fails on a statement that reads
// events.payload bare outside plainPayloadReads. A tool row read that way
// would silently lose its fields once compressed, and a json_set over one
// would replace the row with a string.
func TestEveryPayloadReadKnowsCompression(t *testing.T) {
	root := repoRoot(t)
	fset := token.NewFileSet()
	var bad []string
	used := map[string]bool{}
	for _, top := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, top), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "dist" || d.Name() == "testdata" || strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
				return nil
			}
			rel, _ := filepath.Rel(root, p)
			rel = filepath.ToSlash(rel)
			f, err := parser.ParseFile(fset, p, nil, 0)
			if err != nil {
				return err
			}
			for _, r := range barePayloadReads(fset, f) {
				key := rel + ":" + r.fn
				if _, ok := plainPayloadReads[key]; ok {
					used[key] = true
					continue
				}
				bad = append(bad, r.pos+" in "+r.fn)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(bad)
	for _, b := range bad {
		t.Errorf("reads events.payload bare: %s — read it through store.ZPayload, or add the function to plainPayloadReads with why its rows are never compressed", b)
	}
	for k := range plainPayloadReads {
		if !used[k] {
			t.Errorf("plainPayloadReads names %s, which no longer reads the payload bare: remove it", k)
		}
	}
}

type bareRead struct{ fn, pos string }

// barePayloadReads lists each string literal in f that names events.payload
// in SQL in a way that reads what it holds, with its declaration's name.
func barePayloadReads(fset *token.FileSet, f *ast.File) []bareRead {
	var out []bareRead
	for _, decl := range f.Decls {
		fn := declName(decl)
		ast.Inspect(decl, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			s, err := strconv.Unquote(lit.Value)
			if err != nil || !looksLikeSQL.MatchString(s) {
				return true
			}
			for _, m := range payloadRef.FindAllStringIndex(s, -1) {
				// A JSON path ('$.payload', '$.x.payload') is not the column.
				if m[0] > 0 && strings.ContainsRune("$.'", rune(s[m[0]-1])) {
					continue
				}
				if !allowedRef(s, m[0]) {
					out = append(out, bareRead{fn: fn, pos: fset.Position(lit.Pos()).String()})
					break
				}
			}
			return true
		})
	}
	return out
}

// TestBarePayloadReadsFindsThem holds the checker itself to account: each
// way a statement can read the column is caught, and each way it can name it
// without reading it is not.
func TestBarePayloadReadsFindsThem(t *testing.T) {
	src := `package x
func a() { q("SELECT json_extract(payload, '$.x') FROM events") }
func b() { q(` + "`" + `UPDATE events SET payload = json_set(payload, '$.a', 1) WHERE id = ?` + "`" + `) }
func c() { q("SELECT id, e.payload FROM events e") }
func d() { q("SELECT 1 FROM events WHERE payload LIKE ?") }
var e = column{"payload", "e.payload"}
func f() { q("SELECT typeof(payload), octet_length(payload) FROM events") }
func g() { q("UPDATE events SET payload = ? WHERE id = ?") }
func h() { q("INSERT INTO events(ts, payload) VALUES(?, ?)") }
func i() { q("SELECT " + ZPayload + " FROM events WHERE json_extract(x, '$.payload') = 1") }
func j() { log("payload too large") }
`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "x.go", src, 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range barePayloadReads(fset, f) {
		got = append(got, r.fn)
	}
	if want := []string{"a", "b", "c", "d", "e"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("flagged %v, want %v", got, want)
	}
}

// declName is a declaration's name as plainPayloadReads spells it.
func declName(d ast.Decl) string {
	switch d := d.(type) {
	case *ast.FuncDecl:
		if d.Recv == nil || len(d.Recv.List) == 0 {
			return d.Name.Name
		}
		switch r := d.Recv.List[0].Type.(type) {
		case *ast.StarExpr:
			if id, ok := r.X.(*ast.Ident); ok {
				return "(*" + id.Name + ")." + d.Name.Name
			}
		case *ast.Ident:
			return r.Name + "." + d.Name.Name
		}
		return d.Name.Name
	case *ast.GenDecl:
		for _, s := range d.Specs {
			if v, ok := s.(*ast.ValueSpec); ok && len(v.Names) > 0 {
				return v.Names[0].Name
			}
		}
	}
	return "?"
}

// repoRoot is the directory holding go.mod, above this package.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		up := filepath.Dir(dir)
		if up == dir {
			t.Fatal("no go.mod above the test")
		}
		dir = up
	}
}

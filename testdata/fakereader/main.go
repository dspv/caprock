// Command fakereader stands in for `codex`, `cursor-agent` and `gemini` in
// 2nd Brain's reader tests (internal/brain, ADR-103). It never contacts
// anything. It tells which CLI it plays from its arguments — `exec` first is
// codex, `--output-format` is cursor-agent, `-o json` is gemini — and answers
// in that CLI's documented headless output with one memory, wrapped in a
// sentence the way a model may wrap it.
//
// FAKEREADER_LOG, when set, is a file it writes its arguments (one per
// line), a line `--stdin--`, and what it read from stdin to.
// FAKEREADER_FAIL=auth makes it fail as a signed-out CLI does.
// FAKEREADER_OLD=1 makes the cursor-agent refuse --mode as one from before
// it does.
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const memory = `{"memories":[{"kind":"decision","title":"Keep SQLite in WAL mode","summary":"Postgres is too much for one machine.","topics":["sqlite"],"keywords":["sqlite","wal"],"passage":2}]}`

func main() {
	args := os.Args[1:]
	stdin, _ := io.ReadAll(os.Stdin)
	if p := os.Getenv("FAKEREADER_LOG"); p != "" {
		_ = os.WriteFile(p, []byte(strings.Join(args, "\n")+"\n--stdin--\n"+string(stdin)), 0o600)
	}
	fail := os.Getenv("FAKEREADER_FAIL") == "auth"
	answer := "Here is the answer: " + memory
	switch {
	case len(args) > 0 && args[0] == "exec":
		codex(args, answer, fail)
	case has(args, "--output-format"):
		cursor(args, answer, fail)
	default:
		gemini(answer, fail)
	}
}

func has(args []string, a string) bool {
	for _, x := range args {
		if x == a {
			return true
		}
	}
	return false
}

func value(args []string, flag string) string {
	for i, x := range args {
		if x == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func codex(args []string, answer string, fail bool) {
	fmt.Println(`{"type":"thread.started","thread_id":"t1"}`)
	fmt.Println(`{"type":"turn.started"}`)
	if fail {
		fmt.Println(`{"type":"error","message":"Not logged in. Run codex login."}`)
		fmt.Println(`{"type":"turn.failed","error":{"message":"Not logged in. Run codex login."}}`)
		os.Exit(1)
	}
	if out := value(args, "-o"); out != "" {
		_ = os.WriteFile(out, []byte(answer), 0o600)
	}
	fmt.Printf(`{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":%q}}`+"\n", answer)
	fmt.Println(`{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}`)
}

func cursor(args []string, answer string, fail bool) {
	if os.Getenv("FAKEREADER_OLD") == "1" && has(args, "--mode") {
		fmt.Fprintln(os.Stderr, "error: unknown option '--mode'")
		os.Exit(1)
	}
	if fail {
		fmt.Fprintln(os.Stderr, "Authentication required to use Cursor Agent. Please run 'cursor-agent login' to authenticate.")
		os.Exit(1)
	}
	fmt.Printf(`{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"duration_api_ms":1234,"result":%q,"session_id":"s1"}`+"\n", answer)
}

func gemini(answer string, fail bool) {
	if fail {
		fmt.Println(`{"error":{"type":"Error","message":"Please set an Auth method in your settings.json"}}`)
		os.Exit(1)
	}
	fmt.Printf(`{"session_id":"g1","response":%q,"stats":{"models":{"gemini-2.5-flash":{"api":{"totalRequests":1,"totalErrors":0,"totalLatencyMs":900},"tokens":{"input":3000,"prompt":4000,"candidates":150,"total":4200,"cached":1000,"thoughts":50,"tool":0}}}}}`+"\n", answer)
}

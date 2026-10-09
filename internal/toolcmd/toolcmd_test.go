package toolcmd

import "testing"

// The scripts are the shapes Codex's `exec` sends, copied from real rollouts;
// the cases are ui/src/lib/chat.test.ts's, so the chat and the daemon read
// every one the same way.
func TestScriptReadsTheCommandOut(t *testing.T) {
	for _, c := range []struct{ script, want string }{
		{"const r = await tools.exec_command({cmd:\"git status --short; git log -1 --oneline\",\"workdir\":\"/p\",\"max_output_tokens\":500});text(r.output)\n", "git status --short; git log -1 --oneline"},
		{`const r = await tools.exec_command({"cmd":"echo \"hi\"\nls","yield_time_ms":1000});`, `echo "hi"`},
		{`await tools.exec_command({cmd:'rg -n \'x\' src'})`, "rg -n 'x' src"},
		{"await tools.exec_command({cmd:`ls`})", "ls"},
		{`await tools.exec_command({cmd:"echo été"})`, "echo été"},
		{"const patch = \"*** Begin Patch\\n*** Update File: ui/src/lib/chat.ts\\n@@\";\ntext(await tools.apply_patch(patch));", "apply_patch ui/src/lib/chat.ts"},
		{`const r=await tools.write_stdin({session_id:51470,chars:""});text(r.output)`, "write_stdin"},
		{`const r = await tools.web__run({search_query:[{q:"site:caprock.dev"}]})`, "web__run"},
		// A command passed by a variable is not guessed at: the call is named.
		{`const r = await Promise.all(cmds.map(cmd=>tools.exec_command({cmd})))`, "exec_command"},
	} {
		got, ok := Script(c.script)
		if !ok || got != c.want {
			t.Errorf("Script(%q) = %q, %v; want %q", c.script, got, ok, c.want)
		}
	}
	if got, ok := Script("echo plain"); ok {
		t.Errorf("a script that calls no tool read as %q", got)
	}
}

func TestCommandIsTheLineACallRan(t *testing.T) {
	for _, c := range []struct{ tool, command, want string }{
		{"exec", `const r = await tools.exec_command({cmd:"go test ./..."});`, "go test ./..."},
		{"exec", "echo plain", "echo plain"},
		// Stored before the daemon unwrapped a function call's arguments.
		{"shell", `{"command":["bash","-lc","ls -la"],"workdir":"/p"}`, "ls -la"},
		{"shell", `{"command":["git","status"]}`, "git status"},
		{"shell", "go vet ./...", "go vet ./..."},
		// Claude Code's Bash is never touched, braces and all.
		{"Bash", `{ echo a; } | tools.exec_command(x)`, `{ echo a; } | tools.exec_command(x)`},
	} {
		if got := Command(c.tool, c.command); got != c.want {
			t.Errorf("Command(%q, %q) = %q; want %q", c.tool, c.command, got, c.want)
		}
	}
}

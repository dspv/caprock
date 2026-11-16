package agents

// cursorLaunch starts Cursor's CLI, `cursor-agent`, interactively, built from
// its own `cursor-agent --help` (2025.09.12-4852336, read 2026-11-16) and
// cursor.com/docs/cli/reference/parameters (read the same day) — the flags
// both name, so an older and a newer CLI take the same command line:
//
//   - `[prompt...]`: "Initial prompt for the agent" — the first message.
//   - `--model <model>`: Cursor's model id (`gpt-5`, `sonnet-4`, …), the ones
//     the account offers; the list is the account's, fetched by
//     `cursor-agent models` over the network, so Caprock offers the models
//     this machine's Cursor already used and takes a typed one.
//   - `--resume <chatId>` continues a chat by its id; there is no fork.
//   - `-f, --force`: "Force allow commands unless explicitly denied" —
//     Caprock's bypass. Plan (`--mode plan`) exists only in newer CLIs and an
//     older one refuses the unknown flag, so plan and accept-edits start
//     Cursor as it is.
//
// The session's Caprock id goes into the environment as
// CAPROCK_CURSOR_SESSION. Cursor runs hooks as its own children, so when the
// user has Caprock's Cursor hooks on, every hook names the session exactly;
// without them the session is a terminal Caprock watches, with no turns
// (.ai/25-cursor.md § Launch).
func cursorLaunch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	if in.Resume != "" {
		native := in.NativeResume
		if native == "" {
			native = in.Resume
		}
		args, err := resumeArgs(AgentCursor, native, in.Fork)
		if err != nil {
			return launch{}, err
		}
		l.args = args
		l.sessionID = in.Resume
	}
	if in.Model != "" {
		l.args = append(l.args, "--model", in.Model)
	}
	if in.Mode == "bypassPermissions" {
		l.args = append(l.args, "--force")
	}
	l.args = append(l.args, in.Extra...)
	l.env = append(l.env, "CAPROCK_CURSOR_SESSION="+l.sessionID)
	if p := promptArg(in); p != "" {
		l.args = append(l.args, p)
	}
	return l, nil
}

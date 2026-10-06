package agents

// PermissionModes are the values Claude Code's --permission-mode accepts
// (`claude --help`), which is also the vocabulary every spawn request uses:
// the other agents' builders translate them (argv.go).
var PermissionModes = []string{"acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"}

// IsPermissionMode reports whether m is one of PermissionModes.
func IsPermissionMode(m string) bool {
	for _, v := range PermissionModes {
		if v == m {
			return true
		}
	}
	return false
}

// CarriedMode is the mode a continued session is started in, given the mode
// its hooks last reported, or "" to leave the flag off.
//
// Claude Code reports its ordinary mode as "default", which --permission-mode
// does not accept; leaving the flag off is what starts that mode. Any word
// this build does not know is dropped too rather than handed to a CLI that
// would refuse to start over it.
func CarriedMode(reported string) string {
	if IsPermissionMode(reported) {
		return reported
	}
	return ""
}

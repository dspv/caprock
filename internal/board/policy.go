package board

import (
	"regexp"
	"strings"
)

// DestructivePatterns are commands a task must not run unattended — they land the
// task in needs_you for a human to approve instead. Conservative on purpose:
// these are irreversible or outside-the-repo actions. Users can extend the list
// via config later; this is the built-in floor. See .ai/05-orchestration.md § Approvals.
var DestructivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]`), // rm -rf / rm -fr / rm -r -f
	regexp.MustCompile(`\brm\s+-[a-zA-Z]*f`),                    // rm -f
	regexp.MustCompile(`\bgit\s+push\b`),                        // pushing anywhere
	regexp.MustCompile(`\bgit\s+.*\bpush\s+.*--force|\bgit\s+push\s+-f\b`),
	regexp.MustCompile(`\bgit\s+reset\s+--hard\b`),
	regexp.MustCompile(`\bgit\s+clean\s+-[a-zA-Z]*[dfx]`),
	regexp.MustCompile(`\bsudo\b`),
	regexp.MustCompile(`\b(shutdown|reboot|halt|poweroff)\b`),
	regexp.MustCompile(`\bmkfs\b|\bdd\s+if=`),
	regexp.MustCompile(`>\s*/dev/sd|\bfdisk\b`),
	regexp.MustCompile(`\bcurl\b.*\|\s*(sh|bash)\b|\bwget\b.*\|\s*(sh|bash)\b`), // pipe-to-shell
	regexp.MustCompile(`\bkubectl\s+delete\b|\bterraform\s+(destroy|apply)\b`),
	regexp.MustCompile(`\bnpm\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgoreleaser\s+release\b`),
	regexp.MustCompile(`:\(\)\s*\{.*\|.*&\s*\}`), // fork bomb
}

// IsDestructive reports whether a command matches the destructive policy, and the
// first pattern it matched (for the escalation message).
func IsDestructive(command string) (bool, string) {
	c := strings.ToLower(command)
	for _, re := range DestructivePatterns {
		if re.MatchString(c) {
			return true, re.String()
		}
	}
	return false, ""
}

// ScreenDoneCriteria returns the destructive commands among a task's
// done_criteria (empty when all are safe). The verification runner uses this to
// send a task to needs_you instead of running a dangerous command unattended.
func ScreenDoneCriteria(criteria []string) []string {
	var flagged []string
	for _, cmd := range criteria {
		if bad, _ := IsDestructive(cmd); bad {
			flagged = append(flagged, cmd)
		}
	}
	return flagged
}

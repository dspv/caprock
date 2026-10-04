package store

import (
	"path/filepath"
	"regexp"
	"strings"
)

// The Week card counts what the agents did with git and gh: commits made, pull
// requests opened and merged. The only record of that on this machine is the
// shell command each Bash call ran and what it printed, so these helpers read a
// command the way a shell would -- enough of it to answer "which statements ran
// `git commit`" without being fooled by a commit message that mentions one.
//
// They are deliberately small. A real shell grammar is not the goal; refusing
// to count what cannot be read is. Each rule below exists because the simpler
// one miscounted real commands on the owner's database.

// shellStatement is one simple command: its words with quotes removed, and the
// directory it ran in as far as the preceding `cd`s say.
type shellStatement struct {
	words []string
	dir   string
}

var heredocStart = regexp.MustCompile(`<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))`)

// stripHeredocs removes the bodies of here-documents, keeping the line that
// opens one. A commit message passed as `-F - <<'EOF' ... EOF` is prose, and a
// line of it that happens to start with "git commit" is not a commit.
func stripHeredocs(cmd string) string {
	if !strings.Contains(cmd, "<<") {
		return cmd
	}
	lines := strings.Split(cmd, "\n")
	out := make([]string, 0, len(lines))
	var pending []string // delimiters opened on the current line, in order
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if len(pending) > 0 {
			if strings.TrimSpace(line) == pending[0] {
				pending = pending[1:]
			}
			continue
		}
		out = append(out, line)
		for _, m := range heredocStart.FindAllStringSubmatch(line, -1) {
			for _, d := range m[1:] {
				if d != "" {
					pending = append(pending, d)
					break
				}
			}
		}
	}
	return strings.Join(out, "\n")
}

// splitShell breaks a command into simple statements. It honours single and
// double quotes and backslash escapes, and treats `;`, `&&`, `||`, `|`, `&`,
// newlines, parentheses and `$(` as boundaries. `cd <dir>` statements update
// the directory the following statements are said to run in.
func splitShell(cmd, cwd string) []shellStatement {
	cmd = stripHeredocs(cmd)
	var (
		stmts []shellStatement
		words []string
		cur   strings.Builder
		inTok bool
		dir   = cwd
	)
	flushWord := func() {
		if inTok {
			words = append(words, cur.String())
			cur.Reset()
			inTok = false
		}
	}
	flushStmt := func() {
		flushWord()
		w := trimLeaders(words)
		words = nil
		if len(w) == 0 {
			return
		}
		if w[0] == "cd" {
			if len(w) > 1 {
				dir = resolveDir(dir, w[1])
			}
			return
		}
		stmts = append(stmts, shellStatement{words: w, dir: dir})
	}
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\\' && i+1 < len(rs):
			i++
			if rs[i] != '\n' {
				cur.WriteRune(rs[i])
				inTok = true
			}
		case c == '\'':
			inTok = true
			for i++; i < len(rs) && rs[i] != '\''; i++ {
				cur.WriteRune(rs[i])
			}
		case c == '"':
			inTok = true
			for i++; i < len(rs) && rs[i] != '"'; i++ {
				if rs[i] == '\\' && i+1 < len(rs) {
					i++
				}
				cur.WriteRune(rs[i])
			}
		case c == '#' && !inTok:
			// A comment runs to the end of the line.
			for i < len(rs) && rs[i] != '\n' {
				i++
			}
			flushStmt()
		case c == ';' || c == '&' || c == '|' || c == '\n' || c == '(' || c == ')' || c == '`':
			flushStmt()
		case c == '$' && i+1 < len(rs) && rs[i+1] == '(':
			flushStmt()
			i++
		case c == ' ' || c == '\t' || c == '\r':
			flushWord()
		default:
			cur.WriteRune(c)
			inTok = true
		}
	}
	flushStmt()
	return stmts
}

// trimLeaders drops the words that come before the command itself: shell
// keywords that open a block, `!`, `time`, and environment assignments.
func trimLeaders(w []string) []string {
	for len(w) > 0 {
		switch w[0] {
		case "then", "do", "else", "if", "while", "until", "!", "time", "command", "exec", "{", "}":
			w = w[1:]
			continue
		}
		if i := strings.IndexByte(w[0], '='); i > 0 && isEnvName(w[0][:i]) {
			w = w[1:]
			continue
		}
		break
	}
	return w
}

func isEnvName(s string) bool {
	for i, r := range s {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return s != ""
}

func resolveDir(base, to string) string {
	if to == "" || to == "-" || strings.HasPrefix(to, "$") {
		return base
	}
	if strings.HasPrefix(to, "~") {
		return to // a home-relative path is still a key; it is never shown
	}
	if filepath.IsAbs(to) || base == "" {
		return filepath.Clean(to)
	}
	return filepath.Join(base, to)
}

// gitSubcommand returns the git subcommand of a statement, skipping git's
// global options (`-C dir` and `-c key=value` take a value).
func gitSubcommand(st shellStatement) string {
	w := st.words
	if len(w) == 0 || w[0] != "git" {
		return ""
	}
	for i := 1; i < len(w); i++ {
		a := w[i]
		switch {
		case (a == "-C" || a == "-c") && i+1 < len(w):
			i++
		case strings.HasPrefix(a, "-"):
			// --no-pager, --git-dir=..., and the like.
		default:
			return a
		}
	}
	return ""
}

// countCommits is how many `git commit` statements a command ran. A command
// whose output says there was nothing to commit made one fewer.
func countCommits(stmts []shellStatement, output string) int {
	n := 0
	for _, st := range stmts {
		if gitSubcommand(st) == "commit" {
			n++
		}
	}
	n -= strings.Count(output, "nothing to commit")
	n -= strings.Count(output, "no changes added to commit")
	if n < 0 {
		n = 0
	}
	return n
}

// ghPR returns the gh pr subcommand of a statement ("create", "merge", ...).
func ghPR(st shellStatement) string {
	w := st.words
	if len(w) >= 3 && w[0] == "gh" && w[1] == "pr" {
		return w[2]
	}
	return ""
}

// mergeTarget is what one `gh pr merge` named.
type mergeTarget struct {
	slug   string // owner/repo when the command said it
	number int    // 0 when the command did not name one
	dir    string // where it ran, to find the repository when slug is empty
}

// ghValueFlags are the `gh pr merge` flags that take a value, so the value is
// not mistaken for the PR argument.
var ghValueFlags = map[string]bool{
	"-R": true, "--repo": true, "-t": true, "--subject": true, "-b": true, "--body": true,
	"-F": true, "--body-file": true, "-A": true, "--author-email": true, "--match-head-commit": true,
}

// parseMerge reads the target of a `gh pr merge` statement. An argument that is
// neither a number nor a pull-request URL -- a branch name, `$N` -- leaves the
// number at zero: what it named cannot be read from the command.
func parseMerge(st shellStatement) mergeTarget {
	t := mergeTarget{dir: st.dir}
	w := st.words
	for i := 3; i < len(w); i++ {
		a := w[i]
		if strings.HasPrefix(a, "-") {
			name, val, hasVal := strings.Cut(a, "=")
			if name == "-R" || name == "--repo" {
				if hasVal {
					t.slug = repoSlug(val)
				} else if i+1 < len(w) {
					t.slug = repoSlug(w[i+1])
				}
			}
			if ghValueFlags[name] && !hasVal {
				i++
			}
			continue
		}
		if m := prURL.FindStringSubmatch(a); m != nil {
			t.slug, t.number = m[1], atoiSafe(m[2])
		} else if n := atoiSafe(strings.TrimPrefix(a, "#")); n > 0 {
			t.number = n
		}
		break
	}
	return t
}

// repoSlug normalises "OWNER/REPO" or "HOST/OWNER/REPO" to "owner/repo".
func repoSlug(s string) string {
	s = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(s, "https://"), "http://"), ".git")
	parts := strings.Split(strings.Trim(s, "/"), "/")
	if len(parts) < 2 {
		return ""
	}
	return strings.ToLower(parts[len(parts)-2] + "/" + parts[len(parts)-1])
}

func atoiSafe(s string) int {
	if s == "" || len(s) > 9 {
		return 0
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// prURL matches a GitHub pull-request URL. GitHub Enterprise hosts are not
// matched: a card that counts them would need to know which host is whose.
var prURL = regexp.MustCompile(`https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/(\d+)`)

// prRef is one pull request, keyed the same way wherever it was seen.
type prRef struct {
	slug   string
	number int
}

// openedPRs reads the pull-request URLs `gh pr create` printed. A line saying
// the pull request already exists names one that was not opened by this call.
func openedPRs(output string) []prRef {
	var out []prRef
	seen := map[prRef]bool{}
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "already exists") {
			continue
		}
		for _, m := range prURL.FindAllStringSubmatch(line, -1) {
			r := prRef{strings.ToLower(m[1]), atoiSafe(m[2])}
			if !seen[r] {
				seen[r] = true
				out = append(out, r)
			}
		}
	}
	return out
}

// distinctPRs is every distinct pull-request URL in a command's output.
func distinctPRs(output string) []prRef {
	var out []prRef
	seen := map[prRef]bool{}
	for _, m := range prURL.FindAllStringSubmatch(output, -1) {
		r := prRef{strings.ToLower(m[1]), atoiSafe(m[2])}
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// lineCount is how many lines a string written by Edit or Write holds. A
// trailing newline ends the last line rather than starting another.
func lineCount(s string) int64 {
	if s == "" {
		return 0
	}
	n := int64(strings.Count(s, "\n"))
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// ciWait matches a command that waits on continuous integration. It is a
// statement-level test so a command that merely mentions one does not count.
var ciWait = regexp.MustCompile(`(?i)wait[-_]?ci|ci[-_]?wait`)

func waitsOnCI(stmts []shellStatement) bool {
	for _, st := range stmts {
		w := st.words
		if len(w) >= 3 && w[0] == "gh" {
			if (w[1] == "pr" && w[2] == "checks") || (w[1] == "run" && w[2] == "watch") {
				return true
			}
		}
		if len(w) > 0 && ciWait.MatchString(filepath.Base(w[0])) {
			return true
		}
		if len(w) > 1 && (w[0] == "bash" || w[0] == "sh" || w[0] == "zsh") && ciWait.MatchString(filepath.Base(w[1])) {
			return true
		}
	}
	return false
}

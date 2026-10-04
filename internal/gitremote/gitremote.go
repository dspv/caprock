// Package gitremote answers "where does this repository live on the web, and
// which pull requests did a session open", from the machine alone.
//
// Owner request (2026-10-04): from a session, one click to the repository it
// works in and to the pull requests it opened. Rule 4 holds: nothing here
// makes a network call. The repository comes from `git remote get-url` in the
// session's directory, turned into a web address by string rules; the pull
// requests come from what Claude Code already recorded in its own tool output.
// A remote this package cannot read as a web host yields no link rather than a
// guessed one.
package gitremote

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Repo is where a working directory's repository lives.
type Repo struct {
	// Root is the repository's top level on this machine, or the directory
	// itself when git could not say. Shown, with a copy button, when there is
	// no web address to link to.
	Root string `json:"root"`
	// URL is the repository's web address, https, no credentials. Empty when
	// there is no remote or it is not a web host (a path, a file:// URL).
	URL string `json:"url,omitempty"`
	// Branch is the checked-out branch; empty on a detached HEAD.
	Branch string `json:"branch,omitempty"`
	// DefaultBranch is the remote's default branch when git knows it locally
	// (refs/remotes/<remote>/HEAD).
	DefaultBranch string `json:"default_branch,omitempty"`
	// BranchURL is the branch's page, set only when the branch is not the
	// default and the host's URL scheme for branches is known.
	BranchURL string `json:"branch_url,omitempty"`
}

// Lookup reads the repository a directory belongs to. It runs git with a
// short timeout per call; a directory that is not a repository returns a Repo
// with only Root set and ok=false.
func Lookup(ctx context.Context, dir string) (Repo, bool) {
	r := Repo{Root: dir}
	top, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil || top == "" {
		return r, false
	}
	r.Root = filepath.FromSlash(top) // git prints C:/x on Windows
	remote := pickRemote(lines(gitOr(ctx, dir, "remote")))
	if remote != "" {
		if raw := gitOr(ctx, dir, "remote", "get-url", remote); raw != "" {
			r.URL, _ = WebURL(raw)
		}
		if def := gitOr(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/"+remote+"/HEAD"); def != "" {
			r.DefaultBranch = strings.TrimPrefix(def, remote+"/")
		}
	}
	if b := gitOr(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD"); b != "" && b != "HEAD" {
		r.Branch = b
	}
	r.BranchURL = BranchURL(r.URL, r.Branch, r.DefaultBranch)
	return r, true
}

// pickRemote is origin when there is one, else the first remote git lists.
func pickRemote(names []string) string {
	for _, n := range names {
		if n == "origin" {
			return n
		}
	}
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

var scpLike = regexp.MustCompile(`^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9.-]+):(.+)$`)

// WebURL turns a git remote into the repository's https address.
//
// Accepted: `git@host:owner/repo.git` (scp-like), `ssh://[user@]host[:port]/owner/repo.git`,
// `git+ssh://`, `git://`, `http(s)://[user[:pass]@]host[:port]/owner/repo(.git)`.
// Credentials and an ssh port are dropped (the web is on https's own port);
// an http(s) port is kept. A local path, `file://`, or anything else that
// names no host returns false.
func WebURL(remote string) (string, bool) {
	s := strings.TrimSpace(remote)
	if s == "" {
		return "", false
	}
	var host, path string
	switch {
	case strings.Contains(s, "://"):
		u, err := url.Parse(s)
		if err != nil || u.Host == "" {
			return "", false
		}
		switch u.Scheme {
		case "https", "http":
			host = u.Host // keep an explicit web port
		case "ssh", "git+ssh", "ssh+git", "git":
			host = u.Hostname()
		default:
			return "", false
		}
		path = u.Path
	default:
		// scp-like: [user@]host:path. A Windows path (C:\x or C:/x) has a
		// one-letter "host" and is a local path, not a remote.
		m := scpLike.FindStringSubmatch(s)
		if m == nil || len(m[1]) < 2 || strings.HasPrefix(m[2], "\\") {
			return "", false
		}
		host, path = m[1], m[2]
	}
	path = strings.Trim(path, "/")
	path = strings.TrimSuffix(path, ".git")
	path = strings.Trim(path, "/")
	if host == "" || path == "" || !strings.Contains(host, ".") && host != "localhost" && !strings.Contains(host, ":") {
		// A bare word ("origin", "myserver") is an ssh alias from ~/.ssh/config:
		// its web host cannot be known from here.
		return "", false
	}
	// Azure DevOps over ssh: ssh.dev.azure.com:v3/org/project/repo.
	if host == "ssh.dev.azure.com" && strings.HasPrefix(path, "v3/") {
		parts := strings.SplitN(strings.TrimPrefix(path, "v3/"), "/", 3)
		if len(parts) == 3 {
			return "https://dev.azure.com/" + parts[0] + "/" + parts[1] + "/_git/" + parts[2], true
		}
		return "", false
	}
	return "https://" + host + "/" + path, true
}

// BranchURL is the web page of a branch, or "" when the branch is the default
// (the repository page already shows it), unknown, or the host's scheme for
// branch pages is not one this package knows. Hosts are recognised by name, so
// GitHub Enterprise and self-hosted GitLab are covered when their host says so.
func BranchURL(repoURL, branch, defaultBranch string) string {
	if repoURL == "" || branch == "" {
		return ""
	}
	if branch == defaultBranch || defaultBranch == "" && (branch == "main" || branch == "master") {
		return ""
	}
	u, err := url.Parse(repoURL)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	b := escapeBranch(branch)
	switch {
	case strings.Contains(host, "github"):
		return repoURL + "/tree/" + b
	case strings.Contains(host, "gitlab"):
		return repoURL + "/-/tree/" + b
	case strings.Contains(host, "bitbucket"):
		return repoURL + "/src/" + b
	case host == "codeberg.org" || strings.Contains(host, "gitea") || strings.Contains(host, "forgejo"):
		return repoURL + "/src/branch/" + b
	}
	return ""
}

// escapeBranch escapes each path segment of a branch name; the slashes in
// `fix/thing` stay slashes, as every host above expects.
func escapeBranch(b string) string {
	parts := strings.Split(b, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// PR is one pull request a session opened, or merged, as its own tool output
// recorded it.
type PR struct {
	URL    string `json:"url"`
	Number int    `json:"number"`
	// Title is the `--title` the command passed, when it passed one plainly.
	Title string `json:"title,omitempty"`
	// Action is what this one command did: created, merged, closed, edited,
	// commented. Only a recorded "merged" ever makes a PR read as merged.
	Action string `json:"action"`
}

var prURL = regexp.MustCompile(`https://[A-Za-z0-9.-]+(?::\d+)?/[^\s"'<>]+/pull/(\d+)`)

// FromToolPost reads a pull request out of a Bash tool's PostToolUse payload.
//
// Claude Code records `tool_response.gitOperation.pr` — {number, url, action} —
// when a `gh pr` command succeeds; that is the primary source and the only one
// trusted for anything but "created". Without it, a `gh pr create` whose output
// carries a pull-request URL counts as created. A failed command records
// nothing.
func FromToolPost(payload []byte) (PR, bool) {
	var p struct {
		ToolInput struct {
			Command string `json:"command"`
		} `json:"tool_input"`
		ToolResponse json.RawMessage `json:"tool_response"`
		IsError      bool            `json:"is_error"`
	}
	if json.Unmarshal(payload, &p) != nil || p.IsError {
		return PR{}, false
	}
	var resp struct {
		Stdout       string `json:"stdout"`
		GitOperation *struct {
			PR *struct {
				Number int    `json:"number"`
				URL    string `json:"url"`
				Action string `json:"action"`
			} `json:"pr"`
		} `json:"gitOperation"`
	}
	_ = json.Unmarshal(p.ToolResponse, &resp)
	title := titleOf(p.ToolInput.Command)
	if g := resp.GitOperation; g != nil && g.PR != nil && g.PR.Number > 0 {
		pr := PR{URL: g.PR.URL, Number: g.PR.Number, Action: g.PR.Action}
		if pr.URL == "" {
			// "closed" arrives without a URL; the store matches it by number.
			return pr, pr.Action != ""
		}
		if pr.Action == "created" {
			pr.Title = title
		}
		return pr, pr.Action != ""
	}
	if !isPRCreate(p.ToolInput.Command) {
		return PR{}, false
	}
	m := prURL.FindStringSubmatch(resp.Stdout)
	if m == nil {
		return PR{}, false
	}
	n, _ := strconv.Atoi(m[1])
	return PR{URL: m[0], Number: n, Title: title, Action: "created"}, n > 0
}

func isPRCreate(cmd string) bool {
	f := strings.Fields(cmd)
	for i := 0; i+2 < len(f); i++ {
		if f[i] == "gh" && f[i+1] == "pr" && f[i+2] == "create" {
			return true
		}
	}
	return false
}

// titleOf is the --title / -t argument of a `gh pr create`, when it is a plain
// quoted or bare word sequence. A title built by a subshell is not guessed.
func titleOf(cmd string) string {
	i := strings.Index(cmd, "gh pr create")
	if i < 0 {
		return ""
	}
	toks := shellWords(cmd[i:])
	for j, t := range toks {
		var v string
		switch {
		case (t == "--title" || t == "-t") && j+1 < len(toks):
			v = toks[j+1]
		case strings.HasPrefix(t, "--title="):
			v = strings.TrimPrefix(t, "--title=")
		default:
			continue
		}
		if strings.Contains(v, "$(") || strings.Contains(v, "`") {
			return ""
		}
		return strings.TrimSpace(v)
	}
	return ""
}

// shellWords splits a command line the way a POSIX shell would for plain
// quoting — single quotes literal, double quotes with backslash escapes — and
// stops at the end of the first line (a heredoc body is not arguments).
func shellWords(s string) []string {
	var out []string
	var cur strings.Builder
	in := false
	var quote rune
	for i := 0; i < len(s); i++ {
		c := rune(s[i])
		switch {
		case quote == '\'':
			if c == '\'' {
				quote = 0
			} else {
				cur.WriteByte(s[i])
			}
		case quote == '"':
			switch {
			case c == '\\' && i+1 < len(s):
				i++
				cur.WriteByte(s[i])
			case c == '"':
				quote = 0
			default:
				cur.WriteByte(s[i])
			}
		case c == '\'' || c == '"':
			quote, in = c, true
		case c == '\n':
			if in {
				out = append(out, cur.String())
			}
			return out
		case c == ' ' || c == '\t':
			if in {
				out = append(out, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteByte(s[i])
			in = true
		}
	}
	if in {
		out = append(out, cur.String())
	}
	return out
}

const gitTimeout = 2 * time.Second

func git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func gitOr(ctx context.Context, dir string, args ...string) string {
	s, _ := git(ctx, dir, args...)
	return s
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

package github

import (
	"net/url"
	"regexp"
	"strings"
)

// Repo names a repository on github.com.
type Repo struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

// FullName is "owner/name".
func (r Repo) FullName() string { return r.Owner + "/" + r.Name }

var namePart = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ParseRemote reads the repository a git remote URL points at on
// github.com: https://github.com/o/r(.git), git@github.com:o/r(.git),
// ssh://git@github.com/o/r(.git). Any other host is not GitHub's (false).
func ParseRemote(remote string) (Repo, bool) {
	s := strings.TrimSpace(remote)
	var path string
	switch {
	case strings.HasPrefix(s, "git@github.com:"):
		path = strings.TrimPrefix(s, "git@github.com:")
	case strings.Contains(s, "://"):
		u, err := url.Parse(s)
		if err != nil || !strings.EqualFold(u.Hostname(), "github.com") {
			return Repo{}, false
		}
		switch u.Scheme {
		case "https", "http", "ssh", "git":
		default:
			return Repo{}, false
		}
		path = strings.TrimPrefix(u.Path, "/")
	default:
		return Repo{}, false
	}
	path = strings.TrimSuffix(strings.TrimSuffix(path, "/"), ".git")
	owner, name, ok := strings.Cut(path, "/")
	if !ok || strings.Contains(name, "/") || !namePart.MatchString(owner) || !namePart.MatchString(name) {
		return Repo{}, false
	}
	return Repo{Owner: owner, Name: name}, true
}

// validRepoName is GitHub's rule for a new repository's name, loosely: what
// it would turn into something else is refused here, so the name created is
// the name typed.
func validRepoName(n string) bool {
	return n != "" && len(n) <= 100 && namePart.MatchString(n) && n != "." && n != ".."
}

package projects

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

// What the GitHub integration (internal/github) asks of a worktree beyond
// the Changes calls: naming a remote for a repository it just created, and
// the commit subjects a pull request is drafted from.

// remoteName is a remote name git takes without quoting.
var remoteName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// AddRemote adds a remote to a project's repository (its main checkout),
// refusing a name that exists. The URL is an https:// address or
// git@host:path — the forms a clone accepts.
func (s *Service) AddRemote(ctx context.Context, id int64, name, url string) (Changes, error) {
	if !remoteName.MatchString(name) {
		return Changes{}, changeErr(KindInvalid, "%q is not a remote name", name)
	}
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "git@") || strings.ContainsAny(url, " \t\r\n") {
		return Changes{}, changeErr(KindInvalid, "a remote is an https:// or git@ address")
	}
	dir, err := s.WorktreePath(ctx, id, "")
	if err != nil {
		return Changes{}, err
	}
	unlock := s.lockFor(dir)
	defer unlock()
	if cfg := s.readRemoteConfig(ctx, dir); cfg.urls[name] != "" {
		return Changes{}, changeErr(KindState, "the remote %s exists already (%s)", name, cfg.urls[name])
	}
	if _, err := s.gitCmd(ctx, gitOpts{timeout: indexTimeout}, dir, "remote", "add", "--", name, url); err != nil {
		return Changes{}, err
	}
	go s.refreshNow(id)
	return s.changesAt(ctx, id, "", dir)
}

// maxSubjects is how many commit subjects a pull request is drafted from.
const maxSubjects = 50

// Subjects are the subjects of the commits on a worktree's branch that its
// base lacks, newest first: against the remote's copy of base when there is
// one, else the local base. None when base is unknown or is the branch.
func (s *Service) Subjects(ctx context.Context, id int64, worktree, base string) ([]string, error) {
	if base == "" || strings.HasPrefix(base, "-") {
		return []string{}, nil
	}
	dir, err := s.WorktreePath(ctx, id, worktree)
	if err != nil {
		return nil, err
	}
	cfg := s.readRemoteConfig(ctx, dir)
	refs := []string{"refs/heads/" + base}
	if cfg.urls["origin"] != "" {
		refs = append([]string{"refs/remotes/origin/" + base}, refs...)
	}
	for _, ref := range refs {
		if _, err := s.gitCmd(ctx, readOpts, dir, "rev-parse", "--verify", "--quiet", ref); err != nil {
			continue
		}
		r, err := s.gitCmd(ctx, readOpts, dir, "log", "--no-color", "--format=%s", "-n", strconv.Itoa(maxSubjects), ref+"..HEAD", "--")
		if err != nil {
			return nil, err
		}
		out := []string{}
		for _, l := range strings.Split(strings.TrimSpace(string(r.out)), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				out = append(out, l)
			}
		}
		return out, nil
	}
	return []string{}, nil
}

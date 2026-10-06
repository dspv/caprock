package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/projects"
)

// RepoInfo is one repository in the clone picker.
type RepoInfo struct {
	FullName      string `json:"full_name"`
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Private       bool   `json:"private"`
	Fork          bool   `json:"fork"`
	Archived      bool   `json:"archived"`
	Description   string `json:"description,omitempty"`
	CloneURL      string `json:"clone_url"`
	SSHURL        string `json:"ssh_url"`
	HTMLURL       string `json:"html_url"`
	DefaultBranch string `json:"default_branch,omitempty"`
	PushedAt      string `json:"pushed_at,omitempty"`
}

// apiRepo is GitHub's repository object, the part read.
type apiRepo struct {
	FullName string `json:"full_name"`
	Name     string `json:"name"`
	Owner    struct {
		Login string `json:"login"`
	} `json:"owner"`
	Private       bool   `json:"private"`
	Fork          bool   `json:"fork"`
	Archived      bool   `json:"archived"`
	Description   string `json:"description"`
	CloneURL      string `json:"clone_url"`
	SSHURL        string `json:"ssh_url"`
	HTMLURL       string `json:"html_url"`
	DefaultBranch string `json:"default_branch"`
	PushedAt      string `json:"pushed_at"`
}

func (r apiRepo) info() RepoInfo {
	return RepoInfo{FullName: r.FullName, Name: r.Name, Owner: r.Owner.Login, Private: r.Private, Fork: r.Fork, Archived: r.Archived,
		Description: r.Description, CloneURL: r.CloneURL, SSHURL: r.SSHURL, HTMLURL: r.HTMLURL, DefaultBranch: r.DefaultBranch, PushedAt: r.PushedAt}
}

// Owner is the user or an organization repositories are listed for.
type Owner struct {
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url,omitempty"`
	Org       bool   `json:"org"`
}

// Owners is the user and their organizations.
type Owners struct {
	Owners []Owner `json:"owners"`
}

// Owners lists the account and the organizations it belongs to.
func (s *Service) Owners(ctx context.Context) (Owners, *Error) {
	u, e := s.me(ctx)
	if e != nil {
		return Owners{}, e
	}
	out := Owners{Owners: []Owner{{Login: u.Login, AvatarURL: u.AvatarURL}}}
	const doing = "Listing your organizations"
	res, e := s.call(ctx, request{method: http.MethodGet, path: "/user/orgs?per_page=100", doing: doing})
	if e != nil {
		return out, e
	}
	var orgs []struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	}
	if e := decode(res, doing, &orgs); e != nil {
		return out, e
	}
	for _, o := range orgs {
		out.Owners = append(out.Owners, Owner{Login: o.Login, AvatarURL: o.AvatarURL, Org: true})
	}
	return out, nil
}

// me is the account, read once and then kept.
func (s *Service) me(ctx context.Context) (*User, *Error) {
	s.mu.Lock()
	u := s.user
	s.mu.Unlock()
	if u != nil {
		return u, nil
	}
	if e := s.refreshUser(ctx); e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.user, nil
}

// RepoPage is one page of the picker.
type RepoPage struct {
	Repos []RepoInfo `json:"repos"`
	Page  int        `json:"page"`
	Next  bool       `json:"next"`
	// Search is true when the list came from GitHub's search, which finds
	// the repositories of the owners named and not those shared with you.
	Search bool `json:"search,omitempty"`
}

// perPage is the picker's page size.
const perPage = 30

// Repos lists repositories: every one the token can reach (owner ""), one
// owner's, or — with a query — a search by name among the account's and its
// organizations' (or one owner's).
func (s *Service) Repos(ctx context.Context, owner, query string, page int) (RepoPage, *Error) {
	if page < 1 {
		page = 1
	}
	query = strings.TrimSpace(query)
	if len(query) > 100 {
		return RepoPage{}, errorf(KindInvalid, "Searching your repositories", "the search is too long")
	}
	if owner != "" && !namePart.MatchString(owner) {
		return RepoPage{}, errorf(KindInvalid, "Listing repositories", "%q is not a GitHub account name", owner)
	}
	if query != "" {
		return s.searchRepos(ctx, owner, query, page)
	}
	u, e := s.me(ctx)
	if e != nil {
		return RepoPage{}, e
	}
	q := url.Values{"per_page": {strconv.Itoa(perPage)}, "page": {strconv.Itoa(page)}, "sort": {"pushed"}}
	path, doing := "/user/repos", "Listing your repositories"
	switch {
	case owner == "":
		q.Set("affiliation", "owner,collaborator,organization_member")
	case strings.EqualFold(owner, u.Login):
		q.Set("affiliation", "owner")
	default:
		path, doing = "/orgs/"+url.PathEscape(owner)+"/repos", "Listing "+owner+"'s repositories"
		q.Del("sort")
		q.Set("sort", "pushed")
		q.Set("type", "all")
	}
	res, e := s.call(ctx, request{method: http.MethodGet, path: path + "?" + q.Encode(), doing: doing})
	if e != nil {
		return RepoPage{}, e
	}
	var repos []apiRepo
	if e := decode(res, doing, &repos); e != nil {
		return RepoPage{}, e
	}
	out := RepoPage{Repos: make([]RepoInfo, 0, len(repos)), Page: page, Next: nextLink(res.header) != ""}
	for _, r := range repos {
		out.Repos = append(out.Repos, r.info())
	}
	return out, nil
}

// searchRepos runs GitHub's repository search by name, limited to the
// account and its organizations, or to one owner.
func (s *Service) searchRepos(ctx context.Context, owner, query string, page int) (RepoPage, *Error) {
	const doing = "Searching your repositories"
	quals := []string{}
	if owner != "" {
		quals = append(quals, "user:"+owner)
	} else {
		os, e := s.Owners(ctx)
		if e != nil && len(os.Owners) == 0 {
			return RepoPage{}, e
		}
		for _, o := range os.Owners {
			if o.Org {
				quals = append(quals, "org:"+o.Login)
			} else {
				quals = append(quals, "user:"+o.Login)
			}
		}
	}
	// Quotes and qualifiers typed by the user are kept: someone typing
	// "language:go" means it.
	q := query + " in:name fork:true " + strings.Join(quals, " ")
	v := url.Values{"q": {q}, "per_page": {strconv.Itoa(perPage)}, "page": {strconv.Itoa(page)}, "sort": {"updated"}}
	res, e := s.call(ctx, request{method: http.MethodGet, path: "/search/repositories?" + v.Encode(), doing: doing})
	if e != nil {
		return RepoPage{}, e
	}
	var found struct {
		Items []apiRepo `json:"items"`
	}
	if e := decode(res, doing, &found); e != nil {
		return RepoPage{}, e
	}
	out := RepoPage{Repos: make([]RepoInfo, 0, len(found.Items)), Page: page, Next: nextLink(res.header) != "", Search: true}
	for _, r := range found.Items {
		out.Repos = append(out.Repos, r.info())
	}
	return out, nil
}

// CreateRepoRequest is POST /v1/projects/{id}/github/repo.
type CreateRepoRequest struct {
	Name        string `json:"name"`
	Owner       string `json:"owner,omitempty"` // an organization; empty is the account
	Private     *bool  `json:"private,omitempty"`
	Description string `json:"description,omitempty"`
	Protocol    string `json:"protocol,omitempty"` // https (default) | ssh: the remote's address
	Push        *bool  `json:"push,omitempty"`     // push the branch after (default true)
}

// PushFailure is a push that failed, as the Changes push reports one.
type PushFailure struct {
	Error  string `json:"error"`
	Kind   string `json:"kind"`
	Output string `json:"output,omitempty"`
}

// CreateRepoResult says what was done: the repository, the remote, and the
// push, which can fail on its own after the first two succeeded.
type CreateRepoResult struct {
	Repo      RepoInfo               `json:"repo"`
	Remote    string                 `json:"remote"`
	RemoteURL string                 `json:"remote_url"`
	Pushed    bool                   `json:"pushed"`
	Push      *projects.RemoteResult `json:"push,omitempty"`
	PushError *PushFailure           `json:"push_error,omitempty"`
	Changes   projects.Changes       `json:"changes"`
}

// CreateRepo makes a repository on GitHub for a local project that has no
// remote, sets it as origin, and pushes the checked-out branch through the
// Changes push (the user's own git credentials, never this token).
func (s *Service) CreateRepo(ctx context.Context, projectID int64, req CreateRepoRequest) (CreateRepoResult, error) {
	const doing = "Creating the GitHub repository"
	name := strings.TrimSpace(req.Name)
	if !validRepoName(name) {
		return CreateRepoResult{}, errorf(KindInvalid, doing, "a repository name is letters, digits, '.', '-' and '_', at most 100")
	}
	if req.Owner != "" && !namePart.MatchString(req.Owner) {
		return CreateRepoResult{}, errorf(KindInvalid, doing, "%q is not a GitHub account name", req.Owner)
	}
	if len(req.Description) > 350 {
		return CreateRepoResult{}, errorf(KindInvalid, doing, "the description is longer than GitHub takes (350)")
	}
	c, err := s.Projects.Changes(ctx, projectID, "")
	if err != nil {
		return CreateRepoResult{}, err
	}
	if c.Remote != "" {
		return CreateRepoResult{}, errorf(KindState, doing, "this repository already has a remote (%s → %s); it is published already", c.Remote, c.RemoteURL)
	}
	private := req.Private == nil || *req.Private
	path := "/user/repos"
	if req.Owner != "" {
		if u, e := s.me(ctx); e == nil && !strings.EqualFold(u.Login, req.Owner) {
			path = "/orgs/" + url.PathEscape(req.Owner) + "/repos"
		}
	}
	body := map[string]any{"name": name, "private": private}
	if d := strings.TrimSpace(req.Description); d != "" {
		body["description"] = d
	}
	res, e := s.call(ctx, request{method: http.MethodPost, path: path, body: body, doing: doing})
	if e != nil {
		if e.Kind == KindExists || (e.Kind == KindInvalid && strings.Contains(strings.ToLower(e.Message), "name already exists")) {
			e.Kind = KindExists
			e.Message = fmt.Sprintf("a repository named %s already exists there; pick another name", name)
		}
		return CreateRepoResult{}, e
	}
	var r apiRepo
	if e := decode(res, doing, &r); e != nil {
		return CreateRepoResult{}, e
	}
	out := CreateRepoResult{Repo: r.info(), Remote: "origin", RemoteURL: r.CloneURL}
	if req.Protocol == "ssh" {
		out.RemoteURL = r.SSHURL
	}
	c, err = s.Projects.AddRemote(ctx, projectID, "origin", out.RemoteURL)
	if err != nil {
		return out, fmt.Errorf("the repository %s was created, but setting it as origin failed: %w", r.FullName, err)
	}
	out.Changes = c
	if (req.Push == nil || *req.Push) && c.Branch != "" && c.Head != "" {
		pr, c2, err := s.Projects.Push(ctx, projectID, "")
		var ce *projects.ChangeError
		switch {
		case err == nil:
			out.Pushed, out.Push, out.Changes = true, &pr, c2
		case errors.As(err, &ce):
			out.PushError = &PushFailure{Error: ce.Message, Kind: ce.Kind, Output: ce.Output}
		default:
			out.PushError = &PushFailure{Error: err.Error(), Kind: projects.KindGit}
		}
	}
	s.Kick(projectID)
	return out, nil
}

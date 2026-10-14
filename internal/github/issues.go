package github

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Start from an issue or a pull request: New agent's picker lists the open
// issues and pull requests of a project's repository on GitHub, read when
// the picker opens (never polled) and kept for itemsTTL, so reopening it or
// typing does not ask again.

// itemsTTL is how long one list or search answer is kept in memory.
const itemsTTL = 60 * time.Second

// itemsMax is the most items one answer holds: the newest-updated open ones.
const itemsMax = 100

// itemBodyMax bounds the body kept per item (runes); the interface trims
// it further for the first message and links the rest.
const itemBodyMax = 8000

// Label is an issue's or a pull request's label: its name and colour (six
// hex digits, no #).
type Label struct {
	Name  string `json:"name"`
	Color string `json:"color,omitempty"`
}

// Item is one open issue or pull request in the picker.
type Item struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	URL       string  `json:"url"`
	Author    string  `json:"author,omitempty"`
	Labels    []Label `json:"labels"`
	PR        bool    `json:"pr"`
	Draft     bool    `json:"draft,omitempty"`
	Body      string  `json:"body,omitempty"`
	Comments  int     `json:"comments"`
	UpdatedAt string  `json:"updated_at,omitempty"`
}

// Items is GET /v1/projects/{id}/github/items: the repository, its open
// issues and pull requests, and whether there were more than shown.
type Items struct {
	Connected bool     `json:"connected"`
	Repo      *RepoRef `json:"repo"`
	// Reason says why there is nothing to list: no_remote | not_github.
	Reason string `json:"reason,omitempty"`
	Items  []Item `json:"items"`
	More   bool   `json:"more"`
	// Search is true when the list came from GitHub's search for q.
	Search bool  `json:"search,omitempty"`
	At     int64 `json:"at"`
}

// apiIssue is GitHub's issue object, the part read. A pull request is an
// issue with pull_request set.
type apiIssue struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
	Body    string `json:"body"`
	User    struct {
		Login string `json:"login"`
	} `json:"user"`
	Labels []struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	} `json:"labels"`
	Draft       bool      `json:"draft"`
	Comments    int       `json:"comments"`
	UpdatedAt   string    `json:"updated_at"`
	PullRequest *struct{} `json:"pull_request"`
}

func (a apiIssue) item() Item {
	it := Item{Number: a.Number, Title: a.Title, URL: a.HTMLURL, Author: a.User.Login, Labels: []Label{}, PR: a.PullRequest != nil,
		Draft: a.Draft, Body: clipRunes(strings.TrimSpace(a.Body), itemBodyMax), Comments: a.Comments, UpdatedAt: a.UpdatedAt}
	for _, l := range a.Labels {
		it.Labels = append(it.Labels, Label{Name: l.Name, Color: l.Color})
	}
	return it
}

// clipRunes is s cut to at most n runes.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// itemsCached is one answer kept for itemsTTL.
type itemsCached struct {
	at  time.Time
	out Items
}

var issueNumber = regexp.MustCompile(`^#?([0-9]{1,9})$`)

// Items lists the open issues and pull requests of a project's repository,
// the most recently updated first; with q, GitHub's issue search in that
// repository, or the one numbered q ("123", "#123").
func (s *Service) Items(ctx context.Context, projectID int64, q string) (Items, error) {
	s.init()
	q = strings.TrimSpace(q)
	if len(q) > 200 {
		return Items{}, errorf(KindInvalid, "Searching issues", "the search is too long")
	}
	c, err := s.Projects.Changes(ctx, projectID, "")
	if err != nil {
		return Items{}, err
	}
	out := Items{Connected: s.source() != "", Items: []Item{}}
	if c.Remote == "" {
		out.Reason = "no_remote"
		return out, nil
	}
	repo, ok := ParseRemote(c.RemoteURL)
	if !ok {
		out.Reason = "not_github"
		return out, nil
	}
	out.Repo = &RepoRef{Owner: repo.Owner, Name: repo.Name, FullName: repo.FullName(), HTMLURL: "https://github.com/" + repo.FullName()}
	if !out.Connected {
		return out, nil
	}
	key := repo.FullName() + "\x00" + q
	s.mu.Lock()
	if hit, ok := s.items[key]; ok && s.Now().Sub(hit.at) < itemsTTL {
		s.mu.Unlock()
		return hit.out, nil
	}
	s.mu.Unlock()
	var e *Error
	switch m := issueNumber.FindStringSubmatch(q); {
	case q == "":
		e = s.listItems(ctx, repo, &out)
	case m != nil:
		e = s.oneItem(ctx, repo, m[1], &out)
	default:
		e = s.searchItems(ctx, repo, q, &out)
	}
	if e != nil {
		return Items{}, e
	}
	out.At = s.Now().UnixMilli()
	s.mu.Lock()
	if s.items == nil || len(s.items) >= maxCached {
		s.items = map[string]itemsCached{}
	}
	s.items[key] = itemsCached{at: s.Now(), out: out}
	s.mu.Unlock()
	return out, nil
}

func (s *Service) listItems(ctx context.Context, repo Repo, out *Items) *Error {
	doing := "Listing the open issues of " + repo.FullName()
	v := url.Values{"state": {"open"}, "sort": {"updated"}, "direction": {"desc"}, "per_page": {strconv.Itoa(itemsMax)}}
	res, e := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/issues?" + v.Encode(), doing: doing})
	if e != nil {
		return e
	}
	var list []apiIssue
	if e := decode(res, doing, &list); e != nil {
		return e
	}
	for _, a := range list {
		out.Items = append(out.Items, a.item())
	}
	out.More = nextLink(res.header) != ""
	return nil
}

func (s *Service) oneItem(ctx context.Context, repo Repo, n string, out *Items) *Error {
	doing := "Reading #" + n + " of " + repo.FullName()
	res, e := s.call(ctx, request{method: http.MethodGet, path: repoPath(repo) + "/issues/" + n, doing: doing})
	if e != nil {
		if e.Kind == KindNotFound {
			return nil // no such number: an empty list, not an error
		}
		return e
	}
	var a apiIssue
	if e := decode(res, doing, &a); e != nil {
		return e
	}
	if a.State == "open" {
		out.Items = append(out.Items, a.item())
	}
	return nil
}

func (s *Service) searchItems(ctx context.Context, repo Repo, q string, out *Items) *Error {
	doing := "Searching the issues of " + repo.FullName()
	v := url.Values{"q": {q + " repo:" + repo.FullName() + " is:open"}, "sort": {"updated"}, "order": {"desc"}, "per_page": {"50"}}
	res, e := s.call(ctx, request{method: http.MethodGet, path: "/search/issues?" + v.Encode(), doing: doing})
	if e != nil {
		return e
	}
	var found struct {
		Total int        `json:"total_count"`
		Items []apiIssue `json:"items"`
	}
	if e := decode(res, doing, &found); e != nil {
		return e
	}
	for _, a := range found.Items {
		out.Items = append(out.Items, a.item())
	}
	out.More, out.Search = found.Total > len(found.Items), true
	return nil
}

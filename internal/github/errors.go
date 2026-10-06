package github

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The kinds of failure, each with its own message and its own HTTP status on
// Caprock's side (internal/api/github.go). The interface shows every one of
// them with what was being done; none is swallowed (21-app.md principle 7).
const (
	KindNotConnected = "not_connected" // no source chosen, or it gives no token
	KindAuth         = "auth"          // 401: the token was revoked or expired
	KindScope        = "scope"         // 403: the token lacks a scope or a permission
	KindForbidden    = "forbidden"     // 403 for another reason (SSO, a blocked user)
	KindNotFound     = "not_found"     // 404: absent, or invisible to this token
	KindRateLimit    = "rate_limit"    // 403/429 with the limit spent, or a secondary limit
	KindExists       = "exists"        // 422: a pull request or repository already exists
	KindInvalid      = "invalid"       // 422 otherwise, or a bad request from us
	KindNetwork      = "network"       // GitHub could not be reached
	KindGitHub       = "github"        // 5xx, or an answer we could not read
	KindState        = "state"         // the worktree cannot do it (no branch, no remote)
	KindDisabled     = "disabled"      // device flow without a client id
)

// Error is a failed GitHub call, said so a person can act on it: what Caprock
// was doing, what GitHub answered, and when to try again.
type Error struct {
	Kind    string `json:"kind"`
	Status  int    `json:"status,omitempty"` // GitHub's HTTP status, 0 when none came back
	Doing   string `json:"doing"`            // "Creating the pull request"
	Message string `json:"message"`
	// RetryAt is when a rate limit lifts, unix ms; 0 when not limited.
	RetryAt int64 `json:"retry_at,omitempty"`
	// Needs names the scopes or fine-grained permissions GitHub asked for.
	Needs []string `json:"needs,omitempty"`
	At    int64    `json:"at"`
}

func (e *Error) Error() string {
	if e.Doing == "" {
		return e.Message
	}
	return e.Doing + ": " + e.Message
}

// errorf builds an Error that came from Caprock rather than from GitHub.
func errorf(kind, doing, format string, a ...any) *Error {
	return &Error{Kind: kind, Doing: doing, Message: fmt.Sprintf(format, a...), At: time.Now().UnixMilli()}
}

// apiMessage is GitHub's error body.
type apiMessage struct {
	Message string `json:"message"`
	Errors  []struct {
		Message  string `json:"message"`
		Code     string `json:"code"`
		Field    string `json:"field"`
		Resource string `json:"resource"`
	} `json:"errors"`
}

// text is the body's message with each listed error, as GitHub wrote them.
func (m apiMessage) text() string {
	parts := []string{}
	if m.Message != "" {
		parts = append(parts, strings.TrimSpace(m.Message))
	}
	for _, e := range m.Errors {
		switch {
		case e.Message != "":
			parts = append(parts, strings.TrimSpace(e.Message))
		case e.Code != "" && e.Field != "":
			parts = append(parts, e.Field+" "+strings.ReplaceAll(e.Code, "_", " "))
		}
	}
	return strings.Join(parts, " — ")
}

// sourceHint is what to do about a refused token, by where it came from.
func sourceHint(source string) string {
	switch source {
	case SourceGH:
		return "Run `gh auth login` in a terminal, then try again."
	case SourceOAuth:
		return "Connect GitHub again in Settings → GitHub."
	default:
		return "Paste a new token in Settings → GitHub."
	}
}

// classify turns a non-2xx answer into an Error. now is the clock the rate
// limit is measured against.
func classify(res *http.Response, body []byte, doing, source string, now time.Time) *Error {
	var m apiMessage
	_ = json.Unmarshal(body, &m)
	said := m.text()
	e := &Error{Status: res.StatusCode, Doing: doing, At: now.UnixMilli()}
	low := strings.ToLower(said)
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		e.Kind = KindAuth
		e.Message = "GitHub rejected the token (401" + suffix(said) + "): it was revoked, expired or mistyped. " + sourceHint(source)
	case rateLimited(res, low):
		e.Kind = KindRateLimit
		at := retryAt(res, now)
		e.RetryAt = at.UnixMilli()
		wait := at.Sub(now).Round(time.Second)
		e.Message = fmt.Sprintf("GitHub's rate limit was reached (%d); Caprock waits %s, until %s, before asking again.", res.StatusCode, wait, at.Local().Format("15:04:05"))
		if said != "" {
			e.Message += " GitHub said: " + said
		}
	case res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusNotFound:
		if needs, ok := missingScopes(res, low); ok {
			e.Kind = KindScope
			e.Needs = needs
			e.Message = scopeMessage(res.StatusCode, needs, said, source)
			break
		}
		if res.StatusCode == http.StatusNotFound {
			e.Kind = KindNotFound
			e.Message = "GitHub has no such thing, or this token cannot see it (404). A private repository needs the `repo` scope, or access granted to a fine-grained token."
			break
		}
		e.Kind = KindForbidden
		e.Message = "GitHub refused (403" + suffix(said) + ")."
		if strings.Contains(low, "saml") || strings.Contains(low, "sso") {
			e.Message += " The organization requires single sign-on: authorize the token for it on github.com."
		}
	case res.StatusCode == http.StatusUnprocessableEntity:
		e.Kind = KindInvalid
		if strings.Contains(low, "already exists") {
			e.Kind = KindExists
		}
		e.Message = "GitHub refused the request (422" + suffix(said) + ")."
	case res.StatusCode >= 500:
		e.Kind = KindGitHub
		e.Message = fmt.Sprintf("GitHub had a problem (%d%s); try again in a minute.", res.StatusCode, suffix(said))
	default:
		e.Kind = KindGitHub
		e.Message = fmt.Sprintf("GitHub answered %d%s.", res.StatusCode, suffix(said))
	}
	return e
}

// suffix is ": said" when GitHub said anything.
func suffix(said string) string {
	if said == "" {
		return ""
	}
	return ": " + said
}

// rateLimited reports a primary limit spent, or a secondary limit.
func rateLimited(res *http.Response, low string) bool {
	if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusTooManyRequests {
		return false
	}
	if res.StatusCode == http.StatusTooManyRequests || res.Header.Get("Retry-After") != "" {
		return true
	}
	if res.Header.Get("X-RateLimit-Remaining") == "0" {
		return true
	}
	return strings.Contains(low, "rate limit")
}

// retryAt is when to ask again: Retry-After, else the limit's reset, else a
// minute (GitHub's advice for a secondary limit that names no time).
func retryAt(res *http.Response, now time.Time) time.Time {
	if s, err := strconv.Atoi(strings.TrimSpace(res.Header.Get("Retry-After"))); err == nil && s >= 0 {
		return now.Add(time.Duration(s) * time.Second)
	}
	if res.Header.Get("X-RateLimit-Remaining") == "0" {
		if r, err := strconv.ParseInt(res.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
			if t := time.Unix(r, 0); t.After(now) {
				return t
			}
		}
	}
	return now.Add(time.Minute)
}

// missingScopes reads what a refused token lacked: the classic scopes GitHub
// accepts for the route that the token does not carry, or a fine-grained
// token's missing permissions.
func missingScopes(res *http.Response, low string) ([]string, bool) {
	if perms := res.Header.Get("X-Accepted-GitHub-Permissions"); perms != "" && strings.Contains(low, "not accessible") {
		return splitList(perms, ";"), true
	}
	accepted := splitList(res.Header.Get("X-Accepted-OAuth-Scopes"), ",")
	// A classic or OAuth token's answer carries X-OAuth-Scopes, empty for a
	// token with none; a fine-grained token's does not carry it at all.
	_, classic := res.Header[http.CanonicalHeaderKey("X-OAuth-Scopes")]
	if len(accepted) == 0 || !classic {
		return nil, strings.Contains(low, "not accessible by")
	}
	have := map[string]bool{}
	for _, s := range splitList(res.Header.Get("X-OAuth-Scopes"), ",") {
		have[s] = true
	}
	for _, s := range accepted {
		if have[s] || have[parentScope(s)] {
			return nil, false
		}
	}
	return accepted, true
}

// parentScope is the scope that implies s ("repo" for "public_repo").
func parentScope(s string) string {
	switch s {
	case "public_repo", "repo:status", "repo_deployment", "repo:invite", "security_events":
		return "repo"
	case "read:org", "write:org":
		return "admin:org"
	case "read:user", "user:email", "user:follow":
		return "user"
	}
	return ""
}

// scopeMessage says which scope or permission is missing and how to add it.
func scopeMessage(status int, needs []string, said, source string) string {
	what := "a scope this needs"
	if len(needs) > 0 {
		what = "`" + strings.Join(needs, "` or `") + "`"
	}
	msg := fmt.Sprintf("The token lacks %s (%d", what, status)
	msg += suffix(said) + "). "
	switch source {
	case SourceGH:
		scope := "repo"
		if len(needs) > 0 && !strings.Contains(needs[0], "=") {
			scope = needs[0]
		}
		msg += "Run `gh auth refresh -s " + scope + "` in a terminal, then try again."
	case SourceOAuth:
		msg += "Disconnect and connect GitHub again to grant it."
	default:
		msg += "Edit the token on github.com (Settings → Developer settings) to add it, or paste one that has it."
	}
	return msg
}

// splitList splits a header list, trimming and dropping empties.
func splitList(v, sep string) []string {
	out := []string{}
	for _, p := range strings.Split(v, sep) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

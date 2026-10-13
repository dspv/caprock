package github

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

// GitHub's own status page, for the Now screen's CI/CD section (owner,
// 2026-10-14, translated: "possible GitHub outages, or something stuck —
// all of that must be watched and caught in time"). A run stuck in a queue
// is often GitHub's, not the repository's; saying so beside it saves a hunt.
//
// One more destination of the GitHub integration (rule 4, ADR-047): asked
// only while GitHub is connected and the section is open, kept statusKept,
// with no token, no cookie and nothing about the user — the request is the
// same for everyone.
const (
	// DefaultStatusURL is the status page's public summary.
	DefaultStatusURL = "https://www.githubstatus.com/api/v2/summary.json"
	// statusKept is how long one answer is reused.
	statusKept = 5 * time.Minute
	// statusMaxBytes bounds the answer read (the summary is a few kB).
	statusMaxBytes = 1 << 20
)

// GitHubStatus is the status page's summary, cut to what the section shows.
type GitHubStatus struct {
	// Indicator is the page's own: none | minor | major | critical.
	Indicator   string `json:"indicator"`
	Description string `json:"description"`
	// Components are the ones not operational, and Actions, Pull Requests,
	// API Requests and Git Operations whatever their state, page order.
	Components []StatusComponent `json:"components"`
	// Incidents are the unresolved ones.
	Incidents []StatusIncident `json:"incidents"`
	// At is when it was read (unix ms); Error is set when the last read
	// failed and the answer is the one before, or there is none.
	At    int64  `json:"at"`
	Error string `json:"error,omitempty"`
}

// StatusComponent is one part of GitHub; Status is the page's
// operational | degraded_performance | partial_outage | major_outage |
// under_maintenance.
type StatusComponent struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// StatusIncident is one unresolved incident.
type StatusIncident struct {
	Name   string `json:"name"`
	Impact string `json:"impact,omitempty"`
	Status string `json:"status,omitempty"`
	URL    string `json:"url,omitempty"`
}

type statusCache struct {
	mu   sync.Mutex
	last GitHubStatus
	at   time.Time
}

// watchedComponents are always listed: the parts CI and pull requests use.
var watchedComponents = map[string]bool{"Actions": true, "Pull Requests": true, "API Requests": true, "Git Operations": true}

// StatusPage reads GitHub's status page summary, kept statusKept. ok is false
// while GitHub is not connected: nothing is sent then. A failed read keeps
// the last answer with Error set.
func (s *Service) StatusPage(ctx context.Context) (GitHubStatus, bool) {
	s.init()
	if s.source() == "" {
		return GitHubStatus{}, false
	}
	now := s.Now()
	s.status.mu.Lock()
	if !s.status.at.IsZero() && now.Sub(s.status.at) < statusKept {
		last := s.status.last
		s.status.mu.Unlock()
		return last, true
	}
	s.status.mu.Unlock()
	got, err := s.readStatus(ctx)
	s.status.mu.Lock()
	defer s.status.mu.Unlock()
	if err != nil {
		// Not asked again until statusKept is up: a down status page is no
		// reason to ask it every poll.
		s.status.last.Error = err.Error()
		s.status.at = now
		return s.status.last, true
	}
	got.At = now.UnixMilli()
	s.status.last, s.status.at = got, now
	return got, true
}

func (s *Service) readStatus(ctx context.Context) (GitHubStatus, error) {
	where := s.StatusURL
	if where == "" {
		where = DefaultStatusURL
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, where, nil)
	if err != nil {
		return GitHubStatus{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "caprock")
	res, err := s.HTTP.Do(req)
	if err != nil {
		return GitHubStatus{}, errorf(KindNetwork, "Reading githubstatus.com", "could not reach githubstatus.com")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return GitHubStatus{}, errorf(KindGitHub, "Reading githubstatus.com", "githubstatus.com answered %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, statusMaxBytes))
	if err != nil {
		return GitHubStatus{}, errorf(KindNetwork, "Reading githubstatus.com", "the answer was cut off")
	}
	return parseStatus(b)
}

// parseStatus cuts the status page's summary to GitHubStatus.
func parseStatus(b []byte) (GitHubStatus, error) {
	var raw struct {
		Status struct {
			Indicator   string `json:"indicator"`
			Description string `json:"description"`
		} `json:"status"`
		Components []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
			Group  bool   `json:"group"`
		} `json:"components"`
		Incidents []struct {
			Name      string `json:"name"`
			Status    string `json:"status"`
			Impact    string `json:"impact"`
			Shortlink string `json:"shortlink"`
		} `json:"incidents"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return GitHubStatus{}, errorf(KindGitHub, "Reading githubstatus.com", "the answer could not be read")
	}
	out := GitHubStatus{Indicator: raw.Status.Indicator, Description: raw.Status.Description, Components: []StatusComponent{}, Incidents: []StatusIncident{}}
	for _, c := range raw.Components {
		if c.Group || (c.Status == "operational" && !watchedComponents[c.Name]) {
			continue
		}
		out.Components = append(out.Components, StatusComponent{Name: c.Name, Status: c.Status})
	}
	for _, i := range raw.Incidents {
		if i.Status == "resolved" || i.Status == "postmortem" {
			continue
		}
		out.Incidents = append(out.Incidents, StatusIncident{Name: i.Name, Impact: i.Impact, Status: i.Status, URL: i.Shortlink})
	}
	return out, nil
}

package projects

import (
	"bufio"
	"bytes"
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// TeamSignal is how many people committed to the listed repositories lately.
//
// It exists for one card in the dashboard: Caprock for Teams is offered only
// when somebody other than the reader commits to the same code, because "your
// team runs agents too" said to a person who works alone is a claim the
// product cannot back. Only counts leave this file — no names, no addresses —
// and nothing leaves the machine (rule 4).
type TeamSignal struct {
	// Authors is the number of distinct commit authors across the listed
	// repositories in the window, bots left out.
	Authors int `json:"authors"`
	// Repos is how many repositories were read.
	Repos int `json:"repos"`
	// WindowDays is the span the count covers.
	WindowDays int `json:"window_days"`
	// CheckedMs is when the count was made; it is cached for teamSignalTTL.
	CheckedMs int64 `json:"checked_ms"`
}

const (
	teamSignalTTL   = 6 * time.Hour
	teamSignalRepos = 25   // the most repositories one count reads
	teamSignalLog   = 2000 // the most commits read per repository
)

// TeamSignal counts distinct commit authors across the listed repositories
// over the last `days` days, at most once per teamSignalTTL. A repository
// whose git fails or times out is skipped: an undercount only hides a card.
func (s *Service) TeamSignal(ctx context.Context, days int) (TeamSignal, error) {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	s.team.Lock()
	defer s.team.Unlock()
	if !s.team.at.IsZero() && now.Sub(s.team.at) < teamSignalTTL && s.team.sig.WindowDays == days {
		return s.team.sig, nil
	}
	ps, err := store.ListProjects(ctx, s.Store.DB(), false)
	if err != nil {
		return TeamSignal{}, err
	}
	var roots []string
	for _, p := range ps {
		if p.Kind == "repo" && len(roots) < teamSignalRepos {
			roots = append(roots, p.Root)
		}
	}
	timeout := s.GitTimeout
	if timeout <= 0 {
		timeout = DefaultGitTimeout
	}
	sig := countAuthors(ctx, roots, days, timeout)
	sig.CheckedMs = now.UnixMilli()
	s.team.sig, s.team.at = sig, now
	return sig, nil
}

// teamCache holds the last count; a Service field so tests do not share it.
type teamCache struct {
	sync.Mutex
	sig TeamSignal
	at  time.Time
}

// countAuthors reads `git log` in each root and counts distinct authors.
func countAuthors(ctx context.Context, roots []string, days int, timeout time.Duration) TeamSignal {
	seen := map[string]bool{}
	read := 0
	for _, root := range roots {
		out, err := runGit(ctx, timeout, root, "log", "--all", "--no-merges",
			"--since="+strconv.Itoa(days)+".days.ago", "-n", strconv.Itoa(teamSignalLog), "--format=%an%x09%ae")
		if err != nil {
			continue
		}
		read++
		for k := range parseAuthors(out) {
			seen[k] = true
		}
	}
	return TeamSignal{Authors: len(seen), Repos: read, WindowDays: days}
}

// parseAuthors reads "name<TAB>email" lines into a set of people.
//
// Keyed on the name, lower-cased: one person committing from a work and a
// personal address is still one person, and counting them twice would show
// the team card to someone who works alone. Bots are left out — a
// dependabot commit is not a colleague.
func parseAuthors(out []byte) map[string]bool {
	set := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		name, email, _ := strings.Cut(sc.Text(), "\t")
		name = strings.ToLower(strings.TrimSpace(name))
		email = strings.ToLower(strings.TrimSpace(email))
		if name == "" || isBot(name, email) {
			continue
		}
		set[name] = true
	}
	return set
}

func isBot(name, email string) bool {
	return strings.Contains(name, "[bot]") || strings.Contains(email, "[bot]") ||
		name == "github" || name == "github actions" || name == "web-flow"
}

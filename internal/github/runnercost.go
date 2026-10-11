package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/pricing"
)

// What a GitHub Actions job cost, estimated from the runner it ran on and the
// minutes it took, at the list rates in pricing/actions.json. The table is
// read from GitHub's documentation (source and date inside it); no rate is
// written anywhere in Go (rule 6, .ai/06-engineering-rules.md).

// RunnerSKU is one row of the runner rate table.
type RunnerSKU struct {
	SKU     string  `json:"sku"`
	Display string  `json:"display"`
	OS      string  `json:"os"`
	Arch    string  `json:"arch,omitempty"`
	USDMin  float64 `json:"usd_per_min"`
	Larger  bool    `json:"larger,omitempty"`
	GPU     bool    `json:"gpu,omitempty"`
}

// RunnerTable is the parsed pricing/actions.json.
type RunnerTable struct {
	Version   string            `json:"version"`
	Source    string            `json:"source"`
	FetchedAt string            `json:"fetched_at"`
	Currency  string            `json:"currency"`
	Unit      string            `json:"unit"`
	Notes     []string          `json:"notes"`
	SKUs      []RunnerSKU       `json:"skus"`
	Labels    map[string]string `json:"labels"`

	bySKU map[string]RunnerSKU
}

// ParseRunnerTable decodes and validates a runner rate table: a version,
// rows with a SKU and a non-negative rate, no SKU twice, and every label
// naming a SKU the table has.
func ParseRunnerTable(b []byte) (*RunnerTable, error) {
	var t RunnerTable
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, fmt.Errorf("parse runner rate table: %w", err)
	}
	if t.Version == "" {
		return nil, errors.New("runner rate table has no version")
	}
	if t.Unit != "per_minute" || t.Currency != "USD" {
		return nil, fmt.Errorf("runner rate table: unit %q in %q, want per_minute in USD", t.Unit, t.Currency)
	}
	if len(t.SKUs) == 0 {
		return nil, errors.New("runner rate table has no SKUs")
	}
	t.bySKU = make(map[string]RunnerSKU, len(t.SKUs))
	for _, s := range t.SKUs {
		if s.SKU == "" || s.USDMin < 0 || math.IsNaN(s.USDMin) || math.IsInf(s.USDMin, 0) {
			return nil, fmt.Errorf("runner rate table: invalid row %+v", s)
		}
		if _, dup := t.bySKU[s.SKU]; dup {
			return nil, fmt.Errorf("runner rate table: %s is listed twice", s.SKU)
		}
		t.bySKU[s.SKU] = s
	}
	for label, sku := range t.Labels {
		if _, ok := t.bySKU[sku]; !ok {
			return nil, fmt.Errorf("runner rate table: label %s names %s, which has no row", label, sku)
		}
	}
	return &t, nil
}

var (
	runnerTableOnce sync.Once
	runnerTable     *RunnerTable
	runnerTableErr  error
)

// EmbeddedRunnerTable is the table compiled into the binary, parsed once.
func EmbeddedRunnerTable() (*RunnerTable, error) {
	runnerTableOnce.Do(func() { runnerTable, runnerTableErr = ParseRunnerTable(pricing.ActionsJSON) })
	return runnerTable, runnerTableErr
}

// Why a job has no price.
const (
	UnpricedSelfHosted = "self_hosted"    // a self-hosted runner: not GitHub's minutes
	UnpricedUnknown    = "unknown_runner" // labels that name no runner the table knows
	UnpricedUnfinished = "unfinished"     // still queued or running
	UnpricedNoTable    = "no_table"       // the rate table did not load
)

// How a SKU was found.
const (
	MatchLabel = "label" // a workflow label GitHub documents
	MatchName  = "name"  // a larger runner's chosen name stating the OS and core count
)

// largerName reads a Linux or Windows larger runner's name that states the
// OS and the core count: ubuntu-latest-4-cores, linux-8-core-arm,
// windows-16-cores, ubuntu-24.04-4core-arm64.
var largerName = regexp.MustCompile(`^(ubuntu|linux|windows)(?:[a-z0-9._]*-)*?([0-9]+)-?cores?(-arm(?:64)?)?$`)

// runnerSKU finds the SKU a job ran on from its labels (and, failing those,
// its runner's name). Self-hosted wins over anything else its labels say.
// A label the table does not document, and a name that does not spell a SKU
// the table has, is unpriced — never the nearest guess.
func (t *RunnerTable) runnerSKU(labels []string, runnerName string) (RunnerSKU, string, string) {
	for _, l := range labels {
		if strings.EqualFold(strings.TrimSpace(l), "self-hosted") {
			return RunnerSKU{}, "", UnpricedSelfHosted
		}
	}
	for _, l := range labels {
		if sku, ok := t.Labels[strings.ToLower(strings.TrimSpace(l))]; ok {
			return t.bySKU[sku], MatchLabel, ""
		}
	}
	for _, l := range append(append([]string{}, labels...), runnerName) {
		if s, ok := t.byLargerName(l); ok {
			return s, MatchName, ""
		}
	}
	return RunnerSKU{}, "", UnpricedUnknown
}

func (t *RunnerTable) byLargerName(name string) (RunnerSKU, bool) {
	m := largerName.FindStringSubmatch(strings.ToLower(strings.TrimSpace(name)))
	if m == nil {
		return RunnerSKU{}, false
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return RunnerSKU{}, false
	}
	os := "linux"
	if m[1] == "windows" {
		os = "windows"
	}
	sku := fmt.Sprintf("%s_%d_core", os, n)
	if m[3] != "" {
		sku += "_arm"
	}
	s, ok := t.bySKU[sku]
	if !ok || !s.Larger {
		return RunnerSKU{}, false
	}
	return s, true
}

// RunnerCost is what one job cost: its SKU, the minutes GitHub bills (each
// job rounded up to the whole minute), and the dollars at the SKU's list rate.
// FreePublic: a standard runner in a public repository, which GitHub does not
// charge — USD is 0 and MinutesBilled says what it would have counted. The
// figure is before a private repository's included minutes: an estimate.
type RunnerCost struct {
	Priced bool `json:"priced"`
	// Reason says why a job is not priced: self_hosted, unknown_runner,
	// unfinished or no_table.
	Reason        string  `json:"reason,omitempty"`
	SKU           string  `json:"sku,omitempty"`
	Display       string  `json:"display,omitempty"`
	Match         string  `json:"match,omitempty"` // label | name
	Larger        bool    `json:"larger,omitempty"`
	RateUSD       float64 `json:"rate_usd_per_min,omitempty"`
	MinutesBilled int64   `json:"minutes_billed"`
	USD           float64 `json:"usd"`
	FreePublic    bool    `json:"free_public"`
}

// billedMinutes is a job's duration rounded up to the whole minute, as
// GitHub bills it; 0 for a job that took no time.
func billedMinutes(ms int64) int64 {
	if ms <= 0 {
		return 0
	}
	return (ms + 59_999) / 60_000
}

// usd rounds to a millionth of a dollar, so sums of rates read cleanly.
func usd(v float64) float64 { return math.Round(v*1e6) / 1e6 }

// Repository visibility as far as Caprock knows it.
const (
	VisibilityPublic  = "public"
	VisibilityPrivate = "private"
	VisibilityUnknown = "unknown"
)

// Cost prices one job. visibility is the repository's (public | private |
// unknown); an unknown one is priced as private, at the list rate, and the
// sum says it was unknown.
func (t *RunnerTable) Cost(job CIJob, visibility string) RunnerCost {
	if t == nil {
		if job.Status != "completed" {
			return RunnerCost{Reason: UnpricedUnfinished}
		}
		return RunnerCost{Reason: UnpricedNoTable, MinutesBilled: billedMinutes(job.DurationMS)}
	}
	s, match, why := t.runnerSKU(job.Labels, job.RunnerName)
	out := RunnerCost{SKU: s.SKU, Display: s.Display, Match: match, Larger: s.Larger, RateUSD: s.USDMin, MinutesBilled: billedMinutes(job.DurationMS)}
	if job.Status != "completed" {
		out.Reason = UnpricedUnfinished
	} else if why != "" {
		out.Reason = why
	}
	if out.Reason != "" {
		return out
	}
	out.Priced = true
	if visibility == VisibilityPublic && !s.Larger {
		out.FreePublic = true
		return out
	}
	out.USD = usd(s.USDMin * float64(out.MinutesBilled))
	return out
}

// CICost is the sum over a run's, or a commit's, finished jobs.
type CICost struct {
	USD float64 `json:"usd"`
	// MinutesBilled sums the priced jobs GitHub charges for; FreeMinutes the
	// standard-runner minutes of a public repository; UnpricedMinutes those
	// of finished jobs with no price (self-hosted, unknown runner).
	MinutesBilled   int64 `json:"minutes_billed"`
	FreeMinutes     int64 `json:"free_minutes"`
	UnpricedMinutes int64 `json:"unpriced_minutes"`
	PricedJobs      int   `json:"priced_jobs"`
	UnpricedJobs    int   `json:"unpriced_jobs"`
	UnfinishedJobs  int   `json:"unfinished_jobs"`
	// Partial is true when a job is unfinished or could not be priced: the
	// sum is less than the run will cost.
	Partial      bool   `json:"partial"`
	Visibility   string `json:"visibility"`
	TableVersion string `json:"table_version,omitempty"`
}

func (c *CICost) add(j RunnerCost) {
	switch {
	case j.Reason == UnpricedUnfinished:
		c.UnfinishedJobs++
		c.Partial = true
	case !j.Priced:
		if j.MinutesBilled > 0 {
			c.UnpricedJobs++
			c.UnpricedMinutes += j.MinutesBilled
			c.Partial = true
		}
	case j.FreePublic:
		c.PricedJobs++
		c.FreeMinutes += j.MinutesBilled
	default:
		c.PricedJobs++
		c.MinutesBilled += j.MinutesBilled
		c.USD = usd(c.USD + j.USD)
	}
}

func (c *CICost) merge(o *CICost) {
	if o == nil {
		return
	}
	c.USD = usd(c.USD + o.USD)
	c.MinutesBilled += o.MinutesBilled
	c.FreeMinutes += o.FreeMinutes
	c.UnpricedMinutes += o.UnpricedMinutes
	c.PricedJobs += o.PricedJobs
	c.UnpricedJobs += o.UnpricedJobs
	c.UnfinishedJobs += o.UnfinishedJobs
	c.Partial = c.Partial || o.Partial
}

// PriceRuns sets each job's Cost and each run's sum, and returns the sum
// over all of them (a commit's — for a pull request, its head commit's).
func (t *RunnerTable) PriceRuns(runs []CIRun, visibility string) *CICost {
	if visibility == "" {
		visibility = VisibilityUnknown
	}
	version := ""
	if t != nil {
		version = t.Version
	}
	total := &CICost{Visibility: visibility, TableVersion: version}
	for i := range runs {
		sum := &CICost{Visibility: visibility, TableVersion: version}
		for k := range runs[i].Jobs {
			c := t.Cost(runs[i].Jobs[k], visibility)
			runs[i].Jobs[k].Cost = &c
			sum.add(c)
		}
		runs[i].Cost = sum
		total.merge(sum)
	}
	return total
}

// visibilityKept is how long an unreadable repository's visibility is not
// asked again; a read one is kept with the default branch (defaultKept).
const visibilityKept = 10 * time.Minute

// RepoVisibility is public or private as GitHub reports the repository
// (GET /repos/{o}/{r}, the read DefaultBranch makes and keeps), or unknown
// when it could not be read — asked again after visibilityKept, not on every
// CI read.
func (s *Service) RepoVisibility(ctx context.Context, repo Repo) string {
	s.init()
	key := repo.FullName()
	now := s.Now()
	s.repoCI.mu.Lock()
	s.repoCI.lazy()
	d, have := s.repoCI.defaults[key]
	failAt, failed := s.repoCI.visFail[key]
	s.repoCI.mu.Unlock()
	if have && now.Sub(d.at) < defaultKept {
		return d.visibility
	}
	if failed && now.Sub(failAt) < visibilityKept {
		return VisibilityUnknown
	}
	d, e := s.readRepoMeta(ctx, repo, "Reading the visibility of "+repo.FullName())
	if e != nil {
		s.repoCI.mu.Lock()
		bound(s.repoCI.visFail, key, func(v time.Time) time.Time { return v })
		s.repoCI.visFail[key] = now
		s.repoCI.mu.Unlock()
		return VisibilityUnknown
	}
	return d.visibility
}

// priceCI prices a CI answer's runs at the repository's visibility.
func (s *Service) priceCI(ctx context.Context, repo Repo, runs []CIRun) *CICost {
	t, err := EmbeddedRunnerTable()
	if err != nil {
		t = nil
	}
	return t.PriceRuns(runs, s.RepoVisibility(ctx, repo))
}

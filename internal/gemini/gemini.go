// Package gemini talks to Google's Gemini API on a key the user supplies
// through the environment.
//
// Caprock never stores that key. It is read from GEMINI_API_KEY at the moment
// of the call, never written to config.json, never accepted by PUT /v1/settings
// and never returned by GET /v1/settings — see ADR-023. The objection this
// answers is recorded in .ai/17-teams.md: a bug in a tool that holds no
// credential cannot leak one.
//
// This is the second outbound call in the product, after the release check, and
// the first that carries user content. Nothing here runs on a timer or in the
// background: a request leaves only when a person asked a question in that turn.
package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Agent is the value the sessions table carries for Gemini work, alongside
// "claude" and "opencode".
const Agent = "gemini"

// EnvKey is the variable the key is read from. The name matches what Google's
// own tooling uses, so a machine already set up for Gemini needs no new setup.
const EnvKey = "GEMINI_API_KEY"

// Endpoint is the only host this package ever contacts.
const Endpoint = "https://generativelanguage.googleapis.com/v1beta"

// DefaultModel is what a request without a model uses: the cheapest current
// Flash tier, because the common use is a question about the user's own
// sessions rather than deep reasoning, and it is their money.
const DefaultModel = "gemini-3.5-flash-lite"

// ErrNoKey means the environment holds no key, which is also how the feature
// stays off: with nothing set there is no default-on path to disable.
var ErrNoKey = errors.New("no " + EnvKey + " in the environment")

// Key returns the key from the environment, trimmed. Empty means absent —
// callers must treat that as "the feature does not exist here", not as an error
// to report.
func Key() string { return strings.TrimSpace(os.Getenv(EnvKey)) }

// Available reports whether a key is present at all.
func Available() bool { return Key() != "" }

// Client calls the API. The zero value is usable.
type Client struct {
	HTTP *http.Client
	// Base overrides the endpoint in tests. Empty means Endpoint.
	Base string
	// Now is injectable so timings are deterministic under test.
	Now func() time.Time
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	// A generous but bounded timeout: a long answer on a slow line is normal,
	// a hung connection holding a handler open is not.
	return &http.Client{Timeout: 120 * time.Second}
}

func (c *Client) base() string {
	if c.Base != "" {
		return c.Base
	}
	return Endpoint
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Usage is what the response says it cost, in tokens. These are the figures
// Caprock prices; there is no per-key billing API to reconcile them against
// (Google reports per project), so the total is what Caprock sent rather than
// what Google billed, and the UI says so.
type Usage struct {
	PromptTokens   int64 `json:"prompt_tokens"`
	OutputTokens   int64 `json:"output_tokens"`
	CachedTokens   int64 `json:"cached_tokens"`
	ThoughtsTokens int64 `json:"thoughts_tokens"`
	TotalTokens    int64 `json:"total_tokens"`
}

// Reply is one answer plus what it cost.
type Reply struct {
	Text    string        `json:"text"`
	Model   string        `json:"model"`
	Usage   Usage         `json:"usage"`
	Elapsed time.Duration `json:"-"`
}

// wire types: only the fields this package reads. Google adds fields freely and
// unknown ones must stay ignorable.
type genReq struct {
	Contents []wireContent `json:"contents"`
	System   *wireContent  `json:"systemInstruction,omitempty"`
}

type wireContent struct {
	Role  string     `json:"role,omitempty"`
	Parts []wirePart `json:"parts"`
}

type wirePart struct {
	Text string `json:"text"`
}

type genResp struct {
	Candidates []struct {
		Content      wireContent `json:"content"`
		FinishReason string      `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount        int64 `json:"promptTokenCount"`
		CandidatesTokenCount    int64 `json:"candidatesTokenCount"`
		CachedContentTokenCount int64 `json:"cachedContentTokenCount"`
		ThoughtsTokenCount      int64 `json:"thoughtsTokenCount"`
		TotalTokenCount         int64 `json:"totalTokenCount"`
	} `json:"usageMetadata"`
	Error *wireError `json:"error"`
}

type wireError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Status  string `json:"status"`
}

func (e *wireError) Error() string {
	if e.Status != "" {
		return fmt.Sprintf("gemini: %s (%d): %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("gemini: %d: %s", e.Code, e.Message)
}

// MaxBody bounds what is read back. A runaway response must not become a
// runaway allocation in a daemon that is meant to sit quietly.
const MaxBody = 8 << 20

// Ask sends one prompt and returns the answer. system may be empty.
func (c *Client) Ask(ctx context.Context, model, system, prompt string) (*Reply, error) {
	key := Key()
	if key == "" {
		return nil, ErrNoKey
	}
	if strings.TrimSpace(prompt) == "" {
		return nil, errors.New("empty prompt")
	}
	if model == "" {
		model = DefaultModel
	}

	body := genReq{Contents: []wireContent{{Role: "user", Parts: []wirePart{{Text: prompt}}}}}
	if s := strings.TrimSpace(system); s != "" {
		body.System = &wireContent{Parts: []wirePart{{Text: s}}}
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/models/%s:generateContent", c.base(), model)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// The key rides in a header rather than the query string, so it cannot be
	// captured by anything that logs URLs.
	req.Header.Set("x-goog-api-key", key)

	start := c.now()
	res, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("gemini request: %w", err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, MaxBody))
	if err != nil {
		return nil, fmt.Errorf("gemini read: %w", err)
	}

	var out genResp
	if err := json.Unmarshal(raw, &out); err != nil {
		// A non-JSON body on a bad status is more useful reported as the status.
		if res.StatusCode >= 400 {
			return nil, fmt.Errorf("gemini: http %d", res.StatusCode)
		}
		return nil, fmt.Errorf("gemini decode: %w", err)
	}
	if out.Error != nil {
		return nil, out.Error
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("gemini: http %d", res.StatusCode)
	}
	if len(out.Candidates) == 0 {
		return nil, errors.New("gemini returned no answer")
	}

	var sb strings.Builder
	for _, p := range out.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}

	u := out.UsageMetadata
	return &Reply{
		Text:  sb.String(),
		Model: model,
		Usage: Usage{
			PromptTokens:   u.PromptTokenCount,
			OutputTokens:   u.CandidatesTokenCount,
			CachedTokens:   u.CachedContentTokenCount,
			ThoughtsTokens: u.ThoughtsTokenCount,
			TotalTokens:    u.TotalTokenCount,
		},
		Elapsed: c.now().Sub(start),
	}, nil
}

// Check verifies the key by listing models. It is the cheapest call that
// proves the key works, and it sends no user content.
func (c *Client) Check(ctx context.Context) ([]string, error) {
	key := Key()
	if key == "" {
		return nil, ErrNoKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+"/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-goog-api-key", key)
	res, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("gemini request: %w", err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, MaxBody))
	if err != nil {
		return nil, err
	}
	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
		Error *wireError `json:"error"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("gemini: http %d", res.StatusCode)
	}
	if out.Error != nil {
		return nil, out.Error
	}
	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		names = append(names, strings.TrimPrefix(m.Name, "models/"))
	}
	return names, nil
}

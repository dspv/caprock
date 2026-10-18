package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// ErrNotRunning is every tool's answer while no daemon is up: the agent
// should tell the user, not retry.
var ErrNotRunning = errors.New("caprock is not running on this computer: start it with `caprock up`, or open the Caprock app, then ask again")

// Client reads the local daemon's API. Only GET is offered: a tool cannot
// reach an endpoint that changes anything, whatever its arguments say.
type Client struct {
	// Base returns the daemon's origin ("http://127.0.0.1:22776"). Read on
	// every call, so a daemon started or restarted after the agent is found.
	Base func() (string, error)
	HTTP *http.Client
}

// RuntimeBase is the daemon's origin from <data_dir>/runtime.json: always
// the loopback address, whatever else the daemon listens on.
func RuntimeBase(dataDir func() (string, error)) func() (string, error) {
	return func() (string, error) {
		dir, err := dataDir()
		if err != nil {
			return "", ErrNotRunning
		}
		rt, err := config.ReadRuntime(dir)
		if err != nil || rt.Port <= 0 {
			return "", ErrNotRunning
		}
		return fmt.Sprintf("http://127.0.0.1:%d", rt.Port), nil
	}
}

// maxBody bounds a daemon answer read into memory.
const maxBody = 32 << 20

// get reads path?q into v. A 4xx is the daemon's own message.
func (c *Client) get(ctx context.Context, path string, q url.Values, v any) error {
	base, err := c.Base()
	if err != nil {
		return err
	}
	if strings.HasPrefix(path, "/v1/brain") {
		if q == nil {
			q = url.Values{}
		}
		q.Set("agents", "1")
	}
	u := base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrNotRunning
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(body))
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		if resp.StatusCode == http.StatusNotFound {
			return fmt.Errorf("not found: %s", clipRunes(msg, 200))
		}
		return fmt.Errorf("caprock answered %s: %s", resp.Status, clipRunes(msg, 200))
	}
	return json.Unmarshal(body, v)
}

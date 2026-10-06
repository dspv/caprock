package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The OAuth device flow (RFC 8628 as GitHub runs it): Caprock asks github.com
// for a code, the user types it at github.com/login/device, and Caprock polls
// until GitHub hands over a token. No client secret is involved, so nothing
// secret ships in the binary; the client id is public. Offered only when a
// client id is configured (config.json `github_client_id`), because no
// Caprock OAuth app is registered yet (docs/app.md § GitHub).

// DeviceScopes are what the device flow asks for: private repositories and
// pull requests, and the organizations the user belongs to.
const DeviceScopes = "repo read:org"

// Device is the device flow's state, as Settings shows it.
type Device struct {
	State           string `json:"state"` // pending | done | denied | expired | error
	UserCode        string `json:"user_code,omitempty"`
	VerificationURI string `json:"verification_uri,omitempty"`
	ExpiresAt       int64  `json:"expires_at,omitempty"` // unix ms
	Interval        int    `json:"interval,omitempty"`   // seconds between polls
	Error           *Error `json:"error,omitempty"`
}

// deviceCode is GitHub's first answer.
type deviceCode struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	Error           string `json:"error"`
	ErrorDesc       string `json:"error_description"`
}

// tokenAnswer is GitHub's answer to a poll.
type tokenAnswer struct {
	AccessToken string `json:"access_token"`
	Scope       string `json:"scope"`
	Error       string `json:"error"`
	ErrorDesc   string `json:"error_description"`
	Interval    int    `json:"interval"`
}

// postForm sends a form to github.com and decodes the JSON answer.
func postForm(ctx context.Context, hc *http.Client, u string, form url.Values, doing string, v any) *Error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(form.Encode()))
	if err != nil {
		return errorf(KindInvalid, doing, "bad request: %v", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "caprock")
	res, err := hc.Do(req)
	if err != nil {
		return errorf(KindNetwork, doing, "could not reach GitHub (%s): %s", hostOf(u), netReason(err))
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return errorf(KindInvalid, doing, "GitHub does not know this client id (404); check github_client_id in config.json")
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return classify(res, b, doing, SourceOAuth, time.Now())
	}
	if err := json.Unmarshal(b, v); err != nil {
		return errorf(KindGitHub, doing, "GitHub's answer could not be read: %v", err)
	}
	return nil
}

// deviceError explains a device-flow error code.
func deviceError(code, desc string) (state string, e *Error) {
	const doing = "Connecting GitHub"
	switch code {
	case "expired_token":
		return "expired", errorf(KindAuth, doing, "the code expired before it was entered; start again")
	case "access_denied":
		return "denied", errorf(KindAuth, doing, "access was denied on github.com")
	case "device_flow_disabled":
		return "error", errorf(KindDisabled, doing, "the OAuth app has the device flow switched off; enable it in the app's settings on github.com")
	case "incorrect_client_credentials":
		return "error", errorf(KindInvalid, doing, "GitHub does not know this client id; check github_client_id in config.json")
	}
	msg := code
	if desc != "" {
		msg += ": " + desc
	}
	return "error", errorf(KindGitHub, doing, "GitHub said %s", msg)
}

// pollDevice waits for the user to enter the code. It returns the token, or
// the state and error that ended the wait.
func pollDevice(ctx context.Context, hc *http.Client, web, clientID string, dc deviceCode, sleep func(context.Context, time.Duration) bool) (string, string, *Error) {
	interval := time.Duration(max(dc.Interval, 5)) * time.Second
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	form := url.Values{"client_id": {clientID}, "device_code": {dc.DeviceCode}, "grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}}
	for {
		if !sleep(ctx, interval) {
			return "", "error", errorf(KindState, "Connecting GitHub", "cancelled")
		}
		if dc.ExpiresIn > 0 && time.Now().After(deadline) {
			s, e := deviceError("expired_token", "")
			return "", s, e
		}
		var a tokenAnswer
		if e := postForm(ctx, hc, web+"/login/oauth/access_token", form, "Connecting GitHub", &a); e != nil {
			if e.Kind == KindNetwork {
				continue // a dropped connection mid-wait is retried, not fatal
			}
			return "", "error", e
		}
		switch a.Error {
		case "":
			if a.AccessToken == "" {
				return "", "error", errorf(KindGitHub, "Connecting GitHub", "GitHub answered without a token")
			}
			return a.AccessToken, "done", nil
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
			if a.Interval > 0 {
				interval = time.Duration(a.Interval) * time.Second
			}
		default:
			s, e := deviceError(a.Error, a.ErrorDesc)
			return "", s, e
		}
	}
}

// sleepCtx waits d or until ctx ends; false when it ended.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// startDevice asks github.com for a user code.
func startDevice(ctx context.Context, hc *http.Client, web, clientID string) (deviceCode, *Error) {
	var dc deviceCode
	form := url.Values{"client_id": {clientID}, "scope": {DeviceScopes}}
	if e := postForm(ctx, hc, web+"/login/device/code", form, "Starting the GitHub sign-in", &dc); e != nil {
		return dc, e
	}
	if dc.Error != "" {
		_, e := deviceError(dc.Error, dc.ErrorDesc)
		return dc, e
	}
	if dc.DeviceCode == "" || dc.UserCode == "" {
		return dc, errorf(KindGitHub, "Starting the GitHub sign-in", "GitHub answered without a code")
	}
	if dc.VerificationURI == "" {
		dc.VerificationURI = web + "/login/device"
	}
	return dc, nil
}

// String keeps a device code out of a log line by accident.
func (dc deviceCode) String() string { return fmt.Sprintf("device code for %s", dc.VerificationURI) }

package telegram

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Poller reads updates with getUpdates long polling: the daemon asks Telegram,
// so nothing on this machine listens for Telegram (rule 4 — loopback only).
type Poller struct {
	Client *Client
	// Wait is how long one getUpdates call holds; 0 is 25 seconds.
	Wait time.Duration
	// MinBackoff and MaxBackoff bound the wait after a failure; 0 is 1s and
	// a minute. Offline, the poller retries at the slow end forever.
	MinBackoff, MaxBackoff time.Duration
	// OnError hears every failure (scrubbed of the token), and nil when a
	// call succeeds again, so a screen can show "no network" and clear it.
	OnError func(error)
}

// ErrStopped is Run's result when the token was refused: polling with a
// revoked token only fills the log, so the poller gives up.
var ErrStopped = errors.New("telegram: the bot token was refused")

// Run polls until ctx ends, handle returns true, or the token is refused. It
// returns the offset after the last update handled, so a later poll does not
// see the same updates again.
func (p *Poller) Run(ctx context.Context, offset int64, handle func(Update) bool) (int64, error) {
	wait := p.Wait
	if wait <= 0 {
		wait = 25 * time.Second
	}
	minB, maxB := p.MinBackoff, p.MaxBackoff
	if minB <= 0 {
		minB = time.Second
	}
	if maxB <= 0 {
		maxB = time.Minute
	}
	backoff := minB
	failing := false
	for ctx.Err() == nil {
		ups, err := p.Client.GetUpdates(ctx, offset, wait)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			if p.OnError != nil {
				p.OnError(err)
			}
			failing = true
			if Unauthorized(err) {
				return offset, ErrStopped
			}
			d := backoff
			var ae *APIError
			if errors.As(err, &ae) && ae.Code == http.StatusTooManyRequests && ae.RetryAfter > 0 {
				d = ae.RetryAfter
			}
			if !sleep(ctx, d) {
				break
			}
			backoff = min(backoff*2, maxB)
			continue
		}
		if failing {
			failing = false
			if p.OnError != nil {
				p.OnError(nil)
			}
		}
		backoff = minB
		for _, u := range ups {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			if handle(u) {
				return offset, nil
			}
		}
	}
	return offset, ctx.Err()
}

// Confirm tells Telegram the updates below offset were read, so they are not
// delivered again to the next poll (a phase 2 poller would otherwise replay
// the pairing message). Best effort.
func Confirm(ctx context.Context, c *Client, offset int64) {
	if offset <= 0 {
		return
	}
	_, _ = c.GetUpdates(ctx, offset, 0)
}

// CodeDigits is the length of a pairing code.
const CodeDigits = 6

// NewCode returns a random pairing code of CodeDigits digits.
func NewCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// codeShaped is a message that is an attempt at a code: "/start 123456",
// "/start@somebot 123456", or the six digits alone.
var codeShaped = regexp.MustCompile(`^(?:/start(?:@[A-Za-z0-9_]+)?\s+)?(\d{6})$`)

// PairAttempt reads a message as an attempt to pair. ok says it was one at
// all (code-shaped); match says it carried this code. Only a message — not an
// edit, a channel post or a button — can pair, and a bot cannot pair itself.
func PairAttempt(u Update, code string) (chat Chat, ok, match bool) {
	m := u.Message
	if m == nil || (m.From != nil && m.From.IsBot) {
		return Chat{}, false, false
	}
	sub := codeShaped.FindStringSubmatch(strings.TrimSpace(m.Text))
	if sub == nil {
		return m.Chat, false, false
	}
	return m.Chat, true, code != "" && sub[1] == code
}

// StartLink is the t.me link that opens the bot and sends "/start <code>" in
// one tap.
func StartLink(bot, code string) string {
	if bot == "" {
		return ""
	}
	return "https://t.me/" + strings.TrimPrefix(bot, "@") + "?start=" + code
}

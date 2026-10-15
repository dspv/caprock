package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AnthropicURL is the Messages API's base.
const AnthropicURL = "https://api.anthropic.com/v1"

// Anthropic calls the Messages API with the user's API key. Raw net/http,
// like the OpenAI-compatible client beside it: one POST does not earn the
// SDK's weight in a binary whose lightness is the point.
type Anthropic struct {
	URL   string // "" is AnthropicURL; tests point it at a fake
	Key   string
	Model string
	HTTP  *http.Client
}

// Chat sends one system and one user message and returns the text reply.
func (a *Anthropic) Chat(ctx context.Context, system, user string) (string, error) {
	if a.Key == "" {
		return "", errors.New("no Anthropic API key; add one in Mail settings")
	}
	model := a.Model
	if model == "" {
		model = DefaultModel(ProviderAnthropic)
	}
	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"max_tokens": 4000,
		"system":     system,
		"messages":   []map[string]string{{"role": "user", "content": user}},
	})
	base := strings.TrimRight(a.URL, "/")
	if base == "" {
		base = AnthropicURL
	}
	req, _ := http.NewRequestWithContext(ctx, "POST", base+"/messages", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", a.Key)
	req.Header.Set("anthropic-version", "2023-06-01")
	hc := a.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 3 * time.Minute}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach api.anthropic.com: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Error      struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode != 200 {
		msg := out.Error.Message
		if msg == "" {
			msg = clip(strings.TrimSpace(string(raw)), 300)
		}
		return "", fmt.Errorf("the Anthropic API answered %s: %s", resp.Status, msg)
	}
	if out.StopReason == "refusal" {
		return "", errors.New("the model declined this request")
	}
	var b strings.Builder
	for _, c := range out.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	if strings.TrimSpace(b.String()) == "" {
		return "", errors.New("model returned nothing")
	}
	return strings.TrimSpace(b.String()), nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

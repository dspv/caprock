// Package ai talks to a local model through the OpenAI-compatible API that
// Ollama, LM Studio and llama.cpp all serve. Mail never leaves the machine
// unless the user points the URL elsewhere.
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

// DefaultURL is Ollama's OpenAI-compatible endpoint.
const DefaultURL = "http://127.0.0.1:11434/v1"

// Client is a chat-completions client.
type Client struct {
	URL   string
	Model string
	HTTP  *http.Client
}

// ErrUnavailable means no model server answered.
var ErrUnavailable = errors.New("no local model server is running")

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 3 * time.Minute}
}

func (c *Client) base() string {
	u := strings.TrimRight(c.URL, "/")
	if u == "" {
		u = DefaultURL
	}
	return u
}

// Models lists the models the server offers.
func (c *Client) Models(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", c.base()+"/models", nil)
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("models: %s", resp.Status)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	names := []string{}
	for _, d := range out.Data {
		if !strings.Contains(d.ID, "embed") {
			names = append(names, d.ID)
		}
	}
	return names, nil
}

func (c *Client) model(ctx context.Context) (string, error) {
	if c.Model != "" {
		return c.Model, nil
	}
	ms, err := c.Models(ctx)
	if err != nil {
		return "", err
	}
	if len(ms) == 0 {
		return "", errors.New("the model server has no models; pull one, e.g. `ollama pull qwen3:8b`")
	}
	return ms[0], nil
}

// Chat sends one system and one user message and returns the reply.
func (c *Client) Chat(ctx context.Context, system, user string) (string, error) {
	model, err := c.model(ctx)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature": 0.3,
		"stream":      false,
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", c.base()+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return "", ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return "", fmt.Errorf("model server: %s %s", resp.Status, strings.TrimSpace(string(b)))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", errors.New("model returned nothing")
	}
	return stripThinking(out.Choices[0].Message.Content), nil
}

// stripThinking removes the <think> block reasoning models prepend.
func stripThinking(s string) string {
	if i := strings.Index(s, "</think>"); i >= 0 && strings.HasPrefix(strings.TrimSpace(s), "<think>") {
		s = s[i+len("</think>"):]
	}
	return strings.TrimSpace(s)
}

// Mail is the text of one message given to the model.
type Mail struct {
	From, Date, Subject, Body string
}

func render(thread []Mail, budget int) string {
	var b strings.Builder
	// Newest messages matter most; trim from the oldest.
	per := budget / max(len(thread), 1)
	for _, m := range thread {
		body := m.Body
		if r := []rune(body); len(r) > per {
			body = string(r[:per]) + "…"
		}
		fmt.Fprintf(&b, "From: %s\nDate: %s\nSubject: %s\n\n%s\n\n---\n\n", m.From, m.Date, m.Subject, body)
	}
	return b.String()
}

// Summarize writes a short summary of a thread with what is asked of the reader.
func (c *Client) Summarize(ctx context.Context, thread []Mail) (string, error) {
	sys := "You summarise email for a busy reader. Answer in the language of the email. " +
		"Give 1-3 short bullet points of what matters, then a line starting with 'Action:' saying what, if anything, the reader is asked to do and by when. " +
		"No preamble."
	return c.Chat(ctx, sys, render(thread, 12000))
}

// DraftReply writes a reply to the last message of a thread.
func (c *Client) DraftReply(ctx context.Context, thread []Mail, me, instruction string) (string, error) {
	sys := "You draft email replies for " + me + ". Write only the reply body: no subject, no quoted text, no placeholders like [Name]. " +
		"Match the language and tone of the thread. Be brief and concrete. Sign off with the sender's first name if it is known."
	user := render(thread, 12000)
	if strings.TrimSpace(instruction) != "" {
		user += "\nWhat the reply should say: " + instruction
	} else {
		user += "\nWrite a sensible reply to the last message."
	}
	return c.Chat(ctx, sys, user)
}

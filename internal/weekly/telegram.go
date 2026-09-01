package weekly

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// TelegramAPI is the only host this package ever contacts.
const TelegramAPI = "https://api.telegram.org"

// Sender delivers a finished report. The zero value is usable.
//
// This is the product's first *background* outbound call — the release check
// and Gemini both fire because a person did something in that moment. What
// keeps it inside rule 4 is what it carries and what turns it on: figures the
// user already sees on their own dashboard, never a prompt, a reply, a tool
// result or a file path, and only once they have configured a bot of their own.
// With no token there is no timer and nothing to switch off.
type Sender struct {
	HTTP *http.Client
	// Base overrides the API host in tests.
	Base string
}

func (s *Sender) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (s *Sender) base() string {
	if s.Base != "" {
		return s.Base
	}
	return TelegramAPI
}

// Send posts one message. token and chat are the user's own bot and chat.
func (s *Sender) Send(ctx context.Context, token, chat, text string) error {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(chat) == "" {
		return fmt.Errorf("telegram: not configured")
	}
	body, err := json.Marshal(map[string]any{
		"chat_id": chat,
		"text":    text,
		// No parse mode: Markdown would need every repository name escaped, and
		// a name with an underscore in it would either break the message or
		// silently italicise half of it. Plain text always renders.
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/bot%s/sendMessage", s.base(), token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "caprock")

	res, err := s.client().Do(req)
	if err != nil {
		return fmt.Errorf("telegram: %w", err)
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(raw, &out)
	if !out.OK {
		// Telegram's own words are more useful than ours: "chat not found" and
		// "bot was blocked by the user" are both things only the user can fix,
		// and both are worth reading verbatim.
		if out.Description != "" {
			return fmt.Errorf("telegram: %s", out.Description)
		}
		return fmt.Errorf("telegram: http %d", res.StatusCode)
	}
	return nil
}

// Message renders a report as the text of one Telegram message.
//
// Plain prose, not a table: a phone is narrow, and a column layout that wraps
// is harder to read than a sentence. The first line is the whole claim, so a
// notification preview carries the point without being opened.
func Message(r Report, basis string) string {
	var b strings.Builder
	span := fmt.Sprintf("%s – %s",
		r.WeekStart.Format("2 Jan"), r.WeekEnd.AddDate(0, 0, -1).Format("2 Jan"))

	if r.NoData {
		fmt.Fprintf(&b, "Caprock · %s\n\nNothing ran this week.", span)
		return b.String()
	}

	fmt.Fprintf(&b, "Caprock · %s\n%s", span, money(r.CostUSD))
	if r.PriorUSD > 0 {
		switch {
		case r.CostUSD > r.PriorUSD*1.15:
			fmt.Fprintf(&b, ", up from a usual %s", money(r.PriorUSD))
		case r.CostUSD < r.PriorUSD*0.85:
			fmt.Fprintf(&b, ", down from a usual %s", money(r.PriorUSD))
		default:
			fmt.Fprintf(&b, ", about usual")
		}
	}
	b.WriteString("\n")

	if r.Quiet {
		// Saying the week was ordinary is information. A message that lists
		// nothing reads as a broken report.
		b.WriteString("\nNothing moved much this week.\n")
	} else {
		b.WriteString("\nWhat moved:\n")
		for i, m := range r.Movers {
			if i >= 3 {
				break
			}
			if m.New {
				fmt.Fprintf(&b, "• %s — %s, new this week\n", m.Project, money(m.ThisUSD))
				continue
			}
			fmt.Fprintf(&b, "• %s — %s, %.1f× its usual %s\n",
				m.Project, money(m.ThisUSD), m.Multiple, money(m.UsualUSD))
		}
	}

	if len(r.Projects) > 0 {
		b.WriteString("\nWhere it went:\n")
		for i, p := range r.Projects {
			if i >= 5 {
				break
			}
			fmt.Fprintf(&b, "• %s — %s\n", p.Project, money(p.CostUSD))
		}
	}

	// The basis travels with the figures, in the message rather than only on
	// the screen the reader is not looking at (rule 6).
	if basis != "" {
		fmt.Fprintf(&b, "\n%s", basis)
	}
	return b.String()
}

func money(v float64) string {
	if v >= 100 {
		return fmt.Sprintf("$%.0f", v)
	}
	return fmt.Sprintf("$%.2f", v)
}

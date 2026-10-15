package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
)

// Triage categories: a small fixed set. Whatever the model answers is checked
// against it; anything else is dropped.
const (
	CatImportant  = "important"  // a person wrote and it needs attention
	CatUpdates    = "updates"    // notifications, receipts, bookings, CI
	CatNewsletter = "newsletter" // marketing, promotions, digests
	CatSpam       = "spam"       // likely spam or phishing
)

// Categories is every category, in the order the inbox filters show them.
var Categories = []string{CatImportant, CatUpdates, CatNewsletter, CatSpam}

// ValidCategory reports whether c is one of Categories.
func ValidCategory(c string) bool {
	for _, x := range Categories {
		if x == c {
			return true
		}
	}
	return false
}

// Languages are the languages the user can ask Mail's AI to write in
// (setting ai_language); "auto" is the email's own language.
var Languages = map[string]string{"en": "English", "ru": "Russian", "es": "Spanish", "de": "German"}

// LanguageName is the name of a language code, "" for auto or anything unknown.
func LanguageName(code string) string { return Languages[code] }

// LanguageRule is the prompt's sentence on which language to write what in.
func LanguageRule(code, what string) string {
	if name := LanguageName(code); name != "" {
		return "Write " + what + " in " + name + ", whatever the language of the email."
	}
	return "Write " + what + " in the language of the email."
}

// SummaryMax is the longest one-line summary kept, in runes.
const SummaryMax = 140

// Conversation is one inbox conversation given to Triage: its newest
// messages, the newest last.
type Conversation struct {
	Key  string // the caller's key; never shown to the model
	Mail []Mail
}

// Verdict is the model's answer for one conversation, validated.
type Verdict struct {
	Key      string
	Category string
	Reply    bool   // the last message waits on the reader's answer
	Summary  string // one line
}

// Triage sorts a batch of conversations in one call. The model sees them as
// c1…cN; an answer for an id not in the batch, or with a category outside
// Categories, is dropped, so a conversation missing from the result was not
// classified. An error means nothing came back that could be read.
func Triage(ctx context.Context, c Chatter, convs []Conversation, lang string) ([]Verdict, error) {
	if len(convs) == 0 {
		return nil, nil
	}
	n := nonce()
	sys := "You sort a person's email inbox. For each conversation decide:\n" +
		"- category: exactly one of important (a real person wrote to them and it needs attention), " +
		"updates (automatic notifications: receipts, bookings, shipping, security alerts, code review and CI), " +
		"newsletter (marketing, promotions, digests, mailing lists), spam (unsolicited junk, scams or phishing);\n" +
		"- reply: true only when the last message is from someone else and explicitly waits on the reader's answer;\n" +
		"- summary: one line of at most 120 characters saying what it is and what, if anything, is asked. " + LanguageRule(lang, "the summary") + "\n" +
		`Answer with JSON only, no prose: {"items":[{"id":"c1","category":"important","reply":false,"summary":"..."}]} with one item per conversation. ` +
		dataFence(n, "The conversations are")
	var b strings.Builder
	b.WriteString("BEGIN EMAIL DATA " + n + "\n\n")
	for i, cv := range convs {
		fmt.Fprintf(&b, "=== Conversation c%d ===\n", i+1)
		for _, m := range cv.Mail {
			body := m.Body
			if r := []rune(body); len(r) > 600 {
				body = string(r[:600]) + "…"
			}
			fmt.Fprintf(&b, "From: %s\nDate: %s\nSubject: %s\n\n%s\n\n", m.From, m.Date, m.Subject, strings.TrimSpace(body))
		}
	}
	b.WriteString("END EMAIL DATA " + n + "\n")
	out, err := c.Chat(ctx, sys, b.String()+"\nSort the conversations above. JSON only.")
	if err != nil {
		return nil, err
	}
	return ParseTriage(out, convs)
}

// ParseTriage reads the model's answer for a batch: a JSON object with
// "items", or a bare array, possibly wrapped in prose or a code fence. Only
// valid items for conversations of the batch are returned, once each.
func ParseTriage(out string, convs []Conversation) ([]Verdict, error) {
	type item struct {
		ID       string          `json:"id"`
		Category string          `json:"category"`
		Reply    json.RawMessage `json:"reply"`
		Summary  string          `json:"summary"`
	}
	var items []item
	s := strings.TrimSpace(out)
	if i, j := strings.Index(s, "{"), strings.LastIndex(s, "}"); i >= 0 && j > i {
		var obj struct {
			Items []item `json:"items"`
		}
		if json.Unmarshal([]byte(s[i:j+1]), &obj) == nil && obj.Items != nil {
			items = obj.Items
		}
	}
	if items == nil {
		if i, j := strings.Index(s, "["), strings.LastIndex(s, "]"); i >= 0 && j > i {
			_ = json.Unmarshal([]byte(s[i:j+1]), &items)
		}
	}
	if items == nil {
		return nil, errors.New("the model's answer was not the JSON asked for")
	}
	seen := map[int]bool{}
	var res []Verdict
	for _, it := range items {
		var idx int
		if _, err := fmt.Sscanf(strings.TrimSpace(strings.ToLower(it.ID)), "c%d", &idx); err != nil || idx < 1 || idx > len(convs) || seen[idx] {
			continue
		}
		cat := strings.ToLower(strings.TrimSpace(it.Category))
		reply := strings.TrimSpace(string(it.Reply)) == "true" || strings.Trim(string(it.Reply), `" `) == "true"
		if cat == "reply" { // a model that took "waits on an answer" for a category
			cat, reply = CatImportant, true
		}
		if !ValidCategory(cat) {
			continue
		}
		if cat != CatImportant {
			reply = false
		}
		seen[idx] = true
		res = append(res, Verdict{Key: convs[idx-1].Key, Category: cat, Reply: reply, Summary: CleanLine(it.Summary, SummaryMax)})
	}
	return res, nil
}

// CleanLine makes untrusted model text one plain line of at most max runes:
// control characters and line breaks become spaces, runs of space collapse.
func CleanLine(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == ' ' || r == ' ' {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		s = strings.TrimSpace(string(r[:max-1])) + "…"
	}
	return s
}

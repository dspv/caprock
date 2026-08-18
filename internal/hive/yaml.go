package hive

import (
	"fmt"
	"strconv"
	"strings"
)

// A tiny YAML-frontmatter reader/writer for the fixed Task schema — no external
// dependency (the corpus rule keeps tooling dependency-free, and the schema is
// closed). Supports scalars and a `done_criteria` string list.

func marshalTask(t Task) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", t.ID)
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(t.Title))
	fmt.Fprintf(&b, "status: %s\n", t.Status)
	if t.Assignee != "" {
		fmt.Fprintf(&b, "assignee: %s\n", t.Assignee)
	} else {
		b.WriteString("assignee: null\n")
	}
	fmt.Fprintf(&b, "budget_usd: %s\n", strconv.FormatFloat(t.BudgetUSD, 'f', -1, 64))
	b.WriteString("done_criteria:\n")
	for _, c := range t.DoneCriteria {
		fmt.Fprintf(&b, "  - %s\n", yamlScalar(c))
	}
	fmt.Fprintf(&b, "verify_rounds_used: %d\n", t.VerifyRoundsUsed)
	b.WriteString("---\n")
	b.WriteString(strings.TrimRight(t.Body, "\n"))
	b.WriteString("\n")
	return b.String()
}

func parseTask(s string) (Task, error) {
	var t Task
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if !strings.HasPrefix(s, "---\n") {
		return t, fmt.Errorf("hive: task file missing frontmatter")
	}
	rest := s[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return t, fmt.Errorf("hive: task frontmatter not terminated")
	}
	front := rest[:end]
	body := rest[end+4:]
	t.Body = strings.Trim(body, "\n")

	var inList bool
	for _, line := range strings.Split(front, "\n") {
		if inList {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "- ") {
				t.DoneCriteria = append(t.DoneCriteria, unquote(strings.TrimSpace(trimmed[2:])))
				continue
			}
			inList = false
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		switch key {
		case "id":
			t.ID = val
		case "title":
			t.Title = unquote(val)
		case "status":
			t.Status = val
		case "assignee":
			if val != "null" && val != "" {
				t.Assignee = unquote(val)
			}
		case "budget_usd":
			t.BudgetUSD, _ = strconv.ParseFloat(val, 64)
		case "verify_rounds_used":
			t.VerifyRoundsUsed, _ = strconv.Atoi(val)
		case "done_criteria":
			inList = true
		}
	}
	if t.ID == "" || t.Status == "" {
		return t, fmt.Errorf("hive: task missing id/status")
	}
	return t, nil
}

// yamlScalar quotes a string when it needs it (contains a colon, leading special char, etc.).
func yamlScalar(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, ":#\n\"'") || strings.HasPrefix(s, " ") || strings.HasPrefix(s, "-") {
		return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
	}
	return s
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		inner := s[1 : len(s)-1]
		inner = strings.ReplaceAll(inner, `\"`, `"`)
		inner = strings.ReplaceAll(inner, `\\`, `\`)
		return inner
	}
	return s
}

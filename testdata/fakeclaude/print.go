package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// Print mode (`-p`): what Second Brain's extraction calls (internal/brain).
// It checks the flags the daemon must pass — a run that would load the
// user's hooks, write a transcript or give the model tools exits 2 — reads
// the prompt from stdin, and answers in the shape of `claude -p
// --output-format json`: one memory per agent passage, at most three, kinds
// and topics guessed from the words, with a usage block and a cost. No model,
// no network. FAKECLAUDE_PRINT_FAIL=1 makes it fail as a refused login does.
func printMode(args []string) {
	need := map[string]bool{"--no-session-persistence": false, "--output-format=json": false, "--tools=": false, "--setting-sources=local": false, "--settings": false}
	for i, a := range args {
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch a {
		case "--no-session-persistence":
			need[a] = true
		case "--output-format":
			need["--output-format="+next] = true
		case "--tools":
			need["--tools="+next] = true
		case "--setting-sources":
			need["--setting-sources="+next] = true
		case "--settings":
			b, err := os.ReadFile(next)
			need[a] = err == nil && strings.Contains(string(b), `"disableAllHooks": true`)
		}
	}
	for k, ok := range need {
		if !ok {
			fmt.Fprintf(os.Stderr, "fake-claude: print mode without %s\n", k)
			os.Exit(2)
		}
	}
	if os.Getenv("FAKECLAUDE_PRINT_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "Invalid API key · Please run /login")
		os.Exit(1)
	}
	in, _ := io.ReadAll(os.Stdin)
	type mem struct {
		Kind    string   `json:"kind"`
		Title   string   `json:"title"`
		Summary string   `json:"summary"`
		Topics  []string `json:"topics"`
		Passage int      `json:"passage"`
		Related []int    `json:"related,omitempty"`
	}
	mems := []mem{}
	re := regexp.MustCompile(`(?m)^\[(\d+)\] Agent: (.+)$`)
	for _, m := range re.FindAllStringSubmatch(string(in), -1) {
		if len(mems) == 3 {
			break
		}
		text := m[2]
		var n int
		fmt.Sscan(m[1], &n)
		title := text
		if i := strings.Index(title, ". "); i > 0 {
			title = title[:i]
		}
		if r := []rune(title); len(r) > 80 {
			title = string(r[:79]) + "…"
		}
		low := strings.ToLower(text)
		kind := "idea"
		switch {
		case strings.Contains(low, "decid") || strings.Contains(low, "decision"):
			kind = "decision"
		case strings.Contains(low, "finding") || strings.Contains(low, "turned out") || strings.Contains(low, "because"):
			kind = "finding"
		case strings.Contains(low, "?"):
			kind = "question"
		}
		topics := []string{}
		for _, w := range []string{"sqlite", "cache", "webhooks", "pagination", "react", "billing", "tests"} {
			if strings.Contains(low, strings.TrimSuffix(w, "s")) && len(topics) < 2 {
				topics = append(topics, w)
			}
		}
		if len(topics) == 0 {
			topics = append(topics, "notes")
		}
		r := []rune(text)
		if len(r) > 400 {
			text = string(r[:399]) + "…"
		}
		mm := mem{Kind: kind, Title: title, Summary: text, Topics: topics, Passage: n}
		if len(mems) > 0 {
			mm.Related = []int{len(mems) - 1}
		}
		mems = append(mems, mm)
	}
	out := map[string]any{
		"type": "result", "subtype": "success", "is_error": false,
		"result":            "",
		"structured_output": map[string]any{"memories": mems},
		"total_cost_usd":    0,
		"usage":             map[string]int{"input_tokens": len(in) / 4, "output_tokens": 50 * len(mems), "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
		"modelUsage":        map[string]any{"fake-claude": map[string]int{}},
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	os.Exit(0)
}

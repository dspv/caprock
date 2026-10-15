package templates

import (
	"regexp"
	"strings"
)

// Where a template's brief path and first prompt came from (inspect).
const (
	FromMarker  = "marker"  // the caprock-template comment at the top of TEMPLATE.md
	FromMention = "mention" // the first `docs/<x>.md` TEMPLATE.md or README.md names
	FromDefault = "default"
)

// DefaultBriefPath is where a brief goes when the template says nothing.
const DefaultBriefPath = "docs/brief.md"

// Default first prompts: one for a template that carries instructions for
// the agent (TEMPLATE.md), one for a template that does not.
const (
	DefaultPromptWithTemplateMD = "Read TEMPLATE.md and follow it. The brief of this project is {brief}."
	DefaultPrompt               = "Read {brief}, the brief of this project, and the README, then start the work as they say."
)

// Marker is what a template says about itself in a comment at the very top
// of its TEMPLATE.md:
//
//	<!-- caprock-template
//	brief: docs/source-spec.md
//	prompt: Read TEMPLATE.md. Build the .ai/ corpus from {brief}.
//	-->
//
// Either key may be missing. A line that names no key continues the prompt.
type Marker struct {
	Brief  string
	Prompt string
}

const markerOpen = "<!-- caprock-template"

// ParseMarker reads the marker comment, if TEMPLATE.md starts with one. A
// brief path or prompt that would not pass CheckBriefPath or CheckPrompt is
// left out, so the next default applies.
func ParseMarker(md string) (Marker, bool) {
	md = strings.TrimPrefix(md, "\ufeff")
	md = strings.ReplaceAll(md, "\r\n", "\n")
	md = strings.TrimLeft(md, " \t\n\r")
	if !strings.HasPrefix(md, markerOpen) {
		return Marker{}, false
	}
	rest := md[len(markerOpen):]
	if rest != "" && !strings.ContainsRune(" \t\n\r", rune(rest[0])) && !strings.HasPrefix(rest, "-->") {
		return Marker{}, false // <!-- caprock-templates, some other comment
	}
	body, _, closed := strings.Cut(rest, "-->")
	if !closed {
		return Marker{}, false
	}
	var m Marker
	key := ""
	var prompt []string
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		k, v, ok := strings.Cut(line, ":")
		k = strings.ToLower(strings.TrimSpace(k))
		switch {
		case ok && k == "brief":
			key, m.Brief = k, strings.TrimSpace(v)
		case ok && k == "prompt":
			key, prompt = k, []string{strings.TrimSpace(v)}
		case key == "prompt":
			prompt = append(prompt, line)
		}
	}
	m.Prompt = strings.TrimSpace(strings.Join(prompt, "\n"))
	if m.Brief != "" && CheckBriefPath(m.Brief) != nil {
		m.Brief = ""
	}
	if m.Prompt != "" && CheckPrompt(m.Prompt) != nil {
		m.Prompt = ""
	}
	return m, true
}

// mention is a backticked docs/<x>.md.
var mention = regexp.MustCompile("`(docs/[^`\\s]+\\.md)`")

// firstMention is the first backticked docs/<x>.md in text that is a valid
// brief path.
func firstMention(text string) string {
	for _, m := range mention.FindAllStringSubmatch(text, -1) {
		if CheckBriefPath(m[1]) == nil {
			return m[1]
		}
	}
	return ""
}

// Defaults works out a template's brief path and first prompt from its
// TEMPLATE.md and README.md, and says where each came from: (1) the marker
// comment; (2) for the brief, the first `docs/<x>.md` TEMPLATE.md names,
// then README.md; (3) docs/brief.md and a default prompt.
func Defaults(templateMD, readme string) (brief, briefFrom, prompt, promptFrom string) {
	m, _ := ParseMarker(templateMD)
	switch {
	case m.Brief != "":
		brief, briefFrom = m.Brief, FromMarker
	case firstMention(templateMD) != "":
		brief, briefFrom = firstMention(templateMD), FromMention
	case firstMention(readme) != "":
		brief, briefFrom = firstMention(readme), FromMention
	default:
		brief, briefFrom = DefaultBriefPath, FromDefault
	}
	switch {
	case m.Prompt != "":
		prompt, promptFrom = m.Prompt, FromMarker
	case strings.TrimSpace(templateMD) != "":
		prompt, promptFrom = DefaultPromptWithTemplateMD, FromDefault
	default:
		prompt, promptFrom = DefaultPrompt, FromDefault
	}
	return brief, briefFrom, prompt, promptFrom
}

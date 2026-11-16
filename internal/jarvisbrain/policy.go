package jarvisbrain

import (
	"regexp"
	"strings"
)

// The auto-answer policy (ADR-097): the brain answers a question dialog for
// the person only when all of these hold, checked in this order —
//
//  1. the setting's auto_answer is "routine" and the brain is ready;
//  2. it is a question dialog (never a permission, a plan or a turn that
//     ended asking in prose), in a session Caprock started and holds
//     (rule 7), with one single-select question and at least two options;
//  3. no deny word appears in the question, an option's label or its
//     description (DenyHit) — a deterministic guard that holds whatever the
//     model says;
//  4. the model calls it routine and picks an option, and the picked
//     option's label passes the deny check too.
//
// Anything else is left for the person.

// denyWords are the words that mark a choice as outward-facing or hard to
// undo. Matched as whole words (and their common endings), case folded.
var denyWords = []string{
	"push", "force", "merge", "deploy", "release", "publish", "ship",
	"delete", "remove", "drop", "destroy", "wipe", "erase", "purge", "truncate", "overwrite", "reset", "revert", "rollback",
	"pay", "payment", "charge", "invoice", "refund", "purchase", "buy", "billing", "subscribe",
	"credential", "password", "secret", "token", "apikey", "ssh", "sudo", "admin", "permission",
	"send", "email", "mail", "post", "tweet", "notify", "slack", "telegram",
	"production", "prod", "migrate", "migration",
}

var denyRE = regexp.MustCompile(`(?i)\b(` + strings.Join(withIng(denyWords), "|") + `)(e?s|ed|ing|d)?\b`)

// withIng adds the -ing form of each word ending in e ("deleting"), which
// the suffixes above cannot spell.
func withIng(words []string) []string {
	out := append([]string(nil), words...)
	for _, w := range words {
		if strings.HasSuffix(w, "e") {
			out = append(out, strings.TrimSuffix(w, "e")+"ing")
		}
	}
	return out
}

// DenyHit returns the first deny word in any of texts, "" when there is none.
func DenyHit(texts ...string) string {
	for _, t := range texts {
		if m := denyRE.FindString(t); m != "" {
			return strings.ToLower(m)
		}
	}
	return ""
}

// Eligible reports whether a need is a question auto-answer may consider
// (rule 2 above).
func Eligible(n Need) bool {
	return n.Kind == "question" && n.Controllable && n.Answerable && !n.MultiSelect &&
		n.MoreQuestions == 0 && len(n.Options) >= 2
}

// NeedDenyHit is DenyHit over a need's question and every option.
func NeedDenyHit(n Need) string {
	texts := []string{n.Title}
	for _, o := range n.Options {
		texts = append(texts, o.Label, o.Description)
	}
	return DenyHit(texts...)
}

// StripRecommended takes "(Recommended)" off an option's label, reporting
// whether it was there: Claude Code's AskUserQuestion marks the agent's
// pick that way.
func StripRecommended(label string) (string, bool) {
	i := strings.Index(strings.ToLower(label), "(recommended)")
	if i < 0 {
		return strings.TrimSpace(label), false
	}
	return strings.TrimSpace(strings.Join(strings.Fields(label[:i]+" "+label[i+len("(recommended)"):]), " ")), true
}

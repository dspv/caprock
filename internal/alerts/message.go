package alerts

import (
	"fmt"
	"strings"
)

// Message renders an alert as the text of one Telegram message.
//
// What it may carry is the whole privacy argument for sending it (ADR-036):
// the project's folder name, what happened, which agent, and a link back to
// the dashboard. Never a prompt, a reply, a tool, a command or a path —
// Telegram reads every word of it. link is empty when the dashboard cannot be
// reached from a phone, and then the line is left out rather than offering a
// loopback address that opens nothing.
func Message(a Alert, project, agent, link string) string {
	if strings.TrimSpace(project) == "" {
		project = "a session"
	}
	what := "is waiting for approval"
	switch {
	case a.Kind == KindFinished:
		what = "has finished"
	case a.Question:
		what = "is waiting for your answer"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Caprock · %s %s\n%s", project, what, agent)
	if link != "" {
		fmt.Fprintf(&b, "\n%s", link)
	}
	if a.LastThisHour {
		fmt.Fprintf(&b, "\n\nThat is %d alerts this hour; the rest wait until it is over.", HourlyCap)
	}
	return b.String()
}

// CheckMessage is what "Send a test alert" sends: the same shape as a real one,
// saying it is a test, so the person setting it up sees exactly what will
// arrive.
func CheckMessage(link string) string {
	var b strings.Builder
	b.WriteString("Caprock · test alert\nAlerts reach this chat. A real one names the project, says it is waiting for approval or has finished, and the agent.")
	if link != "" {
		fmt.Fprintf(&b, "\n%s", link)
	}
	return b.String()
}

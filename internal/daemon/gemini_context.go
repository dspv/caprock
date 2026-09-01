package daemon

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// geminiContext is the facts about this machine that ride along with a
// question, so the model answers about the reader's own work instead of about
// software in general.
//
// Asked "what did I spend yesterday" with no context, a model can only explain
// what spending is. That is the difference between a chat window bolted to the
// side of a dashboard and a feature worth paying for: the numbers are already
// computed, and handing them over costs nothing extra.
//
// What goes in is deliberately narrow — totals, model and project names,
// session counts. No prompts, no replies, no file paths, no code. Caprock's
// database holds the prose Claude wrote and every command it ran; none of that
// leaves the machine here. A user who wants to ask about a specific session can
// paste it themselves, which is a decision rather than a default.
func (d *Daemon) geminiContext(ctx context.Context) string {
	var b strings.Builder
	now := time.Now()

	b.WriteString("Facts about this machine, from the user's own Caprock data.\n")
	b.WriteString("Costs are at API list prices, which is not the same as their bill.\n\n")

	// Today, then the week: enough to answer "is this normal" without asking
	// the model to reason over a table it cannot see.
	for _, r := range []struct {
		label string
		from  time.Time
	}{
		{"today", startOfDay(now, d.location())},
		{"last 7 days", now.AddDate(0, 0, -7)},
	} {
		s, err := store.Summarize(ctx, d.store.DB(), r.from.UnixMilli())
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "%s: $%.2f across %d sessions, %d turns, %s tokens\n",
			r.label, s.CostUSD, s.Sessions, s.Turns, compactTokens(s.TokensIn+s.TokensOut+s.CacheRead+s.CacheWrite))

		if len(s.Models) > 0 {
			b.WriteString("  models: ")
			for i, m := range s.Models {
				if i >= 4 {
					break
				}
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%s $%.2f", m.Model, m.CostUSD)
			}
			b.WriteString("\n")
		}
		if len(s.Projects) > 0 {
			b.WriteString("  projects: ")
			for i, p := range s.Projects {
				if i >= 5 {
					break
				}
				if i > 0 {
					b.WriteString(", ")
				}
				fmt.Fprintf(&b, "%s $%.2f", p.Project, p.CostUSD)
			}
			b.WriteString("\n")
		}
	}

	// What is running right now, because "what is my agent doing" is the
	// question this product exists to answer.
	if live, err := store.ListSessions(ctx, d.store.DB(), true, 10); err == nil && len(live) > 0 {
		fmt.Fprintf(&b, "\nlive sessions (%d):\n", len(live))
		for _, s := range live {
			fmt.Fprintf(&b, "  %s in %s (%s)\n", s.Status, orUnknown(s.Project), orUnknown(s.Model))
		}
	}

	return b.String()
}

func orUnknown(s string) string {
	if strings.TrimSpace(s) == "" {
		return "unknown"
	}
	return s
}

// compactTokens keeps the context short. A model does not need nine digits to
// know a number is large, and every character here is one the user pays for.
func compactTokens(n int64) string {
	switch {
	case n >= 1e9:
		return fmt.Sprintf("%.1fB", float64(n)/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return fmt.Sprintf("%d", n)
}

func startOfDay(t time.Time, loc *time.Location) time.Time {
	t = t.In(loc)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
}

func (d *Daemon) location() *time.Location {
	if d.rec != nil && d.rec.Location != nil {
		return d.rec.Location
	}
	return time.Local
}

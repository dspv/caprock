package config

// Subscription is a second (third, …) sign-in to Claude Code or Codex that
// Caprock keeps in a configuration directory of its own (ADR-048).
//
// The user's normal sign-in — the one `claude` or `codex` uses with no
// environment variable — is the Default subscription. It is not stored here:
// it always exists, and nothing about it is Caprock's to keep.
type Subscription struct {
	// ID names the subscription on a session (sessions.subscription) and its
	// directory, `<data dir>/profiles/<id>/`: lowercase letters and digits.
	ID string `json:"id"`
	// Label is what the user calls it ("Work Max", "Personal").
	Label string `json:"label"`
	// Agent is "claude" or "codex".
	Agent string `json:"agent"`
	// CreatedAt is when it was added, in Unix ms.
	CreatedAt int64 `json:"created_at"`
	// Plan is how this sign-in is paid for, stated by the user in Settings →
	// Plan & licence; nil means the main plan (PlanKind and its two fields)
	// stands for it too.
	Plan *Plan `json:"plan,omitempty"`
}

// Plan is how one sign-in is paid for: the same three facts as Config's
// PlanKind, PlanLabel and PlanUSDPerMonth, which stay the plan of the user's
// own sign-in and of every session no other plan is known for. Caprock never
// infers one (rule 6); the user states it.
type Plan struct {
	// Kind is "flat" (Pro, Max, a Team seat) or "metered" (API, Bedrock).
	Kind string `json:"kind"`
	// Label is the user's own words for it ("Max 20×").
	Label string `json:"label,omitempty"`
	// USDPerMonth is what one seat costs a month; 0 = not stated.
	USDPerMonth float64 `json:"usd_per_month,omitempty"`
}

// OwnLabel is the name of the user's own sign-in to agent: what they renamed
// it to, or "Own sign-in".
func (c Config) OwnLabel(agent string) string {
	if l := c.OwnLabels[agent]; l != "" {
		return l
	}
	return "Own sign-in"
}

// DefaultSubscriptionFor is the subscription a new session of agent starts
// on when the request names none: an id from Subscriptions, or "" for the
// user's own sign-in — also when the chosen one has since been removed.
func (c Config) DefaultSubscriptionFor(agent string) string {
	id := c.DefaultSubscription[agent]
	if id == "" {
		return ""
	}
	for _, s := range c.Subscriptions {
		if s.ID == id && s.Agent == agent {
			return id
		}
	}
	return ""
}

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
)

// Settings → Subscriptions (ADR-048): more than one sign-in to Claude Code or
// Codex, each in a configuration directory of Caprock's, and the one a new
// session runs on picked in New agent and Quick chat.

// Errors a SubscriptionManager answers with, mapped to statuses here.
var (
	// ErrSubscriptionPremium: the agent already has the free number of
	// subscriptions and there is no licence.
	ErrSubscriptionPremium = errors.New("premium required")
	// ErrSubscriptionInUse: a session Caprock started is running on it.
	ErrSubscriptionInUse = errors.New("a session is running on this subscription")
	// ErrSubscriptionNotFound: no subscription with that id.
	ErrSubscriptionNotFound = errors.New("no such subscription")
)

// SubscriptionWindow is one plan window as last reported for a subscription.
type SubscriptionWindow struct {
	Window         string  `json:"window"` // five_hour | seven_day
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`   // unix seconds
	ObservedAt     int64   `json:"observed_at"` // unix ms
}

// Subscription is one sign-in, as Settings and the pickers show it.
type Subscription struct {
	// ID is "default" for the user's own sign-in, and Default is true for it
	// alone: the name predates Make default and means "own".
	ID      string `json:"id"`
	Agent   string `json:"agent"`
	Label   string `json:"label"`
	Default bool   `json:"default"`
	// Preferred marks the one a new session of this agent starts on when none
	// is picked (Make default). Exactly one per agent.
	Preferred bool `json:"preferred"`
	// Plan is how this sign-in is paid for, when the user said; the own
	// sign-in's is the main plan in /v1/settings and is not repeated here.
	Plan *SubscriptionPlan `json:"plan,omitempty"`
	// Dir is its configuration directory; EnvVar the variable that selects it
	// ("" for the Default one, which uses none).
	Dir    string `json:"dir"`
	EnvVar string `json:"env_var,omitempty"`
	// SignedIn and Account are read from files the agent wrote (internal/subs).
	SignedIn bool   `json:"signed_in"`
	Account  string `json:"account,omitempty"`
	// LoginCommand is the agent's own sign-in for this directory, to be typed
	// into a shell tab and run by the user.
	LoginCommand string               `json:"login_command"`
	Windows      []SubscriptionWindow `json:"windows"`
	// Sessions7d and Cost7dUSD are the last seven days of priced work on it.
	Sessions7d int64   `json:"sessions_7d"`
	Cost7dUSD  float64 `json:"cost_7d_usd"`
	// Running is how many sessions Caprock started are running on it.
	Running   int   `json:"running"`
	CreatedAt int64 `json:"created_at,omitempty"`
}

// SubscriptionPlan is one sign-in's plan: kind "flat" or "metered", the
// user's words for it and a monthly price (0 = not stated).
type SubscriptionPlan struct {
	Kind        string  `json:"kind"`
	Label       string  `json:"label,omitempty"`
	USDPerMonth float64 `json:"usd_per_month,omitempty"`
}

// SubscriptionPatch is PATCH /v1/subscriptions/{id}: each field present
// changes one thing. Agent names whose own sign-in "default" is.
type SubscriptionPatch struct {
	Agent       string
	Label       *string
	MakeDefault bool
	// SetPlan with Plan nil clears the plan: the main one stands for it.
	SetPlan bool
	Plan    *SubscriptionPlan
}

// SubscriptionAgent groups one agent's subscriptions, the Default one first.
type SubscriptionAgent struct {
	Agent         string         `json:"agent"`
	Label         string         `json:"label"`
	Installed     bool           `json:"installed"`
	Subscriptions []Subscription `json:"subscriptions"`
}

// SubscriptionsResponse is GET /v1/subscriptions.
type SubscriptionsResponse struct {
	Agents       []SubscriptionAgent `json:"agents"`
	Licensed     bool                `json:"licensed"`
	FreePerAgent int                 `json:"free_per_agent"`
	// Home is where a sign-in's shell tab opens.
	Home string `json:"home,omitempty"`
}

// SubscriptionManager is the daemon's side.
type SubscriptionManager interface {
	List(ctx context.Context) (SubscriptionsResponse, error)
	Add(ctx context.Context, agent, label string) (Subscription, error)
	Update(ctx context.Context, id string, p SubscriptionPatch) (Subscription, error)
	Remove(ctx context.Context, id string) error
}

func (s *Server) handleSubscriptions(w http.ResponseWriter, r *http.Request) {
	if s.d.Subscriptions == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "subscriptions are unavailable"})
		return
	}
	out, err := s.d.Subscriptions.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// subscriptionsWritable refuses what only the machine's owner may do: a
// subscription is a sign-in on this machine, set up at it (ADR-034).
func (s *Server) subscriptionsWritable(w http.ResponseWriter, r *http.Request) bool {
	if s.d.Subscriptions == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "subscriptions are unavailable"})
		return false
	}
	if deviceFrom(r) != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "subscriptions are set up on the machine Caprock runs on"})
		return false
	}
	return true
}

func (s *Server) subscriptionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrSubscriptionPremium):
		writeJSON(w, http.StatusPaymentRequired, map[string]string{
			"error":  "premium required",
			"detail": "three subscriptions per agent are free, your own sign-in included; more need Premium",
		})
	case errors.Is(err, ErrSubscriptionInUse):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrSubscriptionNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	}
}

func (s *Server) handleAddSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	var body struct {
		Agent string `json:"agent"`
		Label string `json:"label"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `body is {"agent": "claude"|"codex", "label": "…"}`})
		return
	}
	sub, err := s.d.Subscriptions.Add(r.Context(), body.Agent, body.Label)
	if err != nil {
		s.subscriptionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

// handleUpdateSubscription renames a subscription, makes it the one new
// sessions start on, or sets its plan — the own sign-in ("default") too,
// named with "agent".
func (s *Server) handleUpdateSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	var body struct {
		Agent       string          `json:"agent"`
		Label       *string         `json:"label"`
		MakeDefault bool            `json:"make_default"`
		Plan        json.RawMessage `json:"plan"`
	}
	const shape = `body is {"label"?: "…", "make_default"?: true, "plan"?: {"kind": "flat"|"metered", "label"?: "…", "usd_per_month"?: 0} | null, "agent"?: "claude"|"codex"}`
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": shape})
		return
	}
	p := SubscriptionPatch{Agent: body.Agent, Label: body.Label, MakeDefault: body.MakeDefault}
	if len(body.Plan) > 0 {
		p.SetPlan = true
		if string(body.Plan) != "null" {
			var plan SubscriptionPlan
			if err := json.Unmarshal(body.Plan, &plan); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": shape})
				return
			}
			if err := validPlan(&plan); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if plan.Kind != "" {
				p.Plan = &plan
			}
		}
	}
	if p.Label == nil && !p.MakeDefault && !p.SetPlan {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": shape})
		return
	}
	sub, err := s.d.Subscriptions.Update(r.Context(), r.PathValue("id"), p)
	if err != nil {
		s.subscriptionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

func (s *Server) handleRemoveSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionsWritable(w, r) {
		return
	}
	if err := s.d.Subscriptions.Remove(r.Context(), r.PathValue("id")); err != nil {
		s.subscriptionError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validPlan holds a sign-in's plan to what PUT /v1/settings holds the main
// one to: a known kind, a price that is a non-negative number, a short label.
// Kind "" is no plan.
func validPlan(p *SubscriptionPlan) error {
	switch p.Kind {
	case "", "flat", "metered":
	default:
		return fmt.Errorf("unknown plan kind %q (want \"flat\", \"metered\", or empty)", p.Kind)
	}
	if p.USDPerMonth < 0 || math.IsNaN(p.USDPerMonth) || math.IsInf(p.USDPerMonth, 0) {
		return errors.New("usd_per_month must be a non-negative number")
	}
	p.Label = strings.TrimSpace(p.Label)
	if len(p.Label) > 64 {
		p.Label = p.Label[:64]
	}
	return nil
}

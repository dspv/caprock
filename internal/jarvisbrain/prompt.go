package jarvisbrain

import (
	"encoding/json"
	"errors"
	"strings"
)

// What a brain run is given — exactly this, and nothing else (ADR-097,
// docs/jarvis-brain.md). For a message: the message's text, the project it
// was addressed to if any, and from the digest each need's kind, project,
// session id, one-line title and, for a question dialog, its options; each
// live agent's session id, project, title, state, "now" line and whether
// Caprock may type into it. No transcript, no file, no folder path, no code.
// For an auto-answer: the question's one line, its options with their
// descriptions, the project and the agent's title.

// Action kinds the brain may ask for.
const (
	ActSend   = "send"
	ActStart  = "start"
	ActAnswer = "answer"
	ActNone   = "none"
)

// PlanSchema is the answer to a message: a short reply and the actions. Every
// property is required and optional ones are nullable, which both Claude
// Code's --json-schema and Codex's strict --output-schema accept.
const PlanSchema = `{"type":"object","additionalProperties":false,"required":["reply","actions"],"properties":{` +
	`"reply":{"type":"string"},` +
	`"actions":{"type":"array","maxItems":3,"items":{"type":"object","additionalProperties":false,` +
	`"required":["kind","project","session_id","text","option"],"properties":{` +
	`"kind":{"type":"string","enum":["send","start","answer","none"]},` +
	`"project":{"type":["string","null"]},"session_id":{"type":["string","null"]},` +
	`"text":{"type":["string","null"]},"option":{"type":["integer","null"]}}}}}}`

// ChoiceSchema is the answer to an auto-answer: whether the question is
// routine, the option picked (0-based) and why, in one line.
const ChoiceSchema = `{"type":"object","additionalProperties":false,"required":["routine","option","reason"],"properties":{` +
	`"routine":{"type":"boolean"},"option":{"type":["integer","null"]},"reason":{"type":"string"}}}`

// PlanSystem is the brain's instructions for a message.
const PlanSystem = `You are Jarvis, the dispatcher inside Caprock, a local dashboard for a person who runs several coding agents at once. You never write code and you have no tools. You read one message from the person and the list of their agents, and you decide what to do with it.

Actions:
- "send": give the person's instruction to one live agent. Use only a session_id from the list whose "controllable" is true. Put the instruction in "text", in the person's words, cleaned up; do not add work they did not ask for.
- "start": start a new agent in a project with the instruction in "text". Use it when the person asks for a new agent, or when no controllable agent runs in the project they mean.
- "answer": press option number "option" (0-based) of a question need with "answerable": true, by its session_id. Only when the person clearly says which option.
- "none": nothing to do (a question about status, a greeting, something unclear).

Rules:
- Without a project in the message, prefer the "project" given with it, else the project the message is plainly about, else the most recently active one (agents are listed most recently active first).
- Never invent a session_id or a project. Never send to an agent that is not controllable.
- If the message is unclear, take no action and ask one short question in "reply".
- "reply" is one or two short sentences in plain words, saying what you did or what you see. Answer status questions from the list.
- Set every unused field to null. At most three actions.`

// ChoiceSystem is the brain's instructions for an auto-answer.
const ChoiceSystem = `You decide whether a coding agent's multiple-choice question is routine enough to answer for the person, and which option to pick. You have no tools.

Routine: a choice inside the agent's own task that the person would not care to be asked about, that changes nothing outside the working copy and is easy to undo — a naming, a file layout, which of two equivalent approaches, whether to add a test, whether to continue.
Not routine — answer "routine": false: anything that reaches outside the machine or is hard to undo — pushing, merging, deploying, releasing, publishing, deleting or overwriting data, paying, credentials or secrets, sending a message or e-mail to anyone, changing who has access — and anything about the person's preferences, money, time or priorities, and anything you are unsure about.

When routine, pick the option marked recommended unless it is clearly wrong; "option" is its 0-based number. "reason" is one short line the person will read later: why it was safe to answer and why this option. When not routine, "option" is null and "reason" says why it needs the person.`

// planContext is the JSON the brain reads for a message.
type planContext struct {
	Message string  `json:"message"`
	Project string  `json:"project,omitempty"`
	Needs   []Need  `json:"needs_you"`
	Agents  []Agent `json:"agents"`
}

// PlanRequest builds a message's run. Agents go most recently active first.
func PlanRequest(text, project string, s Snapshot) Request {
	agents := append([]Agent(nil), s.Agents...)
	sortByActivity(agents)
	needs := make([]Need, 0, len(s.Needs))
	for _, n := range s.Needs {
		needs = append(needs, Need{Kind: n.Kind, SessionID: n.SessionID, Project: n.Project, Title: n.Title, Options: n.Options, Answerable: n.Answerable})
	}
	for i := range agents {
		agents[i] = Agent{SessionID: agents[i].SessionID, Project: agents[i].Project, Title: agents[i].Title,
			State: agents[i].State, Now: agents[i].Now, Controllable: agents[i].Controllable}
	}
	if agents == nil {
		agents = []Agent{}
	}
	b, _ := json.Marshal(planContext{Message: text, Project: project, Needs: needs, Agents: agents})
	return Request{System: PlanSystem, Prompt: string(b), Schema: PlanSchema}
}

// choiceContext is the JSON the brain reads for an auto-answer.
type choiceContext struct {
	Project  string   `json:"project"`
	Agent    string   `json:"agent_title,omitempty"`
	Question string   `json:"question"`
	Options  []Option `json:"options"`
}

// ChoiceRequest builds an auto-answer's run.
func ChoiceRequest(n Need, agentTitle string) Request {
	b, _ := json.Marshal(choiceContext{Project: n.Project, Agent: agentTitle, Question: n.Title, Options: n.Options})
	return Request{System: ChoiceSystem, Prompt: string(b), Schema: ChoiceSchema}
}

// Action is one thing the brain asked for.
type Action struct {
	Kind      string `json:"kind"`
	Project   string `json:"project,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	Text      string `json:"text,omitempty"`
	Option    *int   `json:"option,omitempty"`
}

// Plan is the brain's answer to a message.
type Plan struct {
	Reply   string
	Actions []Action
}

// ParsePlan reads a message's answer; nulls read as absent.
func ParsePlan(raw json.RawMessage) (Plan, error) {
	var p struct {
		Reply   string `json:"reply"`
		Actions []struct {
			Kind      string  `json:"kind"`
			Project   *string `json:"project"`
			SessionID *string `json:"session_id"`
			Text      *string `json:"text"`
			Option    *int    `json:"option"`
		} `json:"actions"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return Plan{}, errors.New("the brain's answer was not in the expected shape")
	}
	out := Plan{Reply: strings.TrimSpace(p.Reply)}
	for i, a := range p.Actions {
		if i == 3 {
			break
		}
		act := Action{Kind: a.Kind, Option: a.Option}
		if a.Project != nil {
			act.Project = strings.TrimSpace(*a.Project)
		}
		if a.SessionID != nil {
			act.SessionID = strings.TrimSpace(*a.SessionID)
		}
		if a.Text != nil {
			act.Text = strings.TrimSpace(*a.Text)
		}
		switch act.Kind {
		case ActSend, ActStart, ActAnswer:
			out.Actions = append(out.Actions, act)
		case ActNone:
		default:
			return Plan{}, errors.New("the brain asked for an action Caprock does not know")
		}
	}
	if out.Reply == "" && len(out.Actions) == 0 {
		return Plan{}, errors.New("the brain answered nothing")
	}
	return out, nil
}

// Choice is the brain's answer to an auto-answer.
type Choice struct {
	Routine bool
	Option  int // -1 when none
	Reason  string
}

// ParseChoice reads an auto-answer's answer.
func ParseChoice(raw json.RawMessage) (Choice, error) {
	var c struct {
		Routine bool   `json:"routine"`
		Option  *int   `json:"option"`
		Reason  string `json:"reason"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return Choice{}, errors.New("the brain's answer was not in the expected shape")
	}
	out := Choice{Routine: c.Routine, Option: -1, Reason: oneLine(c.Reason, 200)}
	if c.Option != nil {
		out.Option = *c.Option
	}
	return out, nil
}

func sortByActivity(a []Agent) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j].LastActivityAt > a[j-1].LastActivityAt; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

// oneLine is s on one line, at most n runes.
func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	return clip(s, n)
}

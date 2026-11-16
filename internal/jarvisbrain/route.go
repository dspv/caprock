package jarvisbrain

import (
	"sort"
	"strings"
)

// Agent is one live agent as Jarvis sees it: the digest's JarvisAgent, the
// fields routing and the brain use.
type Agent struct {
	SessionID      string `json:"session_id"`
	Project        string `json:"project"`
	Dir            string `json:"-"`
	Title          string `json:"title"`
	State          string `json:"state"`
	Now            string `json:"now"`
	LastActivityAt int64  `json:"-"`
	// Controllable: Caprock started it and holds its terminal (rule 7).
	Controllable bool `json:"controllable"`
}

// Option is one choice of a question dialog.
type Option struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended"`
}

// Need is one thing waiting on the person: the digest's JarvisNeed, plus
// the question dialog's options when it is one.
type Need struct {
	Kind      string `json:"kind"`
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	Title     string `json:"title"`
	Since     int64  `json:"-"`
	// Options are the first question's choices, for a question dialog.
	Options []Option `json:"options,omitempty"`
	// Answerable: an owned session with one single-select question on
	// screen, which an option can answer.
	Answerable bool `json:"answerable"`
	// MoreQuestions counts further questions in the same dialog.
	MoreQuestions int  `json:"-"`
	MultiSelect   bool `json:"-"`
	Controllable  bool `json:"-"`
}

// Snapshot is what Jarvis knows when a message arrives: the digest's needs
// and agents, and the folder of every project Caprock knows (for starting
// an agent where none runs).
type Snapshot struct {
	Needs  []Need
	Agents []Agent
	// Dirs maps a project's name to a folder of it.
	Dirs map[string]string
}

// Projects is every project name the snapshot knows, longest first.
func (s Snapshot) Projects() []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, a := range s.Agents {
		add(a.Project)
	}
	for p := range s.Dirs {
		add(p)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) > len(out[j])
		}
		return out[i] < out[j]
	})
	return out
}

// Known reports whether project is one the snapshot knows, matched without
// regard to case; it returns the stored spelling.
func (s Snapshot) Known(project string) (string, bool) {
	for _, p := range s.Projects() {
		if strings.EqualFold(p, project) {
			return p, true
		}
	}
	return "", false
}

// ParseMention reads a leading `@project`: the longest known name the line
// starts with (names may hold spaces), else the first word after the @.
// It returns the project ("" when the line names none or an unknown one),
// the rest of the line, and the word named when it is not a known project.
func ParseMention(line string, projects []string) (project, rest, unknown string) {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "@") {
		return "", t, ""
	}
	body := t[1:]
	lower := strings.ToLower(body)
	for _, p := range projects {
		pl := strings.ToLower(p)
		if (lower == pl || strings.HasPrefix(lower, pl+" ") || strings.HasPrefix(lower, pl+"\n")) && len(p) > len(project) {
			project = p
		}
	}
	if project != "" {
		return project, strings.TrimSpace(body[len(project):]), ""
	}
	word := strings.Fields(body)
	if len(word) == 0 {
		return "", "", ""
	}
	return "", strings.TrimSpace(strings.TrimPrefix(body, word[0])), word[0]
}

// MostRecentProject is the project of the most recently active live agent,
// "" when none runs.
func MostRecentProject(agents []Agent) string {
	best, at := "", int64(-1)
	for _, a := range agents {
		if a.Project != "" && a.LastActivityAt > at {
			best, at = a.Project, a.LastActivityAt
		}
	}
	return best
}

// Route is where a message for a project goes.
type Route struct {
	// Agent is the project's most recently active controllable agent; nil
	// when there is none and a new one is to be started.
	Agent *Agent
	// Of counts the project's controllable agents.
	Of int
	// Skipped counts its live agents Caprock may not type into (rule 7).
	Skipped int
	// Dir is the folder a new agent starts in, "" when unknown.
	Dir string
}

// RouteTo picks where a message for project goes: the queue of its most
// recently active agent Caprock started, else a new agent in its folder.
func RouteTo(s Snapshot, project string) Route {
	var r Route
	var ours []Agent
	for _, a := range s.Agents {
		if a.Project != project {
			continue
		}
		if a.Controllable {
			ours = append(ours, a)
		} else {
			r.Skipped++
		}
		if r.Dir == "" && a.Dir != "" {
			r.Dir = a.Dir
		}
	}
	if r.Dir == "" {
		r.Dir = s.Dirs[project]
	}
	sort.SliceStable(ours, func(i, j int) bool { return ours[i].LastActivityAt > ours[j].LastActivityAt })
	r.Of = len(ours)
	if len(ours) > 0 {
		a := ours[0]
		r.Agent = &a
	}
	return r
}

package hive

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Message is a mailbox file: markdown with YAML frontmatter {from,to,ts,task_id?,kind}
// and a free-form body. See .ai/05-orchestration.md § Mailbox message.
type Message struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Ts     int64  `json:"ts"`
	TaskID string `json:"task_id,omitempty"`
	Kind   string `json:"kind"` // assign | result | question | escalation
	Body   string `json:"body"`
	// Name is the on-disk filename (set on read).
	Name string `json:"name,omitempty"`
}

// Message kinds.
const (
	KindAssign     = "assign"
	KindResult     = "result"
	KindQuestion   = "question"
	KindEscalation = "escalation"
)

// Send writes a message into the sender's outbox. The router later delivers it.
func (h *Hive) Send(m Message) (string, error) {
	if err := validID(m.From); err != nil {
		return "", err
	}
	if err := validID(m.To); err != nil {
		return "", err
	}
	if m.Ts == 0 {
		m.Ts = time.Now().UnixMilli()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	name := fmt.Sprintf("%d-%s-%s.md", m.Ts, m.Kind, m.From)
	path := filepath.Join(h.outbox(m.From), name)
	if err := os.MkdirAll(h.outbox(m.From), 0o755); err != nil {
		return "", err
	}
	if err := writeAtomic(path, []byte(marshalMessage(m)), 0o644); err != nil {
		return "", err
	}
	_ = h.appendLedger(LedgerEntry{Kind: "mail.sent", AgentID: m.From, TaskID: m.TaskID, To: m.To, Note: m.Kind})
	return name, nil
}

// Deliver moves every message from every outbox into the recipient's inbox and
// ledgers each delivery. This is the router's single-writer step. Returns the
// number delivered.
func (h *Hive) Deliver() (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	agents, err := listDir(filepath.Join(h.Root, "agents"))
	if err != nil {
		return 0, err
	}
	delivered := 0
	for _, from := range agents {
		msgs, err := listDir(h.outbox(from))
		if err != nil {
			return delivered, err
		}
		for _, name := range msgs {
			if !strings.HasSuffix(name, ".md") {
				continue
			}
			src := filepath.Join(h.outbox(from), name)
			b, err := os.ReadFile(src)
			if err != nil {
				continue
			}
			m, err := parseMessage(string(b))
			if err != nil || m.To == "" {
				continue
			}
			if err := os.MkdirAll(h.inbox(m.To), 0o755); err != nil {
				return delivered, err
			}
			dst := filepath.Join(h.inbox(m.To), name)
			if err := writeAtomic(dst, b, 0o644); err != nil {
				return delivered, err
			}
			if err := os.Remove(src); err != nil {
				return delivered, err
			}
			_ = h.appendLedger(LedgerEntry{Kind: "mail.delivered", AgentID: from, TaskID: m.TaskID, To: m.To, Note: m.Kind})
			delivered++
		}
	}
	return delivered, nil
}

// Inbox lists an agent's inbox messages, oldest first.
func (h *Hive) Inbox(agentID string) ([]Message, error) {
	names, err := listDir(h.inbox(agentID))
	if err != nil {
		return nil, err
	}
	var out []Message
	for _, name := range names {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(h.inbox(agentID), name))
		if err != nil {
			continue
		}
		if m, err := parseMessage(string(b)); err == nil {
			m.Name = name
			out = append(out, m)
		}
	}
	return out, nil
}

// InboxCount returns how many messages an agent has waiting (the Stop-loop check).
func (h *Hive) InboxCount(agentID string) int {
	names, _ := listDir(h.inbox(agentID))
	n := 0
	for _, name := range names {
		if strings.HasSuffix(name, ".md") {
			n++
		}
	}
	return n
}

// ArchiveInbox drains an agent's inbox of messages for which keep returns false,
// moving them to a sibling `processed/` dir (an audit trail, not a delete). It
// returns how many were archived. The router uses this to retire fire-once
// `assign` messages after the worker has picked the task up, so the Stop-loop —
// which forces continuation while the inbox is non-empty — releases and the
// worker can stop cleanly. Without it a consumed assign lingers forever, pinning
// the worker in a re-kick/poll loop. Agents never run git on the hive, so the
// router (single writer) owns this move, per .ai/05-orchestration.md.
func (h *Hive) ArchiveInbox(agentID string, keep func(Message) bool) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	names, err := listDir(h.inbox(agentID))
	if err != nil {
		return 0, err
	}
	processed := filepath.Join(h.agentDir(agentID), "processed")
	moved := 0
	for _, name := range names {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		src := filepath.Join(h.inbox(agentID), name)
		b, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		m, err := parseMessage(string(b))
		if err != nil {
			continue // leave unparseable files in place rather than lose them
		}
		if keep(m) {
			continue
		}
		if err := os.MkdirAll(processed, 0o755); err != nil {
			return moved, err
		}
		if err := writeAtomic(filepath.Join(processed, name), b, 0o644); err != nil {
			return moved, err
		}
		if err := os.Remove(src); err != nil {
			return moved, err
		}
		_ = h.appendLedger(LedgerEntry{Kind: "mail.archived", AgentID: agentID, TaskID: m.TaskID, To: agentID, Note: m.Kind})
		moved++
	}
	return moved, nil
}

func marshalMessage(m Message) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "from: %s\n", m.From)
	fmt.Fprintf(&b, "to: %s\n", m.To)
	fmt.Fprintf(&b, "ts: %d\n", m.Ts)
	if m.TaskID != "" {
		fmt.Fprintf(&b, "task_id: %s\n", m.TaskID)
	}
	fmt.Fprintf(&b, "kind: %s\n", m.Kind)
	b.WriteString("---\n")
	b.WriteString(strings.TrimRight(m.Body, "\n"))
	b.WriteString("\n")
	return b.String()
}

func parseMessage(s string) (Message, error) {
	var m Message
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if !strings.HasPrefix(s, "---\n") {
		return m, fmt.Errorf("hive: message missing frontmatter")
	}
	rest := s[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return m, fmt.Errorf("hive: message frontmatter not terminated")
	}
	for _, line := range strings.Split(rest[:end], "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key, val = strings.TrimSpace(key), strings.TrimSpace(val)
		switch key {
		case "from":
			m.From = val
		case "to":
			m.To = val
		case "ts":
			m.Ts, _ = strconv.ParseInt(val, 10, 64)
		case "task_id":
			m.TaskID = val
		case "kind":
			m.Kind = val
		}
	}
	m.Body = strings.Trim(rest[end+4:], "\n")
	if m.From == "" || m.To == "" {
		return m, fmt.Errorf("hive: message missing from/to")
	}
	return m, nil
}

package telegram

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// StateFile is the bridge's own file in the data directory, mode 0600. The
// bot token and the chat id stay in config.json where the weekly report and
// the alerts have always read them (ADR-024); this holds what the bridge
// learns as it runs, so a restart neither replays old updates nor forgets
// which message belongs to which session.
const StateFile = "telegram.json"

// maxRefs bounds the messages remembered. A reply to a message older than
// the last few hundred is answered with "I no longer know which session that
// was", which is better than a file that grows for ever.
const maxRefs = 400

// Ref is what one message the bot sent is about.
type Ref struct {
	MessageID int64  `json:"message_id"`
	SessionID string `json:"session_id,omitempty"`
	// PromptID is the permission prompt an Approve or Deny under the message
	// answers; empty when it has no such buttons.
	PromptID string `json:"prompt_id,omitempty"`
	// Kind is what the message is: "alert", "reply", "stop" (a /stop
	// confirmation), "new" (a /new waiting for confirmation), "list".
	Kind string `json:"kind,omitempty"`
	At   int64  `json:"at"`
	// Module is the private module a "module" message came from; Buttons
	// its buttons' labels by id, Order their ids top to bottom; Chosen the
	// button pressed, whose "✓ <label>" the message now shows; Answers how
	// many answers it has had. Kept in telegram.json, so a module may edit
	// or reply under its message after a restart (ADR-076, amended
	// 2026-10-22).
	Module  string            `json:"module,omitempty"`
	Buttons map[string]string `json:"buttons,omitempty"`
	Order   []string          `json:"order,omitempty"`
	Chosen  string            `json:"chosen,omitempty"`
	Answers int               `json:"answers,omitempty"`
}

// State is the bridge's persisted state.
type State struct {
	// BotID and BotUsername are the bot the stored token belongs to, from
	// getMe; empty until a token was checked.
	BotID       int64  `json:"bot_id,omitempty"`
	BotUsername string `json:"bot_username,omitempty"`
	// ChatName is the paired chat as the Settings screen names it; ChatID is
	// the chat it was read from, so a chat id typed by hand (before pairing
	// existed) is told apart from a paired one.
	ChatName string `json:"chat_name,omitempty"`
	ChatID   string `json:"chat_id,omitempty"`
	PairedAt int64  `json:"paired_at,omitempty"`
	// Offset is the next update to read; everything below it was handled.
	Offset int64 `json:"offset,omitempty"`
	Refs   []Ref `json:"refs,omitempty"`
	// Muted sessions send nothing to Telegram; MuteAll silences every one.
	Muted   map[string]int64 `json:"muted,omitempty"`
	MuteAll bool             `json:"mute_all,omitempty"`
	// PremiumNoteAt is when a reply or command last got the one line that
	// says it is a Premium feature, so it is said at most once a day.
	PremiumNoteAt int64 `json:"premium_note_at,omitempty"`
	// ForwardReply is the forward picker's *Reply here* switch, as the
	// owner last left it (ADR-081); off until turned on.
	ForwardReply bool `json:"forward_reply,omitempty"`
}

// Store keeps State in memory and on disk. Safe for concurrent use.
type Store struct {
	path string
	mu   sync.Mutex
	st   State
}

// OpenStore reads dir's state file; a missing or unreadable one is an empty
// state (the bridge relearns everything it holds).
func OpenStore(dir string) *Store {
	s := &Store{path: filepath.Join(dir, StateFile)}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &s.st)
	}
	return s
}

// Get returns a copy of the state.
func (s *Store) Get() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := s.st
	cp.Refs = append([]Ref(nil), s.st.Refs...)
	cp.Muted = make(map[string]int64, len(s.st.Muted))
	for k, v := range s.st.Muted {
		cp.Muted[k] = v
	}
	return cp
}

// Update changes the state and writes it.
func (s *Store) Update(f func(*State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(&s.st)
	if n := len(s.st.Refs); n > maxRefs {
		s.st.Refs = append([]Ref(nil), s.st.Refs[n-maxRefs:]...)
	}
	return s.writeLocked()
}

func (s *Store) writeLocked() error {
	b, err := json.MarshalIndent(s.st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Reset forgets everything: a new bot, or the bridge switched off.
func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st = State{}
	if err := os.Remove(s.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Remember records what a sent message is about.
func (s *Store) Remember(r Ref) {
	if r.MessageID == 0 {
		return
	}
	if r.At == 0 {
		r.At = time.Now().UnixMilli()
	}
	_ = s.Update(func(st *State) { st.Refs = append(st.Refs, r) })
}

// Lookup finds what a sent message is about.
func (s *Store) Lookup(messageID int64) (Ref, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.st.Refs) - 1; i >= 0; i-- {
		if s.st.Refs[i].MessageID == messageID {
			return s.st.Refs[i], true
		}
	}
	return Ref{}, false
}

// UpdateRef changes the latest record of a sent message and writes it; false
// when no such message is remembered.
func (s *Store) UpdateRef(messageID int64, f func(*Ref)) bool {
	found := false
	_ = s.Update(func(st *State) {
		for i := len(st.Refs) - 1; i >= 0; i-- {
			if st.Refs[i].MessageID == messageID {
				f(&st.Refs[i])
				found = true
				return
			}
		}
	})
	return found
}

// NextAnswer counts one more answer to a sent message and returns the count.
func (s *Store) NextAnswer(messageID int64) int {
	n := 1
	_ = s.Update(func(st *State) {
		for i := len(st.Refs) - 1; i >= 0; i-- {
			if st.Refs[i].MessageID == messageID {
				st.Refs[i].Answers++
				n = st.Refs[i].Answers
				return
			}
		}
	})
	return n
}

// IsMuted reports whether a session sends nothing.
func (s *Store) IsMuted(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.MuteAll {
		return true
	}
	_, ok := s.st.Muted[sessionID]
	return ok
}

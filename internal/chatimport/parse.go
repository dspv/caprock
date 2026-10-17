// Package chatimport reads the conversation history a user exported from
// Claude.ai or ChatGPT themselves, and files each conversation as a read-only
// chat (ADR-074).
//
// Neither service offers a supported way for a third-party program to read a
// consumer account's conversations (OQ-22), so this is an import, never a
// sync: the user asks the service for their data, downloads the archive it
// emails them, and hands Caprock the archive or the conversations.json inside
// it. Caprock reads the file on this machine and calls nothing (rule 4).
//
// Neither service documents the file. The shapes read here are the ones
// open-source readers of the exports agree on (sources in OQ-22, read
// 2026-10-17), and every field is optional: a field a later export drops reads
// as empty, never as a failed import.
//
// Both archives carry a conversations.json that is one JSON array of
// conversations, which can run to hundreds of megabytes; it is decoded one
// conversation at a time, so memory follows the largest conversation, not the
// archive.
package chatimport

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Sources: what a conversation came from. The same values are stored as the
// imported chat's sessions.agent, so every screen that names an agent names
// the service.
const (
	SourceClaudeAI = "claude.ai"
	SourceChatGPT  = "chatgpt"
)

// IsSource reports whether an agent value is one of the import sources.
func IsSource(agent string) bool { return agent == SourceClaudeAI || agent == SourceChatGPT }

// SourceName is how a source is written on screen.
func SourceName(source string) string {
	switch source {
	case SourceClaudeAI:
		return "Claude.ai"
	case SourceChatGPT:
		return "ChatGPT"
	}
	return source
}

// MaxText caps one imported message, in runes. Higher than the live cap on an
// agent's prose (event.MaxAssistantText): an import is the user's own archive,
// read once, and the end of a long answer is often the part they kept it for.
const MaxText = 64000

// Conversation is one conversation from an export.
type Conversation struct {
	Source  string
	ID      string // the service's own conversation id
	Title   string
	Model   string // the model the service names, when it names one
	Created time.Time
	Updated time.Time
	// Messages is the conversation as the service shows it: the branch that
	// ends at its current message, not the edited versions beside it.
	Messages []Message
}

// Message is one message of a conversation.
type Message struct {
	ID   string
	Role string // "user" or "assistant"
	Text string
	At   time.Time
}

// ErrNotExport is returned for a file that is neither export.
var ErrNotExport = errors.New("this is not a Claude.ai or ChatGPT export: no conversations.json with conversations in it")

// File reads an export at p — the zip the service emailed, or the
// conversations.json from inside it — and calls fn for each conversation. An
// error from fn stops the read with that error.
func File(p string, fn func(Conversation) error) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 4)
	n, _ := io.ReadFull(f, head)
	if n == 4 && bytes.Equal(head, []byte("PK\x03\x04")) {
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		return Zip(f, fi.Size(), fn)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return JSON(f, fn)
}

// Zip reads conversations.json out of an export archive. The shallowest one
// wins, so a stray copy in a sub-folder does not shadow the export's own.
func Zip(r io.ReaderAt, size int64, fn func(Conversation) error) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return fmt.Errorf("read the archive: %w", err)
	}
	var best *zip.File
	depth := func(f *zip.File) int { return strings.Count(strings.ReplaceAll(f.Name, `\`, "/"), "/") }
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || path.Base(strings.ReplaceAll(f.Name, `\`, "/")) != "conversations.json" {
			continue
		}
		if best == nil || depth(f) < depth(best) {
			best = f
		}
	}
	if best == nil {
		return ErrNotExport
	}
	rc, err := best.Open()
	if err != nil {
		return fmt.Errorf("read conversations.json: %w", err)
	}
	defer rc.Close()
	return JSON(rc, fn)
}

// JSON reads a conversations.json: an array of conversations, each told apart
// by its own shape — Claude.ai's carry chat_messages, ChatGPT's a mapping.
func JSON(r io.Reader, fn func(Conversation) error) error {
	dec := json.NewDecoder(bufio.NewReaderSize(r, 1<<16))
	tok, err := dec.Token()
	if err != nil {
		return ErrNotExport
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return ErrNotExport
	}
	for i := 0; dec.More(); i++ {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return fmt.Errorf("conversation %d: %w", i+1, err)
		}
		c, ok, err := parse(raw)
		if err != nil {
			return fmt.Errorf("conversation %d: %w", i+1, err)
		}
		if !ok {
			if i == 0 {
				// The first element says what the file is; a file of
				// something else is not half-imported.
				return ErrNotExport
			}
			continue
		}
		if err := fn(c); err != nil {
			return err
		}
	}
	return nil
}

// parse reads one array element as whichever export it is. ok is false for
// an element that is neither.
func parse(raw json.RawMessage) (Conversation, bool, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return Conversation{}, false, nil //nolint:nilerr // not an object: not a conversation
	}
	if _, ok := probe["chat_messages"]; ok {
		c, err := parseClaude(raw)
		return c, err == nil, err
	}
	if _, ok := probe["mapping"]; ok {
		c, err := parseChatGPT(raw)
		return c, err == nil, err
	}
	return Conversation{}, false, nil
}

// --- Claude.ai -------------------------------------------------------------

type claudeConversation struct {
	UUID        string          `json:"uuid"`
	Name        string          `json:"name"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	CurrentLeaf string          `json:"current_leaf_message_uuid"`
	Messages    []claudeMessage `json:"chat_messages"`
}

type claudeMessage struct {
	UUID      string `json:"uuid"`
	Parent    string `json:"parent_message_uuid"`
	Sender    string `json:"sender"` // human | assistant
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
	Content   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Attachments []struct {
		FileName string `json:"file_name"`
	} `json:"attachments"`
	Files []struct {
		FileName string `json:"file_name"`
	} `json:"files"`
}

func parseClaude(raw json.RawMessage) (Conversation, error) {
	var in claudeConversation
	if err := json.Unmarshal(raw, &in); err != nil {
		return Conversation{}, fmt.Errorf("a Claude.ai conversation: %w", err)
	}
	if in.UUID == "" {
		return Conversation{}, errors.New("a Claude.ai conversation without a uuid")
	}
	c := Conversation{Source: SourceClaudeAI, ID: in.UUID, Title: strings.TrimSpace(in.Name),
		Created: isoTime(in.CreatedAt), Updated: isoTime(in.UpdatedAt)}
	for i, m := range claudeBranch(in) {
		role := ""
		switch m.Sender {
		case "human":
			role = "user"
		case "assistant":
			role = "assistant"
		default:
			continue
		}
		// The content blocks are the message as shown; `text` is the same
		// prose flattened, and the only field in older exports. A tool call,
		// a tool's result or a thinking block is not prose and is left out.
		var parts []string
		for _, b := range m.Content {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				parts = append(parts, strings.TrimSpace(b.Text))
			}
		}
		text := strings.Join(parts, "\n\n")
		if text == "" {
			text = strings.TrimSpace(m.Text)
		}
		var names []string
		for _, a := range m.Attachments {
			names = append(names, a.FileName)
		}
		for _, f := range m.Files {
			names = append(names, f.FileName)
		}
		text = withAttachments(text, names)
		if text == "" {
			continue
		}
		id := m.UUID
		if id == "" {
			id = strconv.Itoa(i)
		}
		c.Messages = append(c.Messages, Message{ID: id, Role: role, Text: clip(text), At: isoTime(m.CreatedAt)})
	}
	return finish(c), nil
}

// claudeBranch is the conversation as Claude.ai shows it. A message edited or
// a reply retried leaves a sibling in chat_messages, linked to the same
// parent; the shown branch is the path from the root to
// current_leaf_message_uuid. An export without the links, or whose leaf is
// not among its messages, is read in its own order.
func claudeBranch(in claudeConversation) []claudeMessage {
	byID := make(map[string]int, len(in.Messages))
	for i, m := range in.Messages {
		if m.UUID != "" {
			byID[m.UUID] = i
		}
	}
	at, ok := byID[in.CurrentLeaf]
	if !ok {
		return in.Messages
	}
	var path []claudeMessage
	seen := map[string]bool{}
	for {
		m := in.Messages[at]
		if seen[m.UUID] {
			break
		}
		seen[m.UUID] = true
		path = append(path, m)
		next, ok := byID[m.Parent]
		if !ok {
			break
		}
		at = next
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// --- ChatGPT ---------------------------------------------------------------

type gptConversation struct {
	ID             string             `json:"id"`
	ConversationID string             `json:"conversation_id"`
	Title          string             `json:"title"`
	CreateTime     *float64           `json:"create_time"`
	UpdateTime     *float64           `json:"update_time"`
	CurrentNode    string             `json:"current_node"`
	DefaultModel   string             `json:"default_model_slug"`
	Mapping        map[string]gptNode `json:"mapping"`
}

type gptNode struct {
	ID       string      `json:"id"`
	Parent   *string     `json:"parent"`
	Children []string    `json:"children"`
	Message  *gptMessage `json:"message"`
}

type gptMessage struct {
	ID     string `json:"id"`
	Author struct {
		Role string `json:"role"`
	} `json:"author"`
	CreateTime *float64 `json:"create_time"`
	Content    struct {
		ContentType string            `json:"content_type"`
		Parts       []json.RawMessage `json:"parts"`
		Text        string            `json:"text"`
	} `json:"content"`
	Metadata struct {
		ModelSlug string `json:"model_slug"`
		Hidden    bool   `json:"is_visually_hidden_from_conversation"`
	} `json:"metadata"`
}

func parseChatGPT(raw json.RawMessage) (Conversation, error) {
	var in gptConversation
	if err := json.Unmarshal(raw, &in); err != nil {
		return Conversation{}, fmt.Errorf("a ChatGPT conversation: %w", err)
	}
	id := in.ConversationID
	if id == "" {
		id = in.ID
	}
	if id == "" {
		return Conversation{}, errors.New("a ChatGPT conversation without an id")
	}
	c := Conversation{Source: SourceChatGPT, ID: id, Title: strings.TrimSpace(in.Title),
		Created: unixTime(in.CreateTime), Updated: unixTime(in.UpdateTime), Model: in.DefaultModel}
	for _, n := range gptBranch(in) {
		m := n.Message
		if m == nil || m.Metadata.Hidden {
			continue
		}
		role := m.Author.Role
		if role != "user" && role != "assistant" {
			continue // system, tool: not the conversation as the user saw it
		}
		text := gptText(m)
		if text == "" {
			continue
		}
		if role == "assistant" && m.Metadata.ModelSlug != "" {
			c.Model = m.Metadata.ModelSlug
		}
		mid := m.ID
		if mid == "" {
			mid = n.ID
		}
		c.Messages = append(c.Messages, Message{ID: mid, Role: role, Text: clip(text), At: unixTime(m.CreateTime)})
	}
	return finish(c), nil
}

// gptBranch is the conversation as ChatGPT shows it: the path from the root
// to current_node. An edited message leaves its earlier versions in the
// mapping as siblings; they are not on this path. Without a current_node the
// newest leaf stands in for it.
func gptBranch(in gptConversation) []gptNode {
	cur := in.CurrentNode
	if _, ok := in.Mapping[cur]; !ok {
		cur = ""
		best := -1.0
		ids := make([]string, 0, len(in.Mapping))
		for k := range in.Mapping {
			ids = append(ids, k)
		}
		sort.Strings(ids)
		for _, k := range ids {
			n := in.Mapping[k]
			if len(n.Children) > 0 {
				continue
			}
			t := 0.0
			if n.Message != nil && n.Message.CreateTime != nil {
				t = *n.Message.CreateTime
			}
			if t > best {
				best, cur = t, k
			}
		}
	}
	var path []gptNode
	seen := map[string]bool{}
	for k := cur; k != "" && !seen[k]; {
		seen[k] = true
		n, ok := in.Mapping[k]
		if !ok {
			break
		}
		if n.ID == "" {
			n.ID = k
		}
		path = append(path, n)
		k = ""
		if n.Parent != nil {
			k = *n.Parent
		}
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// gptText is a message's prose. Text parts are strings; an image, a file or a
// voice clip is an object, written as a marker so the turn is not silently
// empty. A reasoning summary, the custom-instructions context and the like
// are not the conversation and are left out.
func gptText(m *gptMessage) string {
	switch m.Content.ContentType {
	case "text", "multimodal_text", "":
	case "code":
		if t := strings.TrimSpace(m.Content.Text); t != "" {
			return "```\n" + t + "\n```"
		}
		return ""
	default:
		return ""
	}
	var parts []string
	for _, p := range m.Content.Parts {
		var s string
		if err := json.Unmarshal(p, &s); err == nil {
			if s = cleanGPT(s); s != "" {
				parts = append(parts, s)
			}
			continue
		}
		var obj struct {
			ContentType string `json:"content_type"`
			Text        string `json:"text"`
		}
		if err := json.Unmarshal(p, &obj); err != nil {
			continue
		}
		switch {
		case strings.Contains(obj.ContentType, "image"):
			parts = append(parts, "[Image]")
		case strings.Contains(obj.ContentType, "audio"):
			if t := strings.TrimSpace(obj.Text); t != "" {
				parts = append(parts, t)
			} else {
				parts = append(parts, "[Voice]")
			}
		case strings.TrimSpace(obj.Text) != "":
			parts = append(parts, cleanGPT(obj.Text))
		}
	}
	return strings.Join(parts, "\n\n")
}

// citation is a source marker newer ChatGPT exports leave in the prose:
// private-use characters around a reference such as "cite turn0search0"
// (observed by Cherry Studio's importer, read 2026-10-17). It means nothing
// outside ChatGPT's own page.
var citation = regexp.MustCompile("[^]*")

func cleanGPT(s string) string {
	s = citation.ReplaceAllString(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Co, r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// --- shared ----------------------------------------------------------------

// finish fills the times a conversation lacks from the ones it has, so every
// message has a moment and the messages read in order.
func finish(c Conversation) Conversation {
	if c.Created.IsZero() {
		for _, m := range c.Messages {
			if !m.At.IsZero() {
				c.Created = m.At
				break
			}
		}
	}
	if c.Created.IsZero() {
		c.Created = c.Updated
	}
	if c.Created.IsZero() {
		// No time anywhere in it: dated to when it was read, not to 1970.
		c.Created = time.Now()
	}
	prev := c.Created
	for i := range c.Messages {
		if c.Messages[i].At.IsZero() || c.Messages[i].At.Before(prev) {
			// A message with no time, or one stamped before the message it
			// answers, is placed just after that message.
			c.Messages[i].At = prev.Add(time.Millisecond)
		}
		prev = c.Messages[i].At
	}
	if c.Updated.IsZero() || prev.After(c.Updated) {
		c.Updated = prev
	}
	return c
}

func withAttachments(text string, names []string) string {
	var b strings.Builder
	b.WriteString(text)
	for _, n := range names {
		if n = strings.TrimSpace(n); n == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("[Attached: " + n + "]")
	}
	return strings.TrimSpace(b.String())
}

func clip(s string) string {
	r := []rune(s)
	if len(r) <= MaxText {
		return s
	}
	return string(r[:MaxText]) + "…"
}

func isoTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func unixTime(f *float64) time.Time {
	if f == nil || *f <= 0 || math.IsNaN(*f) || math.IsInf(*f, 0) {
		return time.Time{}
	}
	return time.UnixMilli(int64(*f * 1000))
}

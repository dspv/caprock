// Package deepseek reads DeepSeek Harness (DSH) session transcripts.
//
// DSH writes one append-only JSONL transcript per session, compressed with
// Zstandard, under <dsh-home>/sessions/<encoded-cwd>/<session-id>/. The current
// on-disk format is v3 (session.v3.jsonl.zstd); older sessions carry
// session.jsonl.zstd (v0) with the same record kinds. Every record carries a
// monotonic `seq`, which is what makes a re-read idempotent.
//
// Like Codex, DSH reports token counts and never a cost of its own, so the
// turns are priced by Caprock's own pricing table (pricing/pricing.json grew
// DeepSeek rows long ago — see .ai/14-build-status.md).
package deepseek

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Agent is the value written to sessions.agent for DeepSeek Harness sessions.
const Agent = "deepseek"

// EnvDir overrides the sessions root, for tests and anyone whose DSH home
// lives somewhere unusual.
const EnvDir = "CAPROCK_DSH_DIR"

// EnvHome is DSH's own override for its data root; honoured so Caprock reads
// the same sessions a user redirected DSH to.
const EnvHome = "DSH_HOME"

// maxLine bounds one JSONL record. DSH embeds whole file contents in tool
// results, so a line is occasionally very large; this is generous enough for
// real transcripts and still refuses a runaway.
const maxLine = 32 << 20

// maxText caps the assistant prose kept per turn, matching the Claude
// transcript parser's cap so one source does not grow unbounded while another
// is clipped.
const maxText = 16000

// Dir is the root DSH writes its session transcripts under.
//
// The path follows DSH's own resolution: $DSH_HOME names the data root
// directly (it already *is* the home, usually ~/.dsh), and otherwise the
// default ~/.dsh is used — matching the harness so Caprock reads the sessions
// a user redirected. CAPROCK_DSH_DIR overrides both for tests.
func Dir() string {
	if d := strings.TrimSpace(os.Getenv(EnvDir)); d != "" {
		return d
	}
	root := strings.TrimSpace(os.Getenv(EnvHome))
	if root == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		root = filepath.Join(h, ".dsh")
	}
	return filepath.Join(root, "sessions")
}

// Session is one DSH session transcript, parsed.
type Session struct {
	ID        string
	Path      string
	Cwd       string
	Model     string
	StartedAt time.Time
	Turns     []Turn
	Tools     []ToolCall
	Users     []UserMsg
}

// Turn is one assistant turn: its token usage (already reduced to a delta) and
// its visible prose, which powers the searchable Answers screen.
type Turn struct {
	At time.Time
	// Key is stable across re-reads: the transcript is append-only, so the seq
	// of the record that produced the turn identifies it forever.
	Key string
	// Model is the per-turn model DSH recorded for this message.
	Model string
	In    int64
	Out   int64
	// CacheRead is the cached part of the prompt, billed at the cache-read
	// rate. DSH reports it separately from fresh input, so no subtraction is
	// needed — unlike Codex, whose input total embeds the cached part.
	CacheRead  int64
	CacheWrite int64
	// Reasoning tokens are billed as output and already included in Out;
	// carried separately only so a reader can see the split.
	Reasoning int64
	// Text is the visible assistant prose, capped. Reasoning blocks are never
	// stored (the same rule Claude's extended thinking is held to).
	Text string
}

// ToolCall is one tool invocation.
type ToolCall struct {
	At   time.Time
	Key  string
	Name string
	// Input is the raw arguments JSON as recorded.
	Input string
}

// UserMsg is one user prompt.
type UserMsg struct {
	At   time.Time
	Key  string
	Text string
}

// Transcript is a session file found on disk, before parsing.
type Transcript struct {
	Path     string
	Modified time.Time
	Size     int64
}

// ErrNotASession is returned for a file that is not a DSH session transcript.
var ErrNotASession = errors.New("deepseek: not a session transcript")

// List returns every DSH session transcript under dir.
func List(dir string) ([]Transcript, error) {
	if dir == "" {
		return nil, nil
	}
	var out []Transcript
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return fs.SkipDir
			}
			// A transcript root belongs to another application. Skip an
			// unreadable entry and keep discovering sessions elsewhere.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !isTranscript(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, Transcript{Path: path, Modified: info.ModTime(), Size: info.Size()})
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	// DSH can leave the v0 file beside its v3 replacement during upgrade.
	// They describe one session; prefer v3 so status counts and polling work
	// are not doubled even though event keys would deduplicate the writes.
	byDir := make(map[string]Transcript, len(out))
	for _, tr := range out {
		dir := filepath.Dir(tr.Path)
		old, ok := byDir[dir]
		if !ok || filepath.Base(tr.Path) == "session.v3.jsonl.zstd" {
			byDir[dir] = tr
		} else if filepath.Base(old.Path) == "session.v3.jsonl.zstd" {
			continue
		}
	}
	out = out[:0]
	for _, tr := range byDir {
		out = append(out, tr)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out, nil
}

// isTranscript reports whether a filename is a DSH session file. v3 is the
// current format; the unprefixed name is the older v0 format DSH still writes
// for sessions that predate the migration. Both carry the same record kinds.
func isTranscript(name string) bool {
	return name == "session.v3.jsonl.zstd" || name == "session.jsonl.zstd"
}

// ParseFile decodes one transcript into a Session.
func ParseFile(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec, err := zstd.NewReader(f, zstd.WithDecoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	defer dec.Close()

	s := &Session{Path: path}
	sc := bufio.NewScanner(dec)
	sc.Buffer(make([]byte, 64*1024), maxLine)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		_ = s.parseLine(line) // a malformed record is skipped, never fatal
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if s.ID == "" {
		return nil, ErrNotASession
	}
	return s, nil
}

// record is the shared envelope every JSONL line carries. The "session" header
// record puts its id/cwd/createdAt at the top level rather than under "data",
// which every other record kind does.
type record struct {
	Type string          `json:"type"`
	Seq  int64           `json:"seq"`
	Time int64           `json:"time"`
	Data json.RawMessage `json:"data"`
	ID   string          `json:"id"`
	Cwd  string          `json:"cwd"`
	// CreatedAt is only meaningful on the session header; zero elsewhere.
	CreatedAt int64 `json:"createdAt"`
}

// contentBlock is one element of a message's content array.
type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// parseLine consumes one JSONL record. Fields are read defensively: an
// unexpected shape costs at most that one record, never the whole session —
// the same rule Codex's importer holds to, because DSH is free to change any of
// these between releases.
func (s *Session) parseLine(line []byte) error {
	var r record
	if err := json.Unmarshal(line, &r); err != nil {
		return err
	}
	var at time.Time
	if r.Time != 0 {
		at = time.UnixMilli(r.Time)
	}

	switch r.Type {
	case "session":
		s.ID = r.ID
		s.Cwd = r.Cwd
		if r.CreatedAt != 0 {
			s.StartedAt = time.UnixMilli(r.CreatedAt)
		}

	case "assistant/message":
		var m struct {
			Message struct {
				Content []contentBlock `json:"content"`
				Source  struct {
					Model string `json:"model"`
				} `json:"source"`
			} `json:"message"`
			Usage struct {
				InputTokens     int64 `json:"inputTokens"`
				OutputTokens    int64 `json:"outputTokens"`
				CacheReadTokens int64 `json:"cacheReadTokens"`
				ReasoningTokens int64 `json:"reasoningTokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(r.Data, &m); err != nil {
			return err
		}
		t := Turn{
			At:         at,
			Key:        "dsh:turn:" + strconv.FormatInt(r.Seq, 10),
			Model:      m.Message.Source.Model,
			In:         m.Usage.InputTokens,
			Out:        m.Usage.OutputTokens,
			CacheRead:  m.Usage.CacheReadTokens,
			CacheWrite: 0, // DSH reports no cache-write split
			Reasoning:  m.Usage.ReasoningTokens,
			Text:       visibleText(m.Message.Content),
		}
		if t.Model != "" {
			s.Model = t.Model
		}
		s.Turns = append(s.Turns, t)

	case "tool/call":
		var c struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		}
		if err := json.Unmarshal(r.Data, &c); err != nil {
			return err
		}
		s.Tools = append(s.Tools, ToolCall{
			At:    at,
			Key:   "dsh:tool:" + strconv.FormatInt(r.Seq, 10),
			Name:  c.Name,
			Input: c.Arguments,
		})

	case "user/message":
		var u struct {
			Content []contentBlock `json:"content"`
		}
		if err := json.Unmarshal(r.Data, &u); err != nil {
			return err
		}
		if text := visibleText(u.Content); text != "" {
			s.Users = append(s.Users, UserMsg{
				At:   at,
				Key:  "dsh:user:" + strconv.FormatInt(r.Seq, 10),
				Text: text,
			})
		}
	}
	return nil
}

// visibleText joins the "text" blocks of a message's content. Reasoning blocks
// are deliberately dropped — they are the model's private thinking, and the
// same reason Claude's extended thinking is never stored applies here.
func visibleText(content []contentBlock) string {
	var parts []string
	for _, b := range content {
		if b.Type == "text" {
			if t := strings.TrimSpace(b.Text); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return clipRunes(strings.Join(parts, "\n"), maxText)
}

// clipRunes truncates s to at most n runes without splitting a multi-byte rune.
func clipRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

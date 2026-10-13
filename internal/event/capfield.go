package event

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxToolField bounds what one tool field — a call's tool_input or its
// tool_response — keeps in the database, in bytes of JSON.
//
// Every plane that stores a tool call goes through CapToolField: the
// transcript parser and the hook receiver both, so the row that wins the
// dedup race (the hook copy, nearly always) is held to the same rule as the
// one that loses it. Before this the hook copy was stored verbatim up to the
// 4 MiB body limit: on the owner's machine (2026-10-13) hook tool results were
// 1.1 GB of a 2.2 GB database, 3,808 rows over 64 KB held 790 MB of it, and
// the largest were base64 screenshots nobody reads back from the database.
//
// What is kept is what the screens read: the structure, every short field
// (paths, commands, exit codes, flags, ids, `gitOperation`), and the first
// MaxToolField bytes of long text. The size the call really handed back is
// carried separately (Event.ToolBytes), so the tool-size figures still count
// the original.
const MaxToolField = 32 << 10

// minFieldKeep is the least any one string keeps once the field's budget is
// spent on its siblings, so a long field is shortened, never emptied.
const minFieldKeep = 256

// CapToolField returns raw bounded to MaxToolField. The value keeps its shape:
//
//   - a string longer than the budget is clipped on a rune boundary and ends
//     with a marker naming what was dropped: `…[truncated 81234 bytes]`, plus
//     `, 312 lines` when the dropped part held line breaks (ClipString);
//   - base64 content — an image block's `data`, Claude Code's `file.base64`,
//     an MCP screenshot, a `data:` URI — is replaced by a marker naming its
//     media type and decoded size, at any size: `[image image/png 512 KB not
//     stored]`;
//   - objects keep every key, and their short values whole: fields are given
//     the budget smallest first, so one huge field cannot crowd out an exit
//     code;
//   - arrays keep their elements until the budget is spent, then end with
//     `[N more items not stored]`.
//
// A value already within the budget and with nothing base64 in it is
// returned as it is, without being decoded.
func CapToolField(raw json.RawMessage) json.RawMessage {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return raw
	}
	if len(raw) <= MaxToolField && !mayHoldBinary(raw) {
		return raw
	}
	return capValue(raw, MaxToolField)
}

// mayHoldBinary is the cheap test that decides whether a small value needs
// the walk at all. Every base64 shape CapToolField recognises names "base64"
// or "image" somewhere in its JSON.
func mayHoldBinary(raw []byte) bool {
	return bytes.Contains(raw, []byte("base64")) || bytes.Contains(raw, []byte(`"image"`))
}

func capValue(raw json.RawMessage, budget int) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return raw
		}
		if m, ok := dataURIMarker(s); ok {
			return marshal(m)
		}
		if len(raw) <= budget {
			return raw
		}
		return marshal(ClipString(s, max(budget, minFieldKeep)))
	case '{':
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			return raw
		}
		for _, k := range []string{"data", "base64"} {
			if v, ok := m[k]; ok && binaryField(k, v, m) {
				m[k] = marshal(binaryMarker(v, m))
			}
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if len(m[keys[i]]) != len(m[keys[j]]) {
				return len(m[keys[i]]) < len(m[keys[j]])
			}
			return keys[i] < keys[j]
		})
		left := budget
		for _, k := range keys {
			v := capValue(m[k], max(left, minFieldKeep))
			m[k] = v
			left -= len(v) + len(k) + 4
		}
		return marshal(m)
	case '[':
		var a []json.RawMessage
		if json.Unmarshal(raw, &a) != nil {
			return raw
		}
		out := make([]json.RawMessage, 0, len(a))
		left := budget
		for i, v := range a {
			if left < minFieldKeep && i > 0 {
				out = append(out, marshal(fmt.Sprintf("[%d more items not stored]", len(a)-i)))
				break
			}
			cv := capValue(v, max(left, minFieldKeep))
			out = append(out, cv)
			left -= len(cv) + 1
		}
		return marshal(out)
	default:
		return raw
	}
}

// binaryField reports whether m[k] is base64 content. `base64` is one by its
// name (Claude Code's Read of an image); `data` is one beside a media type or
// in a block whose type says so (the API's image source, an MCP image).
func binaryField(k string, v json.RawMessage, m map[string]json.RawMessage) bool {
	if len(v) == 0 || v[0] != '"' {
		return false
	}
	if k == "base64" {
		return true
	}
	if mediaOf(m) != "" {
		return true
	}
	switch str(m["type"]) {
	case "base64", "image", "audio", "document":
		return true
	}
	return false
}

// mediaOf is the media type an object declares for its base64 content.
func mediaOf(m map[string]json.RawMessage) string {
	for _, k := range []string{"media_type", "mimeType", "mime_type"} {
		if s := str(m[k]); s != "" {
			return s
		}
	}
	if t := str(m["type"]); strings.Contains(t, "/") {
		return t
	}
	return ""
}

func binaryMarker(v json.RawMessage, m map[string]json.RawMessage) string {
	var s string
	_ = json.Unmarshal(v, &s)
	kind := "file"
	media := mediaOf(m)
	if strings.HasPrefix(media, "image/") || str(m["type"]) == "image" {
		kind = "image"
	}
	return notStored(kind, media, decodedLen(s))
}

// dataURIMarker replaces a `data:<media>;base64,…` string.
func dataURIMarker(s string) (string, bool) {
	if !strings.HasPrefix(s, "data:") {
		return "", false
	}
	head, body, ok := strings.Cut(s, ",")
	if !ok || !strings.HasSuffix(head, ";base64") {
		return "", false
	}
	media := strings.TrimSuffix(strings.TrimPrefix(head, "data:"), ";base64")
	kind := "file"
	if strings.HasPrefix(media, "image/") {
		kind = "image"
	}
	return notStored(kind, media, decodedLen(body)), true
}

func notStored(kind, media string, n int) string {
	var b strings.Builder
	b.WriteString("[")
	b.WriteString(kind)
	if media != "" {
		b.WriteString(" ")
		b.WriteString(media)
	}
	b.WriteString(" ")
	b.WriteString(HumanBytes(n))
	b.WriteString(" not stored]")
	return b.String()
}

// decodedLen is how many bytes a base64 string decodes to.
func decodedLen(s string) int {
	s = strings.TrimRight(s, "=")
	return len(s) * 3 / 4
}

// HumanBytes spells a size the way the markers do: 300 B, 512 KB, 1.4 MB.
func HumanBytes(n int) string {
	switch {
	case n < 1<<10:
		return strconv.Itoa(n) + " B"
	case n < 1<<20:
		return strconv.Itoa((n+512)>>10) + " KB"
	default:
		return strconv.FormatFloat(float64(n)/float64(1<<20), 'f', 1, 64) + " MB"
	}
}

// clipMark opens the marker ClipString appends.
const clipMark = "…[truncated "

// ClipString keeps at most n bytes of s, cut on a rune boundary, and says
// what it dropped: `…[truncated 81234 bytes]`, or `…[truncated 81234 bytes,
// 312 lines]` when the dropped part held line breaks — so a count of lines
// written (the week's lines added) can still be made from a clipped Write.
func ClipString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	dropped := s[cut:]
	mark := clipMark + strconv.Itoa(len(dropped)) + " bytes"
	if l := strings.Count(dropped, "\n"); l > 0 {
		mark += ", " + strconv.Itoa(l) + " lines"
	}
	return s[:cut] + mark + "]"
}

// SplitClip undoes what ClipString added: the kept text, and the line breaks
// that were dropped with the rest. A string ClipString did not clip comes
// back whole with zero.
func SplitClip(s string) (kept string, droppedLines int) {
	if !strings.HasSuffix(s, "]") {
		return s, 0
	}
	i := strings.LastIndex(s, clipMark)
	if i < 0 {
		return s, 0
	}
	tail := strings.TrimSuffix(s[i+len(clipMark):], "]")
	num, rest, _ := strings.Cut(tail, " bytes")
	if _, err := strconv.Atoi(num); err != nil {
		return s, 0
	}
	switch {
	case rest == "":
		return s[:i], 0
	case strings.HasPrefix(rest, ", ") && strings.HasSuffix(rest, " lines"):
		l, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(rest, ", "), " lines"))
		if err != nil {
			return s, 0
		}
		return s[:i], l
	}
	return s, 0
}

func str(v json.RawMessage) string {
	if len(v) == 0 || v[0] != '"' {
		return ""
	}
	var s string
	_ = json.Unmarshal(v, &s)
	return s
}

func marshal(v any) json.RawMessage {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// Stored text is read back as JSON, never put in a page as HTML, and
	// escaping < > & would grow every clipped diff for nothing.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return json.RawMessage(`null`)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

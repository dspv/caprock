package event

import (
	"bytes"
	"encoding/json"
	"strings"
)

// minBinaryLen is the shortest string StripBinary takes for base64 content.
// A real image or file is kilobytes; below this a "data" field is far more
// likely a short value that merely sits beside a media type.
const minBinaryLen = 256

// StripBinary replaces the base64 content anywhere in a stored payload with
// the marker CapToolField writes — `[image image/png 512 KB not stored]` —
// and leaves everything else as it is: no text is clipped, no array is cut,
// no key is dropped. It is what the payload compaction applies to rows stored
// before CapToolField existed (store.CompactPayloads), where long text is to
// be kept and only the screenshots go.
//
// It is stricter than CapToolField about what counts as base64, because it
// walks whole payloads written by every version of every plane rather than
// one tool field. Besides the shape CapToolField recognises — a `base64` key;
// a `data` key beside a media type, or in an image, audio, document or base64
// block; a `data:<media>;base64,` string — the content must be at least
// minBinaryLen bytes of the base64 alphabet. A marker is not base64, so a
// second pass changes nothing.
//
// changed is false, and raw comes back as it was, when there was nothing to
// replace. When something was, the objects on the way to it are re-encoded
// (keys in sorted order); everything beside them keeps its bytes.
func StripBinary(raw json.RawMessage) (out json.RawMessage, changed bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || !mayHoldBinary(raw) && !bytes.Contains(raw, []byte(`"data:`)) {
		return raw, false
	}
	return stripValue(raw)
}

func stripValue(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return raw, false
	}
	switch raw[0] {
	case '"':
		if !bytes.HasPrefix(raw, []byte(`"data:`)) {
			return raw, false
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return raw, false
		}
		if _, body, _ := strings.Cut(s, ","); !looksBase64(body) {
			return raw, false
		}
		if m, ok := dataURIMarker(s); ok {
			return marshal(m), true
		}
		return raw, false
	case '{':
		var m map[string]json.RawMessage
		if json.Unmarshal(raw, &m) != nil {
			return raw, false
		}
		changed := false
		for k, v := range m {
			if (k == "data" || k == "base64") && binaryField(k, v, m) && looksBase64(str(v)) {
				m[k] = marshal(binaryMarker(v, m))
				changed = true
				continue
			}
			if nv, ok := stripValue(v); ok {
				m[k] = nv
				changed = true
			}
		}
		if !changed {
			return raw, false
		}
		return marshal(m), true
	case '[':
		var a []json.RawMessage
		if json.Unmarshal(raw, &a) != nil {
			return raw, false
		}
		changed := false
		for i, v := range a {
			if nv, ok := stripValue(v); ok {
				a[i] = nv
				changed = true
			}
		}
		if !changed {
			return raw, false
		}
		return marshal(a), true
	default:
		return raw, false
	}
}

// looksBase64 reports whether s is at least minBinaryLen bytes of the base64
// alphabet: standard or URL-safe, padded or not, line breaks allowed.
func looksBase64(s string) bool {
	if len(s) < minBinaryLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '+', c == '/', c == '=', c == '-', c == '_', c == '\n', c == '\r':
		default:
			return false
		}
	}
	return true
}

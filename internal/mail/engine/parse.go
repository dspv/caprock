package engine

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"html"
	"io"
	"mime/quotedprintable"
	"net/textproto"
	"regexp"
	"strconv"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-message/charset"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// partPath renders an IMAP part path: [1 2] → "1.2".
func partPath(p []int) string {
	if len(p) == 0 {
		return "1"
	}
	s := make([]string, len(p))
	for i, n := range p {
		s[i] = strconv.Itoa(n)
	}
	return strings.Join(s, ".")
}

// parsePath reverses partPath.
func parsePath(s string) []int {
	var out []int
	for _, f := range strings.Split(s, ".") {
		n, err := strconv.Atoi(f)
		if err != nil || n <= 0 {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// structureOf picks the text and HTML bodies and lists attachments.
func structureOf(bs imap.BodyStructure) store.Structure {
	var st store.Structure
	if bs == nil {
		return st
	}
	// Inside multipart/alternative the last part is the preferred one; elsewhere
	// the first text part is the body and later ones are attachments.
	bs.Walk(func(path []int, part imap.BodyStructure) bool {
		sp, ok := part.(*imap.BodyStructureSinglePart)
		if !ok {
			return true
		}
		p := store.Part{
			Path:      partPath(path),
			Type:      sp.MediaType(),
			Charset:   sp.Params["charset"],
			Encoding:  strings.ToLower(sp.Encoding),
			Filename:  sp.Filename(),
			Size:      int64(sp.Size),
			ContentID: strings.Trim(sp.ID, "<>"),
		}
		disp := ""
		if d := sp.Disposition(); d != nil {
			disp = strings.ToLower(d.Value)
		}
		isAttach := disp == "attachment" || (p.Filename != "" && disp != "inline")
		switch {
		case p.Type == "text/plain" && !isAttach && st.Text == nil:
			q := p
			st.Text = &q
		case p.Type == "text/html" && !isAttach && st.HTML == nil:
			q := p
			st.HTML = &q
		case p.Type == "message/rfc822":
			p.IsAttach = true
			if p.Filename == "" {
				p.Filename = "message.eml"
			}
			st.Parts = append(st.Parts, p)
		default:
			if strings.HasPrefix(p.Type, "multipart/") {
				return true
			}
			p.Inline = disp == "inline" || (p.ContentID != "" && disp == "")
			p.IsAttach = isAttach || !p.Inline
			if p.Filename == "" && p.IsAttach {
				p.Filename = "part-" + p.Path
			}
			st.Parts = append(st.Parts, p)
		}
		return true
	})
	return st
}

// hasAttachments reports whether any part is a real attachment (not an inline image).
func hasAttachments(st store.Structure) bool {
	for _, p := range st.Parts {
		if p.IsAttach {
			return true
		}
	}
	return false
}

// decodePart undoes the transfer encoding and converts to UTF-8.
func decodePart(raw []byte, encoding, cs string) string {
	b := decodeTransfer(raw, encoding)
	if cs != "" && !strings.EqualFold(cs, "utf-8") && !strings.EqualFold(cs, "us-ascii") {
		if r, err := charset.Reader(cs, bytes.NewReader(b)); err == nil {
			if out, err := io.ReadAll(r); err == nil {
				b = out
			}
		}
	}
	return strings.ToValidUTF8(string(b), "�")
}

// decodeTransfer undoes base64 or quoted-printable.
func decodeTransfer(raw []byte, encoding string) []byte {
	switch strings.ToLower(encoding) {
	case "base64":
		clean := bytes.Map(func(r rune) rune {
			if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, raw)
		out := make([]byte, base64.StdEncoding.DecodedLen(len(clean)))
		n, err := base64.StdEncoding.Decode(out, clean)
		if err != nil && n == 0 {
			if n2, err2 := base64.RawStdEncoding.Decode(out, bytes.TrimRight(clean, "=")); err2 == nil {
				return out[:n2]
			}
		}
		return out[:n]
	case "quoted-printable":
		out, err := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(raw)))
		if err != nil && len(out) == 0 {
			return raw
		}
		return out
	}
	return raw
}

// parseHeaderFields reads a fetched HEADER.FIELDS section.
func parseHeaderFields(b []byte) textproto.MIMEHeader {
	r := textproto.NewReader(bufio.NewReader(io.MultiReader(bytes.NewReader(b), strings.NewReader("\r\n"))))
	h, _ := r.ReadMIMEHeader()
	return h
}

var msgIDRe = regexp.MustCompile(`<([^<>\s]+)>`)

// msgIDs extracts the identifiers from a References header, without brackets.
func msgIDs(s string) []string {
	var out []string
	for _, m := range msgIDRe.FindAllStringSubmatch(s, -1) {
		out = append(out, m[1])
	}
	return out
}

var (
	reTagsBlock = regexp.MustCompile(`(?is)<(script|style|head|title)[^>]*>.*?</(script|style|head|title)>`)
	reBreaks    = regexp.MustCompile(`(?i)<(br|/p|/div|/tr|/li|/h[1-6]|/table|/blockquote)[^>]*>`)
	reTag       = regexp.MustCompile(`(?s)<[^>]*>`)
	reBlank     = regexp.MustCompile(`\n[ \t]*\n([ \t]*\n)+`)
	reSpaces    = regexp.MustCompile(`[ \t\x{00a0}]+`)
	reComment   = regexp.MustCompile(`(?s)<!--.*?-->`)
)

// htmlToText turns an HTML body into readable plain text for search and snippets.
func htmlToText(h string) string {
	s := reComment.ReplaceAllString(h, "")
	s = reTagsBlock.ReplaceAllString(s, "")
	s = reBreaks.ReplaceAllString(s, "\n")
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reSpaces.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	s = strings.Join(lines, "\n")
	s = reBlank.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// snippet is the first readable line of a body, skipping quotes.
func snippet(text string) string {
	var b strings.Builder
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, ">") {
			continue
		}
		if strings.HasPrefix(l, "On ") && strings.HasSuffix(l, "wrote:") {
			break
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(l)
		if b.Len() > 240 {
			break
		}
	}
	s := reSpaces.ReplaceAllString(b.String(), " ")
	r := []rune(s)
	if len(r) > 200 {
		s = string(r[:200]) + "…"
	}
	return s
}

// normSubject strips reply and forward prefixes for subject threading.
func normSubject(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	for {
		t := s
		for _, p := range []string{"re:", "fw:", "fwd:", "aw:", "wg:", "sv:", "vs:", "tr:", "rif:"} {
			if strings.HasPrefix(s, p) {
				s = strings.TrimSpace(s[len(p):])
			}
		}
		if strings.HasPrefix(s, "[") {
			if i := strings.IndexByte(s, ']'); i > 0 && i < 40 {
				s = strings.TrimSpace(s[i+1:])
			}
		}
		if s == t {
			return s
		}
	}
}

var (
	reRemoveTags = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>|<script[^>]*/?>|<base[^>]*>|<meta[^>]*http-equiv[^>]*>|<iframe[^>]*>.*?</iframe>|<object[^>]*>.*?</object>|<embed[^>]*>`)
	reOnAttr     = regexp.MustCompile(`(?i)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	reJSURL      = regexp.MustCompile(`(?i)(href|src)\s*=\s*(["']?)\s*javascript:`)
)

// CleanHTML removes what can act: scripts, frames, refreshes, event handlers.
// It is defence in depth; the reader also renders mail in a sandboxed iframe
// under a CSP that blocks scripts and remote loads.
func CleanHTML(h string) string {
	h = reRemoveTags.ReplaceAllString(h, "")
	h = reOnAttr.ReplaceAllString(h, "")
	h = reJSURL.ReplaceAllString(h, `$1=$2about:blank#`)
	return h
}

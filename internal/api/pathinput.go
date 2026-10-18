package api

import (
	"regexp"
	"strings"
	"time"
)

// Typing a saved file's path into a session (POST /v1/agents/{id}/input
// with paths): the bytes the desktop terminal writes for a dropped or
// pasted file, from ui/src/lib/xtermInput.ts (pathInput, IMAGE_SETTLE_MS).
//
// Claude Code turns an image path into `[Image #N]` only when the path
// arrives as a bracketed paste of its own; typed, it stays a path. So an
// image goes in as one paste per path when the session asked for bracketed
// paste, anything else typed, quoted and followed by a space. The browser
// writes these itself where it has a terminal and knows the mode; the chat
// has no terminal, and the daemon knows the mode (PasteMode), so it is done
// here.

// imageExt is the extensions Claude Code's image reader takes.
var imageExt = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp)$`)

// imageSettle is the pause after an image paste before the next input:
// Claude Code reads the image before it places `[Image #N]`, and text
// written straight after it landed first.
var imageSettle = 150 * time.Millisecond

// pasteModer is the optional part of AgentController that says whether a
// session's output turned bracketed paste on.
type pasteModer interface {
	PasteMode(sessionID string) bool
}

// quotePath quotes a path as the paste path does: a double quote escaped,
// a backslash (a Windows separator) left alone.
func quotePath(p string) string {
	return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
}

// pathInput is what goes into the session for one file path, and whether
// it went as an image paste.
func pathInput(p string, bracketed bool) (data string, image bool) {
	if bracketed && imageExt.MatchString(p) {
		return "\x1b[200~" + quotePath(p) + "\x1b[201~", true
	}
	return quotePath(p) + " ", false
}

// inputPaths writes each path in order, pausing after every image paste. A
// path with a control character in it is skipped: it would be a key, or end
// the paste early.
func (s *Server) inputPaths(id string, paths []string) error {
	bracketed := false
	if pm, ok := s.d.Agents.(pasteModer); ok {
		bracketed = pm.PasteMode(id)
	}
	for _, p := range paths {
		if p == "" || strings.ContainsAny(p, "\x00\r\n\x1b") {
			continue
		}
		data, image := pathInput(p, bracketed)
		if err := s.d.Agents.Input(id, []byte(data)); err != nil {
			return err
		}
		if image {
			time.Sleep(imageSettle)
		}
	}
	return nil
}

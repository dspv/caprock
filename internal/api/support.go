package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"os"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

// Report a bug (ADR-073): the user types or dictates what went wrong, may
// attach a few screenshots and an email, and presses Send. The report goes to
// Caprock support at caprock.dev, never to GitHub, because it may hold
// personal data. Like the offer survey (offer.go, ADR-062) it is sent only on
// that click, and the sheet names every field before the button.
//
// What leaves the machine is exactly the user's text, the screenshots they
// attached, the email if typed, and two fields the daemon adds and the sheet
// names: the Caprock version and the OS. Nothing else — no transcript, no
// log, no path, no identifier. The body is rebuilt here, so a field the page
// adds cannot ride along. The handler never logs the text, the email or the
// images, and there is no retry queue: a failure is shown and the form kept.

// supportURL is where a report goes. CAPROCK_SUPPORT_URL replaces it — for a
// preview stand or a test, which must never post to the real site.
const supportURL = "https://caprock.dev/api/support"

// supportClient bounds the whole request: screenshots take a moment to
// upload, but a dead site must not hold the click for long.
var supportClient = &http.Client{Timeout: 20 * time.Second}

// The report's limits (03-contracts.md § Report a bug).
const (
	supportTextMax     = 8000    // characters
	supportEmailMax    = 254     // bytes, as for the offer survey
	supportShotsMax    = 3       // screenshots
	supportShotMax     = 4 << 20 // decoded bytes, each
	supportShotsTotal  = 8 << 20 // decoded bytes, all together
	supportShotNameMax = 200     // bytes
	// supportBodyMax fits three screenshots at the total limit in base64
	// (4/3 of 8 MB) plus the text, with room for the JSON around them.
	supportBodyMax = 12 << 20
)

// supportTypes are the image types a screenshot may be, and the first bytes
// each must start with: the type is checked against the data, so a file of
// any other kind cannot be sent as a picture.
var supportTypes = map[string]func([]byte) bool{
	"image/png":  func(b []byte) bool { return bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) },
	"image/jpeg": func(b []byte) bool { return bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}) },
	"image/webp": func(b []byte) bool {
		return len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	},
}

// SupportShot is one attached screenshot. Data is base64 in JSON (standard
// encoding, as encoding/json reads and writes []byte).
type SupportShot struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data []byte `json:"data"`
}

// SupportReport is the body of POST /v1/support.
type SupportReport struct {
	Text        string        `json:"text"`
	Email       string        `json:"email,omitempty"`
	Screenshots []SupportShot `json:"screenshots,omitempty"`
}

// supportPayload is what reaches caprock.dev: the report, the version and
// the OS, nothing else.
type supportPayload struct {
	Text        string        `json:"text"`
	Email       string        `json:"email,omitempty"`
	Screenshots []SupportShot `json:"screenshots,omitempty"`
	Version     string        `json:"version"`
	OS          string        `json:"os"`
}

// validate checks the text, the email's shape and every screenshot.
func (r *SupportReport) validate() error {
	if !utf8.ValidString(r.Text) {
		return errors.New("text is not valid UTF-8")
	}
	if strings.TrimSpace(r.Text) == "" {
		return errors.New("say what happened: text is empty")
	}
	if n := utf8.RuneCountInString(r.Text); n > supportTextMax {
		return fmt.Errorf("text is at most %d characters, this is %d", supportTextMax, n)
	}
	r.Email = strings.TrimSpace(r.Email)
	if r.Email != "" {
		if len(r.Email) > supportEmailMax {
			return fmt.Errorf("email is at most %d characters", supportEmailMax)
		}
		addr, err := mail.ParseAddress(r.Email)
		at := strings.LastIndex(r.Email, "@")
		if err != nil || addr.Address != r.Email || at < 1 || !strings.Contains(r.Email[at+1:], ".") {
			return errors.New("email is not an address")
		}
	}
	if len(r.Screenshots) > supportShotsMax {
		return fmt.Errorf("at most %d screenshots", supportShotsMax)
	}
	total := 0
	for i := range r.Screenshots {
		s := &r.Screenshots[i]
		// Only the file's own name: a path the browser might send stays here.
		if j := strings.LastIndexAny(s.Name, `/\`); j >= 0 {
			s.Name = s.Name[j+1:]
		}
		if !utf8.ValidString(s.Name) || len(s.Name) > supportShotNameMax {
			return fmt.Errorf("screenshot %d: the name is at most %d bytes of text", i+1, supportShotNameMax)
		}
		magic, ok := supportTypes[s.Type]
		if !ok {
			return fmt.Errorf("screenshot %d: type is image/png, image/jpeg or image/webp", i+1)
		}
		if len(s.Data) == 0 {
			return fmt.Errorf("screenshot %d is empty", i+1)
		}
		if len(s.Data) > supportShotMax {
			return fmt.Errorf("screenshot %d is over 4 MB", i+1)
		}
		if !magic(s.Data) {
			return fmt.Errorf("screenshot %d is not a %s image", i+1, s.Type)
		}
		total += len(s.Data)
	}
	if total > supportShotsTotal {
		return errors.New("the screenshots are over 8 MB together")
	}
	return nil
}

// handleSupport is POST /v1/support: forward one bug report to caprock.dev.
// The machine and a paired phone that controls may send one (lanauth.go).
func (s *Server) handleSupport(w http.ResponseWriter, r *http.Request) {
	var rep SupportReport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, supportBodyMax)).Decode(&rep); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			s.failCode(w, http.StatusBadRequest, errors.New("the report is too large: the screenshots are at most 8 MB together"))
			return
		}
		s.failCode(w, http.StatusBadRequest, errors.New(`body is {"text", "email"?, "screenshots"?: [{"name", "type", "data"}]}`))
		return
	}
	if err := rep.validate(); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	target := supportURL
	if v := strings.TrimSpace(os.Getenv("CAPROCK_SUPPORT_URL")); v != "" {
		target = v
	}
	p := supportPayload{
		Text:        rep.Text,
		Email:       rep.Email,
		Screenshots: rep.Screenshots,
		Version:     s.d.Version,
		OS:          runtime.GOOS + "/" + runtime.GOARCH,
	}
	if err := sendSupport(r.Context(), target, p); err != nil {
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// sendSupport posts the report and says whether the site took it. The error
// never carries the text, the email or the URL: it is shown on screen.
func sendSupport(ctx context.Context, target string, p supportPayload) error {
	body, err := json.Marshal(p)
	if err != nil {
		return errors.New("could not prepare the report")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return errors.New("could not reach caprock.dev")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := supportClient.Do(req)
	if err != nil {
		return errors.New("could not reach caprock.dev")
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("caprock.dev answered %d", resp.StatusCode)
	}
	return nil
}

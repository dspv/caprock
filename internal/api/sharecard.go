package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The share card's link (ADR-086): when the user presses X, Threads or
// LinkedIn in a share sheet, the daemon uploads the exact PNG they chose to
// caprock.dev and hands back the page's address, so the post carries a link
// whose preview is that card and nothing has to be pasted. Like the survey
// (offer.go, ADR-062) and a bug report (support.go, ADR-073) it is one
// request, on that click only, and the place it happens says what it sends:
// the picture and nothing else — no text, no version, no identifier.
//
// The upload goes through the daemon rather than from the page: every call
// Caprock makes to caprock.dev is then in one place (this package), the
// desktop app's webview needs no new origin, the site needs no CORS, and the
// delete token the site answers with stays on the machine (shared_cards,
// migration 0074) — it is never in a response.

// shareBase is the site a card goes to. CAPROCK_SHARE_URL replaces it — for
// a preview stand or a test, which must never upload to the real site.
const shareBase = "https://caprock.dev"

// shareCardMax is the largest PNG the site takes (it answers 413 above it).
const shareCardMax = 2 << 20

// shareClient bounds the whole request: a dead site must not hold the click
// for long, since the sheet falls back to the clipboard when it fails.
var shareClient = &http.Client{Timeout: 15 * time.Second}

// shareIDRe is what a card id from the site may be; anything else is refused
// before it is stored or put in a path.
var shareIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// SharedCardView is a shared card as the dashboard sees it: no delete token.
type SharedCardView struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Image string `json:"image,omitempty"`
	Bytes int64  `json:"bytes"`
	At    int64  `json:"at"`
}

func sharedView(c store.SharedCard) SharedCardView {
	return SharedCardView{ID: c.ID, URL: c.URL, Image: c.Image, Bytes: c.Bytes, At: c.At}
}

func shareSite() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("CAPROCK_SHARE_URL")), "/"); v != "" {
		return v
	}
	return shareBase
}

// handleShareCard is POST /v1/share/card {png}: upload one card to the site
// and keep its delete token. Machine-only, like every route not on a paired
// device's list (lanauth.go).
func (s *Server) handleShareCard(w http.ResponseWriter, r *http.Request) {
	if s.d.Store == nil {
		s.failCode(w, http.StatusServiceUnavailable, errors.New("no database"))
		return
	}
	var body struct {
		PNG string `json:"png"`
	}
	// base64 is 4/3 of the bytes; a body past the site's limit is still read
	// far enough to say it is too big rather than malformed.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, shareCardMax/3*4+4<<10)).Decode(&body); err != nil || body.PNG == "" {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			s.failCode(w, http.StatusRequestEntityTooLarge, errors.New("the picture is over 2 MB"))
			return
		}
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"png": "<base64 PNG>"}`))
		return
	}
	png, err := base64.StdEncoding.DecodeString(body.PNG)
	if err != nil || !bytes.HasPrefix(png, pngMagic) {
		s.failCode(w, http.StatusBadRequest, errors.New("`png` must be one base64 PNG"))
		return
	}
	if len(png) > shareCardMax {
		s.failCode(w, http.StatusRequestEntityTooLarge, errors.New("the picture is over 2 MB"))
		return
	}
	site := shareSite()
	up, code, err := uploadCard(r.Context(), site, png)
	if err != nil {
		s.failCode(w, code, err)
		return
	}
	c := store.SharedCard{ID: up.ID, URL: up.URL, Image: up.Image, DeleteToken: up.DeleteToken, Bytes: int64(len(png)), At: time.Now().UnixMilli()}
	if err := store.RecordSharedCard(r.Context(), s.d.Store.DB(), c); err != nil {
		// A picture nobody can take down is not left behind: without its
		// token kept here, delete it at once and say the upload failed.
		_, _ = deleteCard(context.WithoutCancel(r.Context()), site, c.ID, c.DeleteToken)
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sharedView(c))
}

// handleSharedCards is GET /v1/share/cards: what this machine has shared.
func (s *Server) handleSharedCards(w http.ResponseWriter, r *http.Request) {
	if s.d.Store == nil {
		writeJSON(w, http.StatusOK, map[string]any{"items": []SharedCardView{}})
		return
	}
	cards, err := store.SharedCards(r.Context(), s.d.Store.DB())
	if err != nil {
		s.fail(w, err)
		return
	}
	items := make([]SharedCardView, 0, len(cards))
	for _, c := range cards {
		items = append(items, sharedView(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// handleDeleteSharedCard is DELETE /v1/share/cards/{id}: take the picture
// down on the site, then forget it here. A picture the site no longer has
// (404, 410) is forgotten too; any other answer keeps the row, so it can be
// tried again.
func (s *Server) handleDeleteSharedCard(w http.ResponseWriter, r *http.Request) {
	if s.d.Store == nil {
		s.failCode(w, http.StatusServiceUnavailable, errors.New("no database"))
		return
	}
	id := r.PathValue("id")
	c, ok, err := store.GetSharedCard(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !ok {
		s.failCode(w, http.StatusNotFound, errors.New("no shared picture has that id"))
		return
	}
	gone, err := deleteCard(r.Context(), shareSite(), c.ID, c.DeleteToken)
	if err != nil {
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	if err := store.ForgetSharedCard(r.Context(), s.d.Store.DB(), c.ID); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"removed": true, "already_gone": gone})
}

// cardUpload is the site's answer to POST /api/card.
type cardUpload struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Image       string `json:"image"`
	DeleteToken string `json:"delete_token"`
}

// uploadCard posts the PNG as the request body and checks the answer. The
// status returned is the one to give the dashboard: 413, 415 and 429 are the
// site's own, anything else that fails is 502. Errors never carry the URL.
func uploadCard(ctx context.Context, site string, png []byte) (cardUpload, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, site+"/api/card", bytes.NewReader(png))
	if err != nil {
		return cardUpload{}, http.StatusBadGateway, errors.New("could not reach caprock.dev")
	}
	req.Header.Set("Content-Type", "image/png")
	resp, err := shareClient.Do(req)
	if err != nil {
		return cardUpload{}, http.StatusBadGateway, errors.New("could not reach caprock.dev")
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK:
	case http.StatusRequestEntityTooLarge:
		return cardUpload{}, http.StatusRequestEntityTooLarge, errors.New("caprock.dev takes pictures up to 2 MB")
	case http.StatusUnsupportedMediaType:
		return cardUpload{}, http.StatusUnsupportedMediaType, errors.New("caprock.dev did not take it as a PNG")
	case http.StatusTooManyRequests:
		return cardUpload{}, http.StatusTooManyRequests, errors.New("caprock.dev asked to wait: too many pictures shared just now")
	default:
		return cardUpload{}, http.StatusBadGateway, fmt.Errorf("caprock.dev answered %d", resp.StatusCode)
	}
	var up cardUpload
	if err := json.Unmarshal(raw, &up); err != nil || !shareIDRe.MatchString(up.ID) || up.DeleteToken == "" || len(up.DeleteToken) > 512 {
		return cardUpload{}, http.StatusBadGateway, errors.New("caprock.dev answered something unexpected")
	}
	// The link the post will carry must be the site's own page.
	if !sameSite(up.URL, site) {
		return cardUpload{}, http.StatusBadGateway, errors.New("caprock.dev answered something unexpected")
	}
	if up.Image != "" && !sameSite(up.Image, site) {
		up.Image = ""
	}
	return up, 0, nil
}

// sameSite is whether link is an address on site (same scheme and host).
func sameSite(link, site string) bool {
	l, err1 := url.Parse(link)
	b, err2 := url.Parse(site)
	return err1 == nil && err2 == nil && l.Scheme == b.Scheme && l.Host == b.Host && l.Host != ""
}

// deleteCard asks the site to delete a card. gone is true when the site no
// longer had it.
func deleteCard(ctx context.Context, site, id, token string) (gone bool, err error) {
	if !shareIDRe.MatchString(id) {
		return false, errors.New("not a card id")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, site+"/api/card/"+id, nil)
	if err != nil {
		return false, errors.New("could not reach caprock.dev")
	}
	req.Header.Set("X-Delete-Token", token)
	resp, err := shareClient.Do(req)
	if err != nil {
		return false, errors.New("could not reach caprock.dev")
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	switch resp.StatusCode {
	case http.StatusNoContent, http.StatusOK:
		return false, nil
	case http.StatusNotFound, http.StatusGone:
		return true, nil
	default:
		return false, fmt.Errorf("caprock.dev answered %d", resp.StatusCode)
	}
}

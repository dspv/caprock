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
	"strings"
	"time"
)

// The offer survey (ADR-062): a one-time card asks whether a possible feature
// is worth building, and the person who answers may press Send. This is the
// only route that sends what the user chose to caprock.dev, and it sends only
// when they press the button — the dashboard never calls it on its own.
//
// What leaves the machine is exactly the fields below — which offer, its
// answers, the email if typed — and the card says so before the button is
// pressed. No identifier,
// no install id, no usage figure, no path: the body is rebuilt here from
// enums, so a field the dashboard did not mean to send cannot ride along.

// offerURL is where a submission goes. CAPROCK_OFFER_URL replaces it — for a
// preview stand or a test, which must never post to the real site.
const offerURL = "https://caprock.dev/api/offer"

// offerClient bounds the whole request. A slow site must not hold the
// person's click for longer than a moment.
var offerClient = &http.Client{Timeout: 10 * time.Second}

// offerSchemas is every survey the dashboard may ask (ui/src/lib/offer.ts;
// the Second Brain offer is a sale and sends nothing, so it has none here)
// and, per offer, each question's key and its allowed answers. A submission
// must answer every question of its offer with one of these values, and
// nothing else; anything outside is refused rather than forwarded.
var offerSchemas = func() map[string]map[string]map[string]bool {
	set := func(v ...string) map[string]bool {
		m := make(map[string]bool, len(v))
		for _, x := range v {
			m[x] = true
		}
		return m
	}
	work := map[string]map[string]bool{
		"q1": set("under-4", "4-8", "8-12", "12+"),
		"q2": set("under-30", "30-70", "over-70"),
	}
	return map[string]map[string]map[string]bool{
		"ads":     work,
		"youtube": work,
		"local-models": {
			"q1": set("coding", "chat", "search", "trying"),
			"q2": set("mac-16", "mac-24-64", "mac-96", "pc-nvidia", "other"),
		},
	}
}()

// OfferAnswer is the body of POST /v1/offer.
type OfferAnswer struct {
	Offer   string            `json:"offer"`
	Answers map[string]string `json:"answers"`
	Email   string            `json:"email,omitempty"`
}

// offerPayload is what reaches caprock.dev: the answer, nothing else.
type offerPayload struct {
	Offer   string            `json:"offer"`
	Answers map[string]string `json:"answers"`
	Email   string            `json:"email,omitempty"`
}

// validate checks the offer, every answer against its question, and the
// email's shape.
func (a *OfferAnswer) validate() error {
	a.Email = strings.TrimSpace(a.Email)
	schema, ok := offerSchemas[a.Offer]
	if !ok {
		return errors.New("offer is not one Caprock asks")
	}
	if len(a.Answers) != len(schema) {
		return fmt.Errorf("answers must answer each of the %d questions, and nothing else", len(schema))
	}
	for k, v := range a.Answers {
		allowed, ok := schema[k]
		if !ok {
			return fmt.Errorf("%q is not a question of this offer", k)
		}
		if !allowed[v] {
			return fmt.Errorf("%q is not an answer to %q", v, k)
		}
	}
	if a.Email == "" {
		return nil
	}
	if len(a.Email) > 254 {
		return errors.New("email is at most 254 characters")
	}
	addr, err := mail.ParseAddress(a.Email)
	at := strings.LastIndex(a.Email, "@")
	if err != nil || addr.Address != a.Email || at < 1 || !strings.Contains(a.Email[at+1:], ".") {
		return errors.New("email is not an address")
	}
	return nil
}

// handleOffer is POST /v1/offer: forward one survey answer to caprock.dev.
// Machine-only, like every write (lanauth.go): a paired phone gets 403.
func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	var a OfferAnswer
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&a); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`body is {"offer", "answers": {...}, "email"?}`))
		return
	}
	if err := a.validate(); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	target := offerURL
	if v := strings.TrimSpace(os.Getenv("CAPROCK_OFFER_URL")); v != "" {
		target = v
	}
	p := offerPayload(a)
	if err := sendOffer(r.Context(), target, p); err != nil {
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// sendOffer posts the payload and reports whether the site took it. The
// error never carries the email or the URL: it is shown on screen.
func sendOffer(ctx context.Context, target string, p offerPayload) error {
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return errors.New("could not reach caprock.dev")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := offerClient.Do(req)
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

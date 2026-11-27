package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/telegram"
)

// TelegramController is the bridge to the owner's own Telegram bot
// (ADR-047), as Settings drives it. Every route here is the machine's but
// /v1/telegram/hub…, which only another computer of the owner's reaches
// (computerRoutes): none is on a phone's allowlist (ADR-034).
type TelegramController interface {
	Status() telegram.Status
	Connect(ctx context.Context, token string) (telegram.User, error)
	Disconnect() error
	StartPairing() (telegram.Pairing, error)
	CancelPairing()
	SendPhoto(ctx context.Context, png []byte, caption string) error
	// SendModule sends a private module's message to the paired chat
	// (POST /v1/x/{id}/telegram) and returns its Telegram message id.
	SendModule(ctx context.Context, m telegram.ModuleMessage) (int64, error)
	// EditModule changes a message that module sent
	// (PATCH /v1/x/{id}/telegram/{message_id}).
	EditModule(ctx context.Context, e telegram.ModuleEdit) error
	// The holder's half of one bot for several computers
	// (/v1/telegram/hub…, ADR-047 amended 2026-11-27).
	telegram.Hub
}

// TelegramVia is the other half, on a computer with no bot of its own: the
// computers it reaches that hold one, sending through one, and moving that
// bot here (/v1/telegram/holders, /v1/telegram/via…). Machine-only routes:
// what this machine sends where is its owner's choice (rule 4).
type TelegramVia interface {
	TelegramHolders(ctx context.Context) []telegram.Candidate
	SetTelegramVia(ctx context.Context, id string) error
	ClearTelegramVia(ctx context.Context) error
	TakeTelegram(ctx context.Context, id string) error
}

// handleTelegramHub serves the holder's routes to another computer of the
// owner's (telegram.ServeHub): only to a computer the owner allowed here
// (ADR-067) — the gate lets nothing else reach these patterns, and this
// says so again, because the request's Sender is that computer's device
// record, its name what the chat shows. A phone never sends through, and
// the machine itself has no use for its own hub.
func (s *Server) handleTelegramHub(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	dev := deviceFrom(r)
	if dev == nil || dev.Kind != pairing.KindMachine || dev.Pending {
		s.failCode(w, http.StatusForbidden, errors.New("only another computer of yours, allowed here, sends through this computer's bot"))
		return
	}
	telegram.ServeHub(s.d.Telegram, telegram.Sender{ID: dev.ID, Name: dev.Name, Key: dev.Key}, w, r)
}

func (s *Server) requireVia(w http.ResponseWriter) bool {
	if s.d.TelegramVia == nil || !s.requireTelegram(w) {
		if s.d.TelegramVia == nil {
			s.failCode(w, http.StatusNotImplemented, errors.New("sending through another computer is unavailable"))
		}
		return false
	}
	return true
}

// handleTelegramHolders is GET /v1/telegram/holders: the computers this one
// reaches, each asked whether it holds a bot to send through.
func (s *Server) handleTelegramHolders(w http.ResponseWriter, r *http.Request) {
	if !s.requireVia(w) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"computers": s.d.TelegramVia.TelegramHolders(r.Context())})
}

// handleTelegramSetVia is PUT /v1/telegram/via {"machine": id}: send this
// machine's messages through that computer's bot. 409 when this machine has
// a bot of its own or that computer holds none; 502 when it cannot be
// reached.
func (s *Server) handleTelegramSetVia(w http.ResponseWriter, r *http.Request) {
	if !s.requireVia(w) {
		return
	}
	var body struct {
		Machine string `json:"machine"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil || body.Machine == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"machine": "<a computer's id>"}`))
		return
	}
	if err := s.d.TelegramVia.SetTelegramVia(r.Context(), body.Machine); err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramClearVia is DELETE /v1/telegram/via: stop sending through
// the other computer; what waited for it is dropped.
func (s *Server) handleTelegramClearVia(w http.ResponseWriter, r *http.Request) {
	if !s.requireVia(w) {
		return
	}
	if err := s.d.TelegramVia.ClearTelegramVia(r.Context()); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramTake is POST /v1/telegram/via/take {"machine"?: id}: the bot
// moves here from that computer (the one this machine sends through when
// omitted), with its chat and offset — no new bot, no new pairing.
func (s *Server) handleTelegramTake(w http.ResponseWriter, r *http.Request) {
	if !s.requireVia(w) {
		return
	}
	var body struct {
		Machine string `json:"machine"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body)
	if err := s.d.TelegramVia.TakeTelegram(r.Context(), body.Machine); err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

func (s *Server) requireTelegram(w http.ResponseWriter) bool {
	if s.d.Telegram == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the Telegram bridge is unavailable"))
		return false
	}
	return true
}

// handleTelegram is GET /v1/telegram: the bot, the chat, a pairing in
// progress and the last failure. The token is never in it — only a mask of
// its last four characters.
func (s *Server) handleTelegram(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramToken is PUT /v1/telegram/token {"token": "…"}: the token is
// checked with Telegram's getMe and stored only when Telegram knows it. 400
// with Telegram's reason otherwise. The answer is the status, not the token.
func (s *Server) handleTelegramToken(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil || body.Token == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"token": "<the token @BotFather gave you>"}`))
		return
	}
	if _, err := s.d.Telegram.Connect(r.Context(), body.Token); err != nil {
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramPair is POST /v1/telegram/pair: a new one-time code. The
// first private chat that sends it to the bot becomes its only chat.
func (s *Server) handleTelegramPair(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	if _, err := s.d.Telegram.StartPairing(); err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramCancelPair is DELETE /v1/telegram/pair.
func (s *Server) handleTelegramCancelPair(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	s.d.Telegram.CancelPairing()
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// handleTelegramDisconnect is DELETE /v1/telegram: the token, the chat and
// what the bridge learned about them are forgotten. The weekly report and the
// alerts share the bot, so they stop too.
func (s *Server) handleTelegramDisconnect(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	if err := s.d.Telegram.Disconnect(); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.Telegram.Status())
}

// maxPhoto is the largest card POST /v1/telegram/photo takes. Telegram's own
// limit for a photo is 10 MB; a 2x share card is well under one.
const maxPhoto = 10 << 20

// pngMagic opens every PNG file.
var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// handleTelegramPhoto is POST /v1/telegram/photo {"png": "<base64>",
// "caption": "…"}: a share card sent to the owner's own paired chat, on
// their click (the Share sheet's "Send to my Telegram"). JSON with the bytes
// in base64, not multipart, because every state-changing route must be
// application/json (csrf.go) — the same reason paste.go takes its files that way. 409 when no
// bot or chat is set up, 400 for a body that is not one PNG, 502 with
// Telegram's words when it refuses. Nothing is kept.
func (s *Server) handleTelegramPhoto(w http.ResponseWriter, r *http.Request) {
	if !s.requireTelegram(w) {
		return
	}
	var body struct {
		PNG     string `json:"png"`
		Caption string `json:"caption"`
	}
	// base64 is 4/3 of the bytes; the caption is at most a few kilobytes.
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPhoto/3*4+64<<10)).Decode(&body); err != nil || body.PNG == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"png": "<base64 PNG>", "caption": "…"}`))
		return
	}
	png, err := base64.StdEncoding.DecodeString(body.PNG)
	if err != nil || len(png) > maxPhoto || !bytes.HasPrefix(png, pngMagic) {
		s.failCode(w, http.StatusBadRequest, errors.New("`png` must be one base64 PNG of at most 10 MB"))
		return
	}
	if err := s.d.Telegram.SendPhoto(r.Context(), png, body.Caption); err != nil {
		if errors.Is(err, telegram.ErrNotPaired) {
			s.failCode(w, http.StatusConflict, err)
			return
		}
		s.failCode(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"sent": true})
}

// ErrBypassConsent is StartSession refusing a Bypass start before the
// one-time consent (ADR-041).
var ErrBypassConsent error = bypassConsentError{}

type bypassConsentError struct{}

func (bypassConsentError) Error() string { return bypassConsentMsg }

// StartSession starts a session the way POST /v1/agents does — the stated
// mode filled in, the Bypass consent checked — for a caller inside the
// daemon: a /new from the paired Telegram chat (ADR-047).
func (s *Server) StartSession(ctx context.Context, req map[string]any) (string, error) {
	if s.d.Agents == nil || !s.d.Agents.Available() {
		return "", errors.New("no coding agent Caprock can start is on this machine")
	}
	s.defaultSpawnMode(ctx, req)
	if s.needsBypassConsent(req) {
		return "", ErrBypassConsent
	}
	id, _, err := s.d.Agents.Spawn(context.WithoutCancel(ctx), req)
	if errors.Is(err, agents.ErrBypassConsent) {
		return "", ErrBypassConsent
	}
	return id, err
}

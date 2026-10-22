package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/modules"
	"github.com/dspv/caprock/internal/telegram"
)

// --- What a private module may say to the owner (ADR-076, amended 2026-10-22) ---
//
// Two ways out of a module, both to the owner alone: a message through the
// owner's own Telegram bot to the owner's own paired chat (the bridge already
// reads that bot's updates, so a module never runs a bot of its own), and a
// desktop notification from the Caprock app. Same callers as the module's
// store: this machine, or a paired controller (moduleCaller), for a module
// the stored admin key names.

// moduleNotifyTitleMax and moduleNotifyBodyMax bound a module notification;
// the app clips again to what a lock screen shows.
const (
	moduleNotifyTitleMax = 120
	moduleNotifyBodyMax  = 400
)

// ModuleNotifier shows a module's desktop notification: a notify frame the
// desktop app turns into an OS notification, when the owner's desktop
// notifications are on. It reports whether it published one.
type ModuleNotifier interface {
	NotifyModule(id, name, title, body string) bool
}

func (s *Server) routeModuleOut(m *http.ServeMux) {
	m.HandleFunc("POST /v1/x/{id}/telegram", s.handleModuleTelegram)
	m.HandleFunc("PATCH /v1/x/{id}/telegram/{message_id}", s.handleModuleTelegramEdit)
	m.HandleFunc("POST /v1/x/{id}/notify", s.handleModuleNotify)
}

// moduleOutKey checks that the stored key names the module and returns the
// name its messages carry: the installed manifest's, else the id.
func (s *Server) moduleOutKey(w http.ResponseWriter, r *http.Request) (id, name string, ok bool) {
	id = r.PathValue("id")
	g, granted := s.adminGrant(r)
	if !granted || !g.Allows(id) {
		s.failCode(w, http.StatusForbidden, errors.New("refused: no admin key names this module"))
		return "", "", false
	}
	name = id
	if s.d.DataDir != "" {
		if man, _, found := modules.Find(modules.Root(s.d.DataDir), id); found && strings.TrimSpace(man.Name) != "" {
			name = strings.TrimSpace(man.Name)
		}
	}
	return id, name, true
}

// handleModuleTelegram is POST /v1/x/{id}/telegram {text, buttons?, reply?,
// reply_to_message_id?}: one message to the owner's paired chat, its first
// line naming the module, threaded under one of the module's own when
// reply_to_message_id names it. {message_id}; 409 with no paired chat or
// under /mute all; 400 for a bad message; 404 when reply_to_message_id is not
// a message this module sent; 502 with Telegram's words.
func (s *Server) handleModuleTelegram(w http.ResponseWriter, r *http.Request) {
	id, name, ok := s.moduleOutKey(w, r)
	if !ok {
		return
	}
	if s.d.Telegram == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the Telegram bridge is unavailable"))
		return
	}
	var body struct {
		Text    string                  `json:"text"`
		Buttons []telegram.ModuleButton `json:"buttons"`
		Reply   bool                    `json:"reply"`
		ReplyTo int64                   `json:"reply_to_message_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"text": "…", "buttons": [{"id": "…", "label": "…"}], "reply": false, "reply_to_message_id": 0}`))
		return
	}
	msgID, err := s.d.Telegram.SendModule(r.Context(), telegram.ModuleMessage{Module: id, Name: name, Text: body.Text, Buttons: body.Buttons, Reply: body.Reply, ReplyTo: body.ReplyTo})
	switch {
	case errors.Is(err, telegram.ErrModuleMessage):
		s.failCode(w, http.StatusBadRequest, err)
	case errors.Is(err, telegram.ErrNotModuleMessage):
		s.failCode(w, http.StatusNotFound, err)
	case errors.Is(err, telegram.ErrNotPaired), errors.Is(err, telegram.ErrMuted):
		s.failCode(w, http.StatusConflict, err)
	case err != nil:
		s.failCode(w, http.StatusBadGateway, err)
	default:
		writeJSON(w, http.StatusOK, map[string]int64{"message_id": msgID})
	}
}

// handleModuleTelegramEdit is PATCH /v1/x/{id}/telegram/{message_id}
// {text?, buttons?}: a change to a message this module sent. An omitted (or
// null) part is left as it is; `buttons: []` removes the buttons; at least
// one part is required. {message_id}; 400 for a bad edit; 404 for any
// message this module did not send (another module's, the bridge's own, an
// unknown or forgotten one); 409 with no paired chat; 502 with Telegram's
// words. Telegram's "message is not modified" is a 200.
func (s *Server) handleModuleTelegramEdit(w http.ResponseWriter, r *http.Request) {
	id, name, ok := s.moduleOutKey(w, r)
	if !ok {
		return
	}
	if s.d.Telegram == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("the Telegram bridge is unavailable"))
		return
	}
	msgID, err := strconv.ParseInt(r.PathValue("message_id"), 10, 64)
	if err != nil || msgID <= 0 {
		s.failCode(w, http.StatusNotFound, telegram.ErrNotModuleMessage)
		return
	}
	var body struct {
		Text    *string                  `json:"text"`
		Buttons *[]telegram.ModuleButton `json:"buttons"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"text": "…", "buttons": [{"id": "…", "label": "…"}]}, either or both`))
		return
	}
	err = s.d.Telegram.EditModule(r.Context(), telegram.ModuleEdit{Module: id, Name: name, MessageID: msgID, Text: body.Text, Buttons: body.Buttons})
	switch {
	case errors.Is(err, telegram.ErrModuleMessage):
		s.failCode(w, http.StatusBadRequest, err)
	case errors.Is(err, telegram.ErrNotModuleMessage):
		s.failCode(w, http.StatusNotFound, err)
	case errors.Is(err, telegram.ErrNotPaired):
		s.failCode(w, http.StatusConflict, err)
	case err != nil:
		s.failCode(w, http.StatusBadGateway, err)
	default:
		writeJSON(w, http.StatusOK, map[string]int64{"message_id": msgID})
	}
}

// handleModuleNotify is POST /v1/x/{id}/notify {title, body?}: a desktop
// notification from the Caprock app, titled with the module's name, whose
// click opens the module. 204 whether or not one is shown — desktop
// notifications off, or no app open, is not the module's error.
func (s *Server) handleModuleNotify(w http.ResponseWriter, r *http.Request) {
	id, name, ok := s.moduleOutKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`body must be {"title": "…", "body": "…"}`))
		return
	}
	title, text := strings.TrimSpace(body.Title), strings.TrimSpace(body.Body)
	if title == "" || utf8.RuneCountInString(title) > moduleNotifyTitleMax || utf8.RuneCountInString(text) > moduleNotifyBodyMax {
		s.failCode(w, http.StatusBadRequest, errors.New("title is 1 to 120 characters and body at most 400"))
		return
	}
	if s.d.ModuleNotify != nil {
		s.d.ModuleNotify.NotifyModule(id, name, title, text)
	}
	w.WriteHeader(http.StatusNoContent)
}

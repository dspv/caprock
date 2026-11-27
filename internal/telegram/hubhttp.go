package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// The hub's wire: the holder's routes as another computer calls them over
// their link (ADR-067), served by ServeHub and called by HubClient. The
// routes are registered by the API, which decides who may call them (a
// computer the owner allowed, never a phone) and names the Sender from its
// own device record.
const (
	HubPath         = "/v1/telegram/hub"
	HubMessagesPath = "/v1/telegram/hub/messages"
	HubPressesPath  = "/v1/telegram/hub/presses"
	HubResultsPath  = "/v1/telegram/hub/results"
	HubHandoverPath = "/v1/telegram/hub/handover"
)

// HubPressWait is the longest a presses request is held open.
const HubPressWait = 25 * time.Second

// Hub is the holder's half as the routes need it; *Bridge is one.
type Hub interface {
	HubInfo() HubInfo
	HubPost(ctx context.Context, s Sender, m HubMessage) (int64, error)
	HubPresses(ctx context.Context, s Sender, wait time.Duration) []HubPress
	HubResult(ctx context.Context, s Sender, r HubResult) error
	Handover(ctx context.Context, s Sender) (Handover, error)
}

// maxHubBody bounds a message or a result: Telegram's own limit is 4096
// characters, a few of them four bytes, plus the buttons.
const maxHubBody = 64 << 10

// ServeHub answers one hub request from computer s:
//
//	GET  /v1/telegram/hub           → HubInfo
//	POST /v1/telegram/hub/messages  HubMessage → {message_id}; 409 not a holder, 400 a message it will not post, 502 Telegram's words
//	GET  /v1/telegram/hub/presses?wait=<s> → {presses: [HubPress]} (held up to 25 s while none waits)
//	POST /v1/telegram/hub/results   HubResult → {ok}; 404 for a message it never posted
//	POST /v1/telegram/hub/handover  → Handover; 409 not a holder
func ServeHub(h Hub, s Sender, w http.ResponseWriter, r *http.Request) {
	switch r.Method + " " + r.URL.Path {
	case "GET " + HubPath:
		hubJSON(w, http.StatusOK, h.HubInfo())
	case "POST " + HubMessagesPath:
		var m HubMessage
		if err := json.NewDecoder(io.LimitReader(r.Body, maxHubBody)).Decode(&m); err != nil {
			hubJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be a message: {id, text, parse_mode?, buttons?, reply?, late_s?}"})
			return
		}
		id, err := h.HubPost(r.Context(), s, m)
		if err != nil {
			hubFail(w, err)
			return
		}
		hubJSON(w, http.StatusOK, map[string]int64{"message_id": id})
	case "GET " + HubPressesPath:
		wait := HubPressWait
		if v, err := strconv.Atoi(r.URL.Query().Get("wait")); err == nil && v >= 0 && time.Duration(v)*time.Second < wait {
			wait = time.Duration(v) * time.Second
		}
		ps := h.HubPresses(r.Context(), s, wait)
		if ps == nil {
			ps = []HubPress{}
		}
		hubJSON(w, http.StatusOK, map[string]any{"presses": ps})
	case "POST " + HubResultsPath:
		var res HubResult
		if err := json.NewDecoder(io.LimitReader(r.Body, maxHubBody)).Decode(&res); err != nil || res.ID == "" {
			hubJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be a result: {id, label?, say?, react?, reply?}"})
			return
		}
		if err := h.HubResult(r.Context(), s, res); err != nil {
			hubFail(w, err)
			return
		}
		hubJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "POST " + HubHandoverPath:
		ho, err := h.Handover(r.Context(), s)
		if err != nil {
			hubFail(w, err)
			return
		}
		hubJSON(w, http.StatusOK, ho)
	default:
		hubJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func hubFail(w http.ResponseWriter, err error) {
	var bad errHubBad
	switch {
	case errors.Is(err, ErrNotHolder):
		hubJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "reason": "not_holder"})
	case errors.Is(err, errHubUnknown):
		hubJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.As(err, &bad):
		hubJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		hubJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
	}
}

func hubJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// HubError is the holder refusing a request, in its words.
type HubError struct {
	Status int
	Msg    string
	Reason string
}

func (e *HubError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return fmt.Sprintf("the other computer answered %d", e.Status)
}

// NotHolder reports the holder saying it has no bot any more.
func NotHolder(err error) bool {
	var he *HubError
	return errors.As(err, &he) && he.Status == http.StatusConflict
}

// Refused reports an answer that will not change on a retry: the message
// itself was refused (400), or the route is not there (404, 403 — an older
// Caprock, or a computer not allowed to). A 502 (Telegram's) or a transport
// error is worth trying again.
func Refused(err error) bool {
	var he *HubError
	return errors.As(err, &he) && (he.Status == http.StatusBadRequest || he.Status == http.StatusNotFound || he.Status == http.StatusForbidden)
}

// HubClient calls a holder's hub routes; Do carries one request to it
// (peers.Manager.Do with the holder's id, in the daemon).
type HubClient struct {
	Do func(*http.Request) (*http.Response, error)
}

func (c HubClient) call(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://caprock"+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Error  string `json:"error"`
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(raw, &e)
		return &HubError{Status: res.StatusCode, Msg: e.Error, Reason: e.Reason}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// Info asks whether the holder has a bot to send through.
func (c HubClient) Info(ctx context.Context) (HubInfo, error) {
	var h HubInfo
	err := c.call(ctx, http.MethodGet, HubPath, nil, &h)
	return h, err
}

// Post hands the holder one message.
func (c HubClient) Post(ctx context.Context, m HubMessage) (int64, error) {
	var out struct {
		MessageID int64 `json:"message_id"`
	}
	err := c.call(ctx, http.MethodPost, HubMessagesPath, m, &out)
	return out.MessageID, err
}

// Presses waits up to wait for presses and replies under this machine's
// messages.
func (c HubClient) Presses(ctx context.Context, wait time.Duration) ([]HubPress, error) {
	var out struct {
		Presses []HubPress `json:"presses"`
	}
	err := c.call(ctx, http.MethodGet, HubPressesPath+"?wait="+strconv.Itoa(int(wait/time.Second)), nil, &out)
	return out.Presses, err
}

// Result tells the holder what this machine did with a press.
func (c HubClient) Result(ctx context.Context, r HubResult) error {
	return c.call(ctx, http.MethodPost, HubResultsPath, r, nil)
}

// Handover asks the holder for its bot.
func (c HubClient) Handover(ctx context.Context) (Handover, error) {
	var h Handover
	err := c.call(ctx, http.MethodPost, HubHandoverPath, map[string]any{}, &h)
	return h, err
}

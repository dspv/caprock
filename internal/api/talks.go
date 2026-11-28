package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/talks"
)

// Talks (ADR-110, contract in 03-contracts.md § Talks): agents speak for
// two people. Two kinds of route:
//
//   - The owner's, loopback only (and on no device's allowlist): invite a
//     person, accept an invitation, list and remove the people linked,
//     Settings → Talks, start a Talk and answer what it holds.
//   - The person's, personRoutes in lanauth.go and nothing else: deliver an
//     envelope (POST /v1/talks/inbox) and read what this side holds of a
//     Talk with them (GET /v1/talks/inbox/{talk}). The sender is the relay
//     key the person's token is bound to, never a field of the body.

// TalkLinkBase is where an invitation link points: a page of caprock.dev
// that opens Caprock with the key in the fragment, which a browser never
// sends to the server.
const TalkLinkBase = "https://caprock.dev/talk#"

// TalksControl is the daemon's side of Talks.
type TalksControl interface {
	Engine() *talks.Engine
	// Invite makes the invitation key (24 hours, one open at a time),
	// turning access from anywhere on here when it is off; name, when set,
	// is what this side is called to the person.
	Invite(ctx context.Context, name string) (TalkInvite, error)
	InviteState() peers.JoinState
	WithdrawInvite()
	// Accept uses an invitation: both sides are linked, each with a token
	// for a person on the other.
	Accept(ctx context.Context, key, name string) (TalkPerson, error)
	People() []TalkPerson
	SetPerson(id string, name *string, letStart *bool) error
	// RemovePerson ends the link from this side: the other side is asked to
	// drop this one, this side forgets them and ends their Talks. The
	// caller revokes their token here.
	RemovePerson(ctx context.Context, id string) error
	// PersonLeft is the other side's Remove arriving (DELETE /v1/pair/me by
	// a person): key is their relay key.
	PersonLeft(ctx context.Context, key string)
	Settings() talks.Settings
	SetSettings(talks.Settings) error
}

// TalkInvite is POST /v1/talks/invite's answer: the key, once, and the link
// that carries it.
type TalkInvite struct {
	peers.JoinState
	Key  string `json:"key"`
	Link string `json:"link"`
	// TurnedOnRemote says inviting switched access from anywhere on here.
	TurnedOnRemote bool `json:"turned_on_remote,omitempty"`
}

// TalkPerson is one person linked for Talks.
type TalkPerson struct {
	peers.Status
	// SafetyCode is twelve digits from both relay keys, the same on both
	// sides, to compare if either wants to; never a step.
	SafetyCode string `json:"safety_code"`
	// TurnedOnRemote, on Accept's answer, says accepting switched access
	// from anywhere on here.
	TurnedOnRemote bool `json:"turned_on_remote,omitempty"`
}

// talksLocal refuses anything but this machine's own clients, and a daemon
// without Talks.
func (s *Server) talksLocal(w http.ResponseWriter, r *http.Request) bool {
	if !isLocal(r) {
		s.failCode(w, http.StatusForbidden, errors.New("talks are run from the machine Caprock runs on"))
		return false
	}
	if s.d.Talks == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build has no Talks"))
		return false
	}
	return true
}

func readBody(w http.ResponseWriter, r *http.Request, max int64, v any) error {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil
	}
	return json.Unmarshal(b, v)
}

func (s *Server) handleTalkInvite(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := readBody(w, r, 4<<10, &req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {} or {"name": "what the person sees you as"}`))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), joinWait)
	defer cancel()
	inv, err := s.d.Talks.Invite(ctx, req.Name)
	if err != nil {
		s.failCode(w, http.StatusConflict, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, inv)
}

func (s *Server) handleTalkInviteState(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, s.d.Talks.InviteState())
}

func (s *Server) handleTalkInviteWithdraw(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	s.d.Talks.WithdrawInvite()
	writeJSON(w, http.StatusOK, map[string]bool{"withdrawn": true})
}

// talkKeyOf reads an invitation as pasted: the key, or the whole link.
func talkKeyOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '#'); i >= 0 {
		s = s[i+1:]
	}
	return s
}

func (s *Server) handleTalkAccept(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	var req struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	if err := readBody(w, r, 4<<10, &req); err != nil || strings.TrimSpace(req.Key) == "" {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"key": "<the invitation key or link>"}`))
		return
	}
	key := talkKeyOf(req.Key)
	if _, err := remote.ParseJoinKey(key); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("that is not a Talks invitation: paste the link or key the person sent"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), joinWait)
	defer cancel()
	p, err := s.d.Talks.Accept(ctx, key, req.Name)
	if err != nil {
		code := http.StatusBadGateway
		switch {
		case errors.Is(err, peers.ErrJoinGone):
			code = http.StatusNotFound
			err = errors.New("that invitation's Caprock is not waiting for it: it expired (24 hours), was used or withdrawn, or that Caprock is off. Ask for a new one")
		case errors.Is(err, peers.ErrJoinRefused):
			code = http.StatusForbidden
		case errors.Is(err, context.DeadlineExceeded):
			code = http.StatusGatewayTimeout
		}
		s.failCode(w, code, err)
		return
	}
	s.devicesChanged()
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleTalkPeople(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": s.d.Talks.People()})
}

func (s *Server) handleTalkPersonPatch(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	var req struct {
		Name     *string `json:"name"`
		LetStart *bool   `json:"let_start"`
	}
	if err := readBody(w, r, 4<<10, &req); err != nil || (req.Name == nil && req.LetStart == nil) {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"name": "…"} or {"let_start": true|false}`))
		return
	}
	if err := s.d.Talks.SetPerson(r.PathValue("id"), req.Name, req.LetStart); err != nil {
		if errors.Is(err, peers.ErrUnknown) {
			s.failCode(w, http.StatusNotFound, talks.ErrNoPerson)
			return
		}
		s.failCode(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": s.d.Talks.People()})
}

// handleTalkPersonRemove is Remove: the link ends in both directions — the
// other side is asked to drop this one, their token here stops working at
// once, their Talks end as *ended by you*. Each side keeps its transcripts.
func (s *Server) handleTalkPersonRemove(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	err := s.d.Talks.RemovePerson(ctx, id)
	n := s.revokePersonDevices(id)
	if err != nil && n == 0 {
		if errors.Is(err, peers.ErrUnknown) {
			s.failCode(w, http.StatusNotFound, talks.ErrNoPerson)
			return
		}
		s.fail(w, err)
		return
	}
	s.devicesChanged()
	writeJSON(w, http.StatusOK, map[string]any{"removed": true, "revoked": n})
}

// revokePersonDevices revokes here every person token bound to key, in
// memory or on disk; it returns how many.
func (s *Server) revokePersonDevices(key string) int {
	if key == "" {
		return 0
	}
	ps, _ := s.lanState()
	if ps != nil {
		n := 0
		for _, d := range ps.Snapshot() {
			if d.Kind == pairing.KindPerson && d.Key == key && ps.Revoke(d.ID) {
				s.closeDeviceSockets(d.ID)
				n++
			}
		}
		if n > 0 {
			s.saveDevices()
		}
		return n
	}
	if s.d.DataDir == "" {
		return 0
	}
	saved, err := config.ReadDevices(s.d.DataDir)
	if err != nil {
		return 0
	}
	tmp := pairing.New()
	tmp.Load(saved)
	n := 0
	for _, d := range saved {
		if d.Kind == pairing.KindPerson && d.Key == key && tmp.Revoke(d.ID) {
			n++
		}
	}
	if n > 0 {
		if err := config.WriteDevices(s.d.DataDir, tmp.Snapshot()); err != nil {
			s.d.Log.Warn("could not save the paired devices", "component", "api", "err", err)
		}
	}
	return n
}

func (s *Server) handleTalkSettings(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, talkSettingsView(s.d.Talks.Settings()))
}

// talkSettingsView is Settings → Talks with the defaults it falls back on.
func talkSettingsView(set talks.Settings) map[string]any {
	n, usd := set.Caps()
	return map[string]any{
		"settings": set,
		"effective": map[string]any{
			"brief": set.BriefOrDefault(), "max_messages": n, "max_usd": usd, "share_cost": set.SharesCost(),
		},
		"defaults": map[string]any{
			"brief": talks.DefaultBrief, "max_messages": talks.DefaultMaxMessages, "max_usd": talks.DefaultMaxUSD, "share_cost": true,
		},
	}
}

func (s *Server) handleTalkSettingsPut(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	var set talks.Settings
	if err := readBody(w, r, 64<<10, &set); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("send Settings → Talks as JSON"))
		return
	}
	if err := s.d.Talks.SetSettings(set.Clean()); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, talkSettingsView(s.d.Talks.Settings()))
}

func (s *Server) handleTalks(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	list, err := s.d.Talks.Engine().List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"talks": list})
}

func (s *Server) handleTalkStart(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	var req struct {
		Person string `json:"person"`
		Goal   string `json:"goal"`
	}
	if err := readBody(w, r, 8<<10, &req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New(`send {"person": "<id>", "goal": "one line"}`))
		return
	}
	t, err := s.d.Talks.Engine().StartTalk(r.Context(), req.Person, req.Goal)
	if err != nil {
		s.talkFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// talkFail answers an engine error.
func (s *Server) talkFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNoTalk), errors.Is(err, talks.ErrNoPerson):
		s.failCode(w, http.StatusNotFound, err)
	case errors.Is(err, talks.ErrGoal):
		s.failCode(w, http.StatusBadRequest, err)
	case errors.Is(err, talks.ErrCaught):
		s.failCode(w, http.StatusUnprocessableEntity, err)
	case errors.Is(err, talks.ErrNotHeld), errors.Is(err, talks.ErrState), errors.Is(err, talks.ErrEnded), errors.Is(err, talks.ErrTooMany):
		s.failCode(w, http.StatusConflict, err)
	default:
		s.fail(w, err)
	}
}

func (s *Server) handleTalk(w http.ResponseWriter, r *http.Request) {
	if !s.talksLocal(w, r) {
		return
	}
	v, err := s.d.Talks.Engine().Get(r.Context(), r.PathValue("id"))
	if err != nil {
		s.talkFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleTalkAction is the buttons of a Talk: held/send, held/edit,
// held/drop, continue, accept, end.
func (s *Server) handleTalkAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.talksLocal(w, r) {
			return
		}
		e, id, ctx := s.d.Talks.Engine(), r.PathValue("id"), r.Context()
		var t store.Talk
		var err error
		switch action {
		case "send":
			t, err = e.SendHeld(ctx, id)
		case "edit":
			var req struct {
				Text string `json:"text"`
			}
			if rerr := readBody(w, r, talks.MaxBody+4<<10, &req); rerr != nil {
				s.failCode(w, http.StatusBadRequest, errors.New(`send {"text": "…"}`))
				return
			}
			t, err = e.EditHeld(ctx, id, req.Text)
		case "drop":
			t, err = e.DropHeld(ctx, id)
		case "continue":
			t, err = e.Continue(ctx, id)
		case "accept":
			t, err = e.Accept(ctx, id)
		case "end":
			t, err = e.End(ctx, id)
		}
		if err != nil {
			s.talkFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	}
}

// personFrom is the relay key of the person a request came from, or "".
func personFrom(r *http.Request) string {
	d := deviceFrom(r)
	if d == nil || d.Kind != pairing.KindPerson {
		return ""
	}
	return d.Key
}

// handleTalkInbox is a person delivering one envelope (personRoutes).
func (s *Server) handleTalkInbox(w http.ResponseWriter, r *http.Request) {
	from := personFrom(r)
	if from == "" {
		s.failCode(w, http.StatusForbidden, errors.New("only a person linked for Talks delivers here"))
		return
	}
	if s.d.Talks == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build has no Talks"))
		return
	}
	var req struct {
		Envelope json.RawMessage `json:"envelope"`
	}
	if err := readBody(w, r, talks.MaxBody+16<<10, &req); err != nil || len(req.Envelope) == 0 {
		s.failCode(w, http.StatusBadRequest, talks.ErrBadEnvelope)
		return
	}
	got, err := s.d.Talks.Engine().Receive(r.Context(), from, req.Envelope)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, got)
	case errors.Is(err, talks.ErrOutOfOrder):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "have": got.Have, "state": got.State})
	case errors.Is(err, talks.ErrBadEnvelope):
		s.failCode(w, http.StatusBadRequest, err)
	case errors.Is(err, talks.ErrNotYours), errors.Is(err, talks.ErrNoPerson):
		s.failCode(w, http.StatusForbidden, err)
	case errors.Is(err, talks.ErrTooMany):
		s.failCode(w, http.StatusTooManyRequests, err)
	default:
		s.fail(w, err)
	}
}

// handleTalkDelivery is a person reading what this side holds of a Talk
// with them (personRoutes).
func (s *Server) handleTalkDelivery(w http.ResponseWriter, r *http.Request) {
	from := personFrom(r)
	if from == "" {
		s.failCode(w, http.StatusForbidden, errors.New("only a person linked for Talks reads this"))
		return
	}
	if s.d.Talks == nil {
		s.failCode(w, http.StatusNotImplemented, errors.New("this build has no Talks"))
		return
	}
	got, err := s.d.Talks.Engine().Delivery(r.Context(), from, r.PathValue("talk"))
	if err != nil {
		s.failCode(w, http.StatusForbidden, err)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

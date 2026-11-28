package daemon

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/brain"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/talks"
	"github.com/dspv/caprock/internal/telegram"
	"github.com/dspv/caprock/internal/userenv"
)

// Talks (ADR-110): api.TalksControl over the people linked (a peers.Manager
// on people.json), the invitation desk (a peers.JoinDesk whose keys live a
// day and pair both ways) and the engine.
//
// The outbound path is the user's own doing: inviting a person or accepting
// their invitation switches access from anywhere on (ADR-058) and links the
// two Caprocks through the relay; from then the envelopes a Talk lists as
// sent travel to that person's Caprock as Noise ciphertext, and nothing
// else does (rule 4). Remove ends it from either side.

// TalkInviteTTL is how long an invitation key works: the partner may need
// to install Caprock first (ADR-110).
const TalkInviteTTL = 24 * time.Hour

// talksAdapter is the daemon's Talks.
type talksAdapter struct {
	d *Daemon

	once   sync.Once
	people *peers.Manager
	eng    *talks.Engine

	stop context.CancelFunc

	mu   sync.Mutex
	desk *peers.JoinDesk
	set  *talks.Settings
}

func newTalksAdapter(d *Daemon) *talksAdapter { return &talksAdapter{d: d} }

func (a *talksAdapter) peopleMgr() *peers.Manager {
	a.once.Do(a.open)
	return a.people
}

// Engine is the engine, started on first use with the daemon's context.
func (a *talksAdapter) Engine() *talks.Engine {
	a.once.Do(a.open)
	return a.eng
}

func (a *talksAdapter) open() {
	d := a.d
	self := d.RemoteState("").HostID
	m, err := peers.Open(peers.Options{Dir: d.opt.DataDir, File: peers.PeopleFile, Self: self, Name: a.name(), Log: d.log, Identity: d.remoteIdentity()})
	if err != nil {
		d.log.Warn("could not read the people linked for Talks; listing none", "component", "talks", "err", err)
	}
	a.people = m
	a.eng = talks.New(talks.Options{
		DB:       d.store.DB(),
		Agent:    a.agent(),
		Ground:   talkGround{d: d},
		Deliver:  a.deliver,
		People:   a.person,
		Settings: a.Settings,
		Notify:   a.notify,
		Changed: func(id, why string) {
			d.bus.Publish(bus.Frame{Type: bus.FrameTalks, Data: map[string]string{"id": id, "why": why}})
		},
		Log: d.log,
	})
	base := d.baseCtx
	if base == nil {
		base = context.Background()
	}
	ctx, stop := context.WithCancel(base)
	a.stop = stop
	a.eng.Start(ctx)
}

// start opens the engine at daemon start when anyone is linked, so Talks
// whose turn it is resume and the outbox drains; a daemon nobody linked
// reads nothing.
func (a *talksAdapter) start() {
	if ms, _ := peers.ReadFile(a.d.opt.DataDir, peers.PeopleFile); len(ms) > 0 {
		a.once.Do(a.open)
	}
}

// close hangs up and waits for turns in flight.
func (a *talksAdapter) close() {
	a.once.Do(func() {})
	a.mu.Lock()
	if a.desk != nil {
		a.desk.Close()
	}
	a.mu.Unlock()
	if a.people != nil {
		a.people.Close()
	}
	if a.eng != nil {
		a.stop()
		a.eng.Wait()
	}
}

// name is what this side is called to the people it talks with.
func (a *talksAdapter) name() string {
	if n := a.Settings().Name; n != "" {
		return n
	}
	return machineName()
}

func (a *talksAdapter) Settings() talks.Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.set == nil {
		s, err := talks.ReadSettings(a.d.opt.DataDir)
		if err != nil {
			a.d.log.Warn("could not read Settings → Talks; using the defaults", "component", "talks", "err", err)
		}
		a.set = &s
	}
	return *a.set
}

func (a *talksAdapter) SetSettings(s talks.Settings) error {
	s = s.Clean()
	if err := talks.WriteSettings(a.d.opt.DataDir, s); err != nil {
		return err
	}
	a.mu.Lock()
	a.set = &s
	a.mu.Unlock()
	return nil
}

func (a *talksAdapter) setName(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	s := a.Settings()
	if s.Name == name {
		return
	}
	s.Name = name
	if err := a.SetSettings(s); err != nil {
		a.d.log.Warn("could not save the Talks name", "component", "talks", "err", err)
	}
}

func (a *talksAdapter) person(id string) (talks.Person, bool) {
	st, err := a.peopleMgr().Get(id)
	if err != nil {
		return talks.Person{}, false
	}
	return talks.Person{Name: st.Name, LetStart: st.LetStart}, true
}

func (a *talksAdapter) deliver(ctx context.Context, person string, body []byte) (int, []byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://person/v1/talks/inbox", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := a.peopleMgr().Do(person, req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	return res.StatusCode, b, nil
}

// notify is a hold's notification: on the app and the phone, as every
// notify frame is, and in the owner's Telegram chat when a bot is set up
// and not muted (ADR-047: the destination the owner already chose). Its text
// names the person and why, never the message.
func (a *talksAdapter) notify(n talks.Notice) {
	d := a.d
	d.bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: alerts.Notification{
		ID:    fmt.Sprintf("talk-%s-%d", n.Talk, time.Now().UnixNano()),
		Kind:  "talk_hold",
		Title: n.Title,
		Body:  n.Body,
		Route: "#/talks/" + n.Talk,
	}})
	if !d.botConfigured() || (d.tg != nil && d.tg.Store.Get().MuteAll) {
		return
	}
	text := talkHoldMessage(n, d.morningBase())
	d.goBg(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var err error
		if d.tg != nil {
			err = d.tg.SendNow(ctx, telegram.Out{Text: text})
		} else {
			cfg := d.config()
			err = d.sender().SendFormatted(ctx, cfg.ReportBotToken, cfg.ReportChatID, text, "")
		}
		if err != nil {
			d.log.Info("a Talk's hold did not reach Telegram", "component", "talks", "talk", n.Talk, "err", err)
		}
	})
}

// talkHoldMessage is a hold as Telegram says it: plain text, the person and
// why, and where to answer it — never the held message itself.
func talkHoldMessage(n talks.Notice, base string) string {
	text := n.Title + "\n" + n.Body
	if base = strings.TrimRight(base, "/"); base != "" {
		text += "\n\nAnswer it in Caprock: " + base + "/#/talks/" + n.Talk
	}
	return text
}

// agent runs each turn with the owner's own agent CLI, headless and with no
// tools (talks.RunnerAgent over Second Brain's runners, ADR-103), from a
// folder of its own; the agent is the one chosen in Settings → Talks, else
// the one 2nd Brain reads with, else Claude Code; the model its strongest.
func (a *talksAdapter) agent() talks.Agent {
	d := a.d
	env := func() []string { return userenv.Environ(d.log) }
	bin := func(agent string) func() string { return func() string { return d.mgr.AgentBinary(agent) } }
	run := filepath.Join(d.opt.DataDir, "talks", "run")
	const turnTimeout = 5 * time.Minute
	return talks.RunnerAgent{
		Runners: map[string]brain.Runner{
			brain.ReaderClaude: brain.ClaudeRunner{Binary: d.mgr.ClaudeBinary, Env: env, Dir: run, Timeout: turnTimeout},
			brain.ReaderCodex:  brain.CodexRunner{Binary: bin(agents.AgentCodex), Env: env, Dir: filepath.Join(run, "codex")},
			brain.ReaderCursor: &brain.CursorRunner{Binary: bin(agents.AgentCursor), Env: env, Dir: filepath.Join(run, "cursor")},
			brain.ReaderGemini: brain.GeminiRunner{Binary: bin(agents.AgentGemini), Env: env, Dir: filepath.Join(run, "gemini")},
		},
		Pick: func(context.Context) (string, string) {
			pick := strings.TrimSpace(d.config().Brain.Reader)
			if !brain.IsReader(pick) || d.mgr.AgentBinary(pick) == "" {
				pick = ""
				for _, id := range brain.ReaderOrder {
					if d.mgr.AgentBinary(id) != "" {
						pick = id
						break
					}
				}
			}
			if pick == brain.ReaderClaude {
				// Quality first (ADR-110): Claude Code's strongest model.
				return pick, "opus"
			}
			return pick, ""
		},
	}
}

// talkGround is what a turn may read of this side's 2nd Brain about the
// goal (ADR-110's default scope): memories agents may read, the folders
// excluded from Second Brain and those labelled Personal left out.
type talkGround struct{ d *Daemon }

// talkGroundMax is how many memories a turn is given at most.
const talkGroundMax = 12

func (g talkGround) Ground(ctx context.Context, goal string) (string, []string) {
	db := g.d.store.DB()
	f := store.BrainFilter{Agents: true, Query: goal, Limit: talkGroundMax * 2, Summaries: true,
		ExcludeProjects: brain.ExcludedProjects(g.d.config().Brain.Exclude)}
	graph, err := store.ReadBrainGraph(ctx, db, f)
	if err == nil && graph.Total == 0 {
		f.Query = ""
		graph, err = store.ReadBrainGraph(ctx, db, f)
	}
	if err != nil {
		return "", nil
	}
	var personal []string
	if labels, err := store.ListFolderLabels(ctx, db); err == nil {
		for _, l := range labels {
			if l.Label == store.FolderLabelPersonal {
				personal = append(personal, filepath.Clean(l.Dir))
			}
		}
	}
	var b strings.Builder
	var sources []string
	for _, n := range graph.Nodes {
		if len(sources) == talkGroundMax {
			break
		}
		if !store.IsBrainKind(n.Kind) || n.SupersededBy != 0 {
			continue
		}
		if n.Source.SessionID != "" && len(personal) > 0 {
			if s, err := store.GetSession(ctx, db, n.Source.SessionID); err == nil && underAny(s.Cwd, personal) {
				continue
			}
		}
		src := fmt.Sprintf("memory %d", n.ID)
		fmt.Fprintf(&b, "[%s] %s: %s — %s\n", src, n.Kind, n.Title, store.ClipRunes(n.Summary, 600))
		sources = append(sources, src)
	}
	return b.String(), sources
}

func underAny(dir string, roots []string) bool {
	if dir == "" {
		return false
	}
	dir = filepath.Clean(dir)
	for _, r := range roots {
		if dir == r || strings.HasPrefix(dir, r+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// SafetyCode is twelve digits from both relay keys, the same whichever side
// computes it (ADR-110): to compare if either person wants to.
func SafetyCode(a, b string) string {
	k := []string{a, b}
	sort.Strings(k)
	h := sha256.Sum256([]byte("caprock-talks-safety-v1:" + k[0] + ":" + k[1]))
	n := binary.BigEndian.Uint64(h[:8]) % 1_000_000_000_000
	s := fmt.Sprintf("%012d", n)
	return s[0:4] + " " + s[4:8] + " " + s[8:12]
}

func (a *talksAdapter) view(st peers.Status) api.TalkPerson {
	return api.TalkPerson{Status: st, SafetyCode: SafetyCode(a.d.RemoteState("").HostID, st.ID)}
}

func (a *talksAdapter) People() []api.TalkPerson {
	out := []api.TalkPerson{}
	for _, st := range a.peopleMgr().List() {
		out = append(out, a.view(st))
	}
	return out
}

func (a *talksAdapter) SetPerson(id string, name *string, letStart *bool) error {
	m := a.peopleMgr()
	if _, err := m.Get(id); err != nil {
		return err
	}
	if name != nil {
		if err := m.Rename(id, *name); err != nil {
			return err
		}
	}
	if letStart != nil {
		return m.SetLetStart(id, *letStart)
	}
	return nil
}

// ensureRemote turns access from anywhere on when it is off — the decision
// on the machine ADR-058 requires, which inviting and accepting are — and
// waits for the relay.
func (a *talksAdapter) ensureRemote(ctx context.Context, relay string) (bool, error) {
	d := a.d
	turned := false
	if st := d.RemoteState(""); !st.Enabled {
		use := ""
		d.mu.Lock()
		if d.remoteSet != nil && d.remoteSet.Relay == "" && relay != "" && relay != remote.DefaultRelay {
			use = relay
		}
		d.mu.Unlock()
		if err := d.SetRemote(true, use, ""); err != nil {
			return false, fmt.Errorf("could not turn on access from anywhere here: %w", err)
		}
		turned = true
	}
	return turned, d.join.waitOnline(ctx)
}

// myKey is this machine's relay key: what the other side's code
// pre-approves.
func (a *talksAdapter) myKey() string {
	id := a.d.remoteIdentity()
	if id == nil {
		return ""
	}
	return remote.HostID(id.Public().(ed25519.PublicKey))
}

// personLink mints this side's pairing link with a code that pre-approves
// key for a person and no one else (pairing.NewCodeForKeyKind).
func (a *talksAdapter) personLink(key string) (string, error) {
	d := a.d
	d.mu.Lock()
	ps := d.remoteStoreLocked()
	d.mu.Unlock()
	if ps == nil {
		return "", errors.New("access from anywhere went off here while linking")
	}
	code, err := ps.NewCodeForKeyKind(key, pairing.KindPerson)
	if err != nil {
		return "", err
	}
	link := d.RemoteState(code).Link
	if link == "" {
		ps.ClearCode()
		return "", errors.New("this Caprock has no link to give: access from anywhere is off here")
	}
	return link, nil
}

func (a *talksAdapter) clearCode() {
	d := a.d
	d.mu.Lock()
	ps := d.remoteStoreLocked()
	d.mu.Unlock()
	if ps != nil {
		ps.ClearCode()
	}
}

func (a *talksAdapter) Invite(ctx context.Context, name string) (api.TalkInvite, error) {
	a.setName(name)
	turned, err := a.ensureRemote(ctx, "")
	if err != nil {
		return api.TalkInvite{}, err
	}
	d := a.d
	people := a.peopleMgr()
	base := d.baseCtx
	if base == nil {
		base = context.Background()
	}
	var desk *peers.JoinDesk
	desk = peers.NewJoinDesk(peers.JoinOptions{
		Relay:      func() string { return d.RemoteState("").Relay },
		Controller: a.myKey,
		Name:       a.name(),
		Version:    d.opt.Version,
		Log:        d.log,
		Pair:       people.Pair,
		Base:       base,
		TTL:        TalkInviteTTL,
		Back: func(_ context.Context, proven string) (string, error) {
			// The person who accepted: listed by the name they gave, and
			// allowed to start talks (ADR-110, on at accept).
			if j := desk.State().Joiner; j != "" {
				_ = people.Rename(proven, j)
			}
			_ = people.SetLetStart(proven, true)
			return a.personLink(proven)
		},
	})
	a.mu.Lock()
	if a.desk != nil {
		a.desk.Close()
	}
	a.desk = desk
	a.mu.Unlock()
	k, err := desk.New()
	if err != nil {
		return api.TalkInvite{}, err
	}
	a.Engine() // the engine runs from the first link on
	d.log.Info("a Talks invitation is open", "component", "talks", "expires_in", TalkInviteTTL.String())
	return api.TalkInvite{JoinState: k.JoinState, Key: k.Key, Link: api.TalkLinkBase + k.Key, TurnedOnRemote: turned}, nil
}

func (a *talksAdapter) InviteState() peers.JoinState {
	a.mu.Lock()
	desk := a.desk
	a.mu.Unlock()
	if desk == nil {
		return peers.JoinState{State: peers.JoinNone}
	}
	return desk.State()
}

func (a *talksAdapter) WithdrawInvite() {
	a.mu.Lock()
	desk := a.desk
	a.mu.Unlock()
	if desk != nil {
		desk.Withdraw()
	}
}

func (a *talksAdapter) Accept(ctx context.Context, key, name string) (api.TalkPerson, error) {
	jk, err := remote.ParseJoinKey(key)
	if err != nil {
		return api.TalkPerson{}, err
	}
	a.setName(name)
	turned, err := a.ensureRemote(ctx, jk.Relay)
	if err != nil {
		return api.TalkPerson{}, err
	}
	d := a.d
	id := d.remoteIdentity()
	if id == nil {
		return api.TalkPerson{}, peers.ErrNoIdentity
	}
	j, err := peers.Join(ctx, key, peers.JoinWithOptions{
		Name:     a.name(),
		Log:      d.log,
		Identity: id,
		Link:     func(_ context.Context, controller string) (string, error) { return a.personLink(controller) },
		Cancel:   a.clearCode,
	})
	if err != nil {
		return api.TalkPerson{}, err
	}
	if j.Link == "" {
		return api.TalkPerson{}, errors.New("the inviting Caprock linked this one but offered no link back: update Caprock there")
	}
	people := a.peopleMgr()
	st, err := people.Pair(ctx, j.Link)
	if err != nil {
		return api.TalkPerson{}, fmt.Errorf("linked there, but could not link back: %w", err)
	}
	if st.ID != j.Controller {
		_ = people.Forget(st.ID)
		return api.TalkPerson{}, errors.New("the link back is not the inviting Caprock's own")
	}
	if j.ControllerName != "" {
		_ = people.Rename(st.ID, j.ControllerName)
	}
	_ = people.SetLetStart(st.ID, true)
	st, _ = people.Get(st.ID)
	a.Engine()
	d.log.Info("a Talks invitation was accepted", "component", "talks", "person", st.ID)
	p := a.view(st)
	p.TurnedOnRemote = turned
	return p, nil
}

func (a *talksAdapter) RemovePerson(ctx context.Context, id string) error {
	m := a.peopleMgr()
	if _, err := m.Get(id); err != nil {
		return err
	}
	if err := m.Leave(ctx, id); err != nil {
		a.d.log.Info("the other side could not be told of the Remove; their token here is revoked", "component", "talks", "person", id, "err", err)
	}
	if err := m.Forget(id); err != nil {
		return err
	}
	return a.Engine().PersonGone(ctx, id, talks.ByMe)
}

func (a *talksAdapter) PersonLeft(ctx context.Context, key string) {
	m := a.peopleMgr()
	if _, err := m.Get(key); err == nil {
		_ = m.Forget(key)
	}
	if err := a.Engine().PersonGone(ctx, key, talks.ByThem); err != nil {
		a.d.log.Warn("could not end the talks of a person who left", "component", "talks", "err", err)
	}
}

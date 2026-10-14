package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/store"
)

// Second Brain (ADR-063; contract in 03-contracts.md § Second Brain): a graph
// of what the user's sessions did, decided and found. Read by every screen
// and every paired device; written on the machine. All of it is free — no
// cap on the memories, and the automatic extraction for anyone who says yes
// (owner decision, 2026-10-14): it runs on the user's own claude.

// brainTextBytes caps what one capture may carry; the node keeps a title and
// a paragraph of it.
const brainTextBytes = 64 << 10

// brainTopicsMax is how many topics one drop may name.
const brainTopicsMax = 8

// BrainStatus is GET /v1/brain/status.
type BrainStatus struct {
	// Memories is how many memories there are; Manual how many were dropped
	// in by hand.
	Memories int                       `json:"memories"`
	Manual   int                       `json:"manual"`
	Projects []store.BrainProjectCount `json:"projects"`
	// Auto is the automatic extraction's state, when it is wired.
	Auto any `json:"auto,omitempty"`
}

// BrainAuto is the automatic extraction (internal/brain), wired by the
// daemon. Nil in builds and tests without it.
type BrainAuto interface {
	// Status is its state for GET /v1/brain/status.
	Status(ctx context.Context) any
	// Configure applies PUT /v1/brain/settings and saves it.
	Configure(ctx context.Context, set BrainSettings) error
	// Estimate is what a backfill of the last days would read.
	Estimate(ctx context.Context, days int) (any, error)
	// Backfill asks for the last days to be read.
	Backfill(ctx context.Context, days int) error
}

// BrainSettings is PUT /v1/brain/settings; a nil field is left as it is.
type BrainSettings struct {
	Auto        *bool   `json:"auto,omitempty"`
	DailyTokens *int    `json:"daily_tokens,omitempty"`
	Model       *string `json:"model,omitempty"`
}

// Limits on the settings: the daily cap a user may choose, the models the
// extraction may ask for (the cheap end; "" is the default), the backfill.
const (
	brainDailyMin    = 20_000
	brainDailyMax    = 5_000_000
	brainBackfillMax = 90
)

var brainModels = map[string]bool{"": true, "haiku": true, "sonnet": true}

// handleBrainSettings turns the automatic extraction on or off and sets its
// limits. Nothing reads a session until the user turns it on here.
func (s *Server) handleBrainSettings(w http.ResponseWriter, r *http.Request) {
	if s.d.BrainAuto == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "automatic extraction is not available in this build"})
		return
	}
	var b BrainSettings
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	if b.DailyTokens != nil && (*b.DailyTokens < brainDailyMin || *b.DailyTokens > brainDailyMax) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("daily_tokens must be between %d and %d", brainDailyMin, brainDailyMax)})
		return
	}
	if b.Model != nil && !brainModels[*b.Model] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "model must be haiku or sonnet"})
		return
	}
	if err := s.d.BrainAuto.Configure(r.Context(), b); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.d.BrainAuto.Status(r.Context()))
}

// handleBrainBackfill estimates, or starts, a read of the last days.
func (s *Server) handleBrainBackfill(w http.ResponseWriter, r *http.Request) {
	if s.d.BrainAuto == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "automatic extraction is not available in this build"})
		return
	}
	var b struct {
		Days   int  `json:"days"`
		DryRun bool `json:"dry_run"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	if b.Days == 0 {
		b.Days = 30
	}
	if b.Days < 1 || b.Days > brainBackfillMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("days must be between 1 and %d", brainBackfillMax)})
		return
	}
	if !b.DryRun {
		if err := s.d.BrainAuto.Backfill(r.Context(), b.Days); err != nil {
			if errors.Is(err, ErrBrainAutoOff) {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			s.fail(w, err)
			return
		}
	}
	est, err := s.d.BrainAuto.Estimate(r.Context(), b.Days)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, est)
}

// ErrBrainAutoOff is a backfill asked for while the automatic extraction is
// off: it reads nothing until the user has said yes to it.
var ErrBrainAutoOff = errors.New("turn on building Second Brain automatically first")

func (s *Server) handleBrainGraph(w http.ResponseWriter, r *http.Request) {
	qv := r.URL.Query()
	f := store.BrainFilter{
		Query:     strings.TrimSpace(qv.Get("q")),
		Project:   strings.TrimSpace(qv.Get("project")),
		Summaries: qv.Get("summaries") == "1",
	}
	for _, p := range []struct {
		name string
		dst  *int64
	}{{"since", &f.Since}, {"until", &f.Until}} {
		if v := qv.Get(p.name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				s.failCode(w, http.StatusBadRequest, fmt.Errorf("%s is unix ms", p.name))
				return
			}
			*p.dst = n
		}
	}
	if v := qv.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			s.failCode(w, http.StatusBadRequest, errors.New("limit is a positive number"))
			return
		}
		f.Limit = n
	}
	g, err := store.ReadBrainGraph(r.Context(), s.d.Store.DB(), f)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) handleBrainStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db := s.d.Store.DB()
	st := BrainStatus{}
	var err error
	if st.Memories, err = store.CountBrainMemories(ctx, db, false); err != nil {
		s.fail(w, err)
		return
	}
	if st.Manual, err = store.CountBrainMemories(ctx, db, true); err != nil {
		s.fail(w, err)
		return
	}
	if st.Projects, err = store.BrainProjects(ctx, db); err != nil {
		s.fail(w, err)
		return
	}
	if s.d.BrainAuto != nil {
		st.Auto = s.d.BrainAuto.Status(ctx)
	}
	writeJSON(w, http.StatusOK, st)
}

// brainID reads {id}; ok is false once it has answered.
func brainID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": store.ErrBrainNotFound.Error()})
		return 0, false
	}
	return id, true
}

func (s *Server) brainErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrBrainNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": store.ErrBrainNotFound.Error()})
	case errors.Is(err, store.ErrBrainDuplicate):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, store.ErrBrainInvalid):
		// The joined error's second line is the reason.
		msg := err.Error()
		if i := strings.LastIndexByte(msg, '\n'); i >= 0 {
			msg = msg[i+1:]
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
	default:
		s.fail(w, err)
	}
}

func (s *Server) handleBrainNode(w http.ResponseWriter, r *http.Request) {
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	n, err := store.GetBrainNode(r.Context(), s.d.Store.DB(), id)
	if err != nil {
		s.brainErr(w, err)
		return
	}
	links, err := store.BrainNeighbours(r.Context(), s.d.Store.DB(), id, 200)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": n, "links": links})
}

// brainDrop is POST /v1/brain/nodes.
type brainDrop struct {
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
	// Text is what was captured: a line typed into the quick capture, or a
	// passage. Title and summary are taken from it when not given.
	Text string `json:"text"`
	// EventID drops an assistant note: its text, session, time and project
	// are read from the record, not trusted from the client.
	EventID   int64    `json:"event_id"`
	SessionID string   `json:"session_id"`
	Project   string   `json:"project"`
	Topics    []string `json:"topics"`
	Pinned    bool     `json:"pinned"`
}

func (s *Server) handleBrainDrop(w http.ResponseWriter, r *http.Request) {
	bad := func(msg string) { writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg}) }
	var b brainDrop
	if err := json.NewDecoder(io.LimitReader(r.Body, brainTextBytes+(16<<10))).Decode(&b); err != nil {
		bad("body is {text | title, summary?, kind?, event_id?, session_id?, project?, topics?}")
		return
	}
	for _, v := range append([]string{b.Text, b.Title, b.Summary, b.Project, b.SessionID}, b.Topics...) {
		if strings.ContainsRune(v, 0) || !utf8.ValidString(v) {
			bad("the text holds a character that cannot be stored")
			return
		}
	}
	if len(b.Text) > brainTextBytes {
		bad(fmt.Sprintf("the text is longer than %d KiB", brainTextBytes>>10))
		return
	}
	if len(b.Topics) > brainTopicsMax {
		bad(fmt.Sprintf("at most %d topics with one memory", brainTopicsMax))
		return
	}
	if b.Kind == "" {
		b.Kind = store.BrainIdea
	}
	if !store.IsBrainKind(b.Kind) {
		bad("kind is one of " + strings.Join(store.BrainKinds, ", "))
		return
	}
	ctx := r.Context()
	db := s.d.Store.DB()
	n := store.BrainNode{Kind: b.Kind, Title: b.Title, Summary: b.Summary, Manual: true, Pinned: b.Pinned}
	text := b.Text
	switch {
	case b.EventID > 0:
		// The same answer dropped twice is one memory.
		if prev, err := store.BrainNodeByEvent(ctx, db, b.EventID); err == nil {
			writeJSON(w, http.StatusOK, map[string]any{"node": prev, "created": false})
			return
		}
		src, noteText, err := store.BrainNoteSource(ctx, db, b.EventID)
		if errors.Is(err, store.ErrBrainNotFound) {
			bad("event_id is not an answer Claude wrote in a session's main thread")
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		n.Source = src
		if strings.TrimSpace(text) == "" {
			text = noteText
		}
	case b.SessionID != "":
		project, err := store.SessionProject(ctx, db, b.SessionID)
		if errors.Is(err, store.ErrBrainNotFound) {
			bad("no such session")
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		n.Source = store.BrainSource{SessionID: b.SessionID, Ts: s.d.Now().UnixMilli(), Project: project}
	}
	if n.Source.Project == "" {
		n.Source.Project = strings.TrimSpace(b.Project)
	}
	if strings.TrimSpace(n.Title) == "" {
		n.Title, n.Summary = brainTitleSummary(text, n.Summary)
	} else if strings.TrimSpace(n.Summary) == "" && strings.TrimSpace(text) != "" {
		_, n.Summary = brainTitleSummary(text, "")
	}
	if strings.TrimSpace(n.Title) == "" {
		bad("there is nothing to keep: give text or a title")
		return
	}
	now := s.d.Now().UnixMilli()
	var out store.BrainNode
	var created bool
	err := s.d.Store.WithTx(ctx, func(q store.Querier) error {
		var err error
		out, created, err = store.InsertBrainNode(ctx, q, n, now)
		if err != nil {
			return err
		}
		// A memory hangs off its project and its topics, so the graph clusters
		// by them from the first drop.
		if store.IsBrainEntity(out.Kind) {
			return nil
		}
		if out.Source.Project != "" {
			pid, err := store.EnsureBrainEntity(ctx, q, store.BrainProject, out.Source.Project, store.BrainSource{}, false, 0, now)
			if err != nil {
				return err
			}
			if err := store.LinkBrain(ctx, q, out.ID, pid, store.EdgePartOf, 1, now); err != nil {
				return err
			}
		}
		for _, t := range b.Topics {
			if store.NormTitle(t) == "" {
				continue
			}
			tid, err := store.EnsureBrainEntity(ctx, q, store.BrainTopic, t, store.BrainSource{}, true, 0, now)
			if err != nil {
				return err
			}
			if err := store.LinkBrain(ctx, q, out.ID, tid, store.EdgePartOf, 1, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.brainErr(w, err)
		return
	}
	if created {
		s.publishBrain(out, "added")
	}
	writeJSON(w, http.StatusOK, map[string]any{"node": out, "created": created})
}

func (s *Server) handlePatchBrainNode(w http.ResponseWriter, r *http.Request) {
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	var p store.BrainPatch
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&p); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {kind?, title?, summary?, pinned?}"})
		return
	}
	n, err := store.UpdateBrainNode(r.Context(), s.d.Store.DB(), id, p, s.d.Now().UnixMilli())
	if err != nil {
		s.brainErr(w, err)
		return
	}
	s.publishBrain(n, "changed")
	writeJSON(w, http.StatusOK, map[string]any{"node": n})
}

func (s *Server) handleDeleteBrainNode(w http.ResponseWriter, r *http.Request) {
	id, ok := brainID(w, r)
	if !ok {
		return
	}
	if err := store.DeleteBrainNode(r.Context(), s.d.Store.DB(), id); err != nil {
		s.brainErr(w, err)
		return
	}
	s.publishBrain(store.BrainNode{ID: id}, "deleted")
	w.WriteHeader(http.StatusNoContent)
}

// brainLinkBody is POST and DELETE /v1/brain/links.
type brainLinkBody struct {
	From int64  `json:"from"`
	To   int64  `json:"to"`
	Kind string `json:"kind"`
}

func (s *Server) handleBrainLink(w http.ResponseWriter, r *http.Request) {
	var b brainLinkBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&b); err != nil || b.From <= 0 || b.To <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is {from, to, kind?}"})
		return
	}
	if b.From == b.To {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a memory cannot be linked to itself"})
		return
	}
	if b.Kind == "" {
		b.Kind = store.EdgeRelates
	}
	ctx := r.Context()
	db := s.d.Store.DB()
	for _, id := range []int64{b.From, b.To} {
		if _, err := store.GetBrainNode(ctx, db, id); err != nil {
			s.brainErr(w, err)
			return
		}
	}
	if r.Method == http.MethodDelete {
		if err := store.UnlinkBrain(ctx, db, b.From, b.To); err != nil {
			s.fail(w, err)
			return
		}
	} else if err := store.LinkBrain(ctx, db, b.From, b.To, b.Kind, 1, s.d.Now().UnixMilli()); err != nil {
		s.brainErr(w, err)
		return
	}
	s.publishBrain(store.BrainNode{ID: b.From}, "changed")
	w.WriteHeader(http.StatusNoContent)
}

// publishBrain tells live screens the graph changed.
func (s *Server) publishBrain(n store.BrainNode, op string) {
	if s.d.Bus == nil {
		return
	}
	data := map[string]any{"id": n.ID, "op": op}
	if op != "deleted" {
		data["kind"], data["title"] = n.Kind, n.Title
	}
	s.d.Bus.Publish(bus.Frame{Type: bus.FrameBrain, Data: data})
}

var (
	mdLead   = regexp.MustCompile(`^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)+`)
	mdInline = strings.NewReplacer("**", "", "__", "", "`", "")
)

// brainTitleSummary makes a title and a summary from captured text: the
// first line that says something, without its Markdown, as the title; the
// whole passage, flattened to one paragraph, as the summary unless one was
// given — and none when the title already says all of it.
func brainTitleSummary(text, summary string) (string, string) {
	var title string
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(mdInline.Replace(mdLead.ReplaceAllString(strings.TrimSpace(l), "")))
		if l == "" || strings.Trim(l, "-=|:*_ ") == "" {
			continue
		}
		if title == "" {
			title = headline(l)
		}
		lines = append(lines, l)
	}
	if strings.TrimSpace(summary) != "" {
		return title, summary
	}
	flat := strings.Join(lines, " ")
	if utf8.RuneCountInString(flat) <= store.BrainTitleRunes && len(lines) <= 1 {
		return title, ""
	}
	return title, flat
}

// headline shortens a first line that is longer than a title: to its first
// sentence when that fits, else at the last word that fits, so a title never
// ends mid-word.
func headline(l string) string {
	r := []rune(l)
	if len(r) <= store.BrainTitleRunes {
		return l
	}
	for i := 12; i < store.BrainTitleRunes && i+1 < len(r); i++ {
		if (r[i] == '.' || r[i] == '!' || r[i] == '?' || r[i] == ';') && r[i+1] == ' ' {
			if r[i] == '?' || r[i] == '!' {
				return string(r[:i+1])
			}
			return string(r[:i])
		}
	}
	cut := store.BrainTitleRunes - 1
	for i := cut; i > store.BrainTitleRunes/2; i-- {
		if r[i] == ' ' {
			cut = i
			break
		}
	}
	return strings.TrimRight(string(r[:cut]), " ,;:-") + "…"
}

package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Second Brain (migration 0055, ADR-063): memories and the entities they hang
// off, as a graph. All of its SQL lives here; internal/api and internal/brain
// decide who may write what.

// Node kinds. The first four are memories; the last three are entities, which
// exist once per normalized title.
const (
	BrainIdea     = "idea"
	BrainDecision = "decision"
	BrainFinding  = "finding"
	BrainQuestion = "question"
	BrainTopic    = "topic"
	BrainPerson   = "person"
	BrainProject  = "project"
)

// Edge kinds.
const (
	EdgeRelates     = "relates"
	EdgeFollows     = "follows"
	EdgeContradicts = "contradicts"
	EdgePartOf      = "part_of"
)

// Limits on what one node holds: a title is a line, a summary a paragraph.
const (
	BrainTitleRunes   = 80
	BrainSummaryRunes = 400
)

// BrainKinds lists every node kind, memories first.
var BrainKinds = []string{BrainIdea, BrainDecision, BrainFinding, BrainQuestion, BrainTopic, BrainPerson, BrainProject}

// BrainEdgeKinds lists every edge kind.
var BrainEdgeKinds = []string{EdgeRelates, EdgeFollows, EdgeContradicts, EdgePartOf}

// IsBrainKind reports whether k is a node kind.
func IsBrainKind(k string) bool {
	for _, v := range BrainKinds {
		if v == k {
			return true
		}
	}
	return false
}

// IsBrainEdgeKind reports whether k is an edge kind.
func IsBrainEdgeKind(k string) bool {
	for _, v := range BrainEdgeKinds {
		if v == k {
			return true
		}
	}
	return false
}

// IsBrainEntity reports whether a kind is an entity — one per normalized
// title — rather than a memory.
func IsBrainEntity(k string) bool {
	return k == BrainTopic || k == BrainPerson || k == BrainProject
}

// BrainSource is where a memory was taken from: a session, the moment in it,
// and its project. Empty for a line typed into the quick capture.
type BrainSource struct {
	SessionID string `json:"session_id,omitempty"`
	EventID   int64  `json:"event_id,omitempty"`
	Ts        int64  `json:"ts,omitempty"`
	Project   string `json:"project,omitempty"`
}

// BrainNode is one node of the graph.
type BrainNode struct {
	ID        int64       `json:"id"`
	Kind      string      `json:"kind"`
	Title     string      `json:"title"`
	Summary   string      `json:"summary"`
	Source    BrainSource `json:"source"`
	Manual    bool        `json:"manual"`
	Pinned    bool        `json:"pinned"`
	RunID     int64       `json:"run_id,omitempty"`
	CreatedAt int64       `json:"created_at"`
	UpdatedAt int64       `json:"updated_at"`
	// Degree is how many returned edges touch it, filled in by the graph read.
	Degree int `json:"degree,omitempty"`
}

// BrainEdge is one edge.
type BrainEdge struct {
	From   int64   `json:"from"`
	To     int64   `json:"to"`
	Kind   string  `json:"kind"`
	Weight float64 `json:"weight"`
}

// ErrBrainNotFound is returned for an id no node has.
var ErrBrainNotFound = errors.New("no such memory")

// ErrBrainDuplicate is returned when a rename would give an entity the title
// of another of its kind.
var ErrBrainDuplicate = errors.New("there is already one with that title")

// ErrBrainInvalid wraps a node that cannot be stored as asked.
var ErrBrainInvalid = errors.New("invalid memory")

func brainInvalid(msg string) error { return errors.Join(ErrBrainInvalid, errors.New(msg)) }

// NormTitle folds a title for comparison: lower case, punctuation at the ends
// dropped, runs of spaces made one. "SQLite " and "sqlite." are one topic.
func NormTitle(s string) string {
	s = strings.ToLower(strings.Join(strings.Fields(s), " "))
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsPunct(r) || unicode.IsSpace(r) })
}

// ClipRunes shortens s to at most n runes, ending with an ellipsis when cut,
// after trimming the spaces around it.
func ClipRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

const brainCols = `n.id, n.kind, n.title, n.summary, n.session_id, COALESCE(n.event_id, 0), n.source_ts, n.project, n.manual, n.pinned, COALESCE(n.run_id, 0), n.created_at, n.updated_at`

func brainDest(v *BrainNode) []any {
	return []any{&v.ID, &v.Kind, &v.Title, &v.Summary, &v.Source.SessionID, &v.Source.EventID, &v.Source.Ts, &v.Source.Project, &v.Manual, &v.Pinned, &v.RunID, &v.CreatedAt, &v.UpdatedAt}
}

func scanBrain(sc interface{ Scan(...any) error }) (BrainNode, error) {
	var v BrainNode
	err := sc.Scan(brainDest(&v)...)
	return v, err
}

func scanBrainRows(rows *sql.Rows) ([]BrainNode, error) {
	defer rows.Close()
	out := []BrainNode{}
	for rows.Next() {
		v, err := scanBrain(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetBrainNode returns one node; ErrBrainNotFound when unknown.
func GetBrainNode(ctx context.Context, q Querier, id int64) (BrainNode, error) {
	v, err := scanBrain(q.QueryRowContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n WHERE n.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return BrainNode{}, ErrBrainNotFound
	}
	return v, err
}

// InsertBrainNode adds a node and returns it as stored, with created true. Title
// and summary are clipped to their limits. An entity whose normalized title
// already exists is not added again: the existing one is returned with created
// false, so "SQLite" dropped twice is one topic.
func InsertBrainNode(ctx context.Context, q Querier, v BrainNode, now int64) (BrainNode, bool, error) {
	if !IsBrainKind(v.Kind) {
		return BrainNode{}, false, brainInvalid("unknown memory kind")
	}
	v.Title = ClipRunes(strings.Join(strings.Fields(v.Title), " "), BrainTitleRunes)
	v.Summary = ClipRunes(v.Summary, BrainSummaryRunes)
	norm := NormTitle(v.Title)
	if norm == "" {
		return BrainNode{}, false, brainInvalid("a memory needs a title")
	}
	if IsBrainEntity(v.Kind) {
		var id int64
		err := q.QueryRowContext(ctx, `SELECT id FROM brain_nodes WHERE kind = ? AND norm = ?`, v.Kind, norm).Scan(&id)
		if err == nil {
			n, err := GetBrainNode(ctx, q, id)
			return n, false, err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return BrainNode{}, false, err
		}
	}
	res, err := q.ExecContext(ctx, `INSERT INTO brain_nodes
		(kind, title, norm, summary, session_id, event_id, source_ts, project, manual, pinned, run_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.Kind, v.Title, norm, v.Summary, v.Source.SessionID, nullID(v.Source.EventID), v.Source.Ts, v.Source.Project,
		v.Manual, v.Pinned, nullID(v.RunID), now, now)
	if err != nil {
		return BrainNode{}, false, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return BrainNode{}, false, err
	}
	n, err := GetBrainNode(ctx, q, id)
	return n, true, err
}

// EnsureBrainEntity returns the id of the entity of that kind and title,
// adding it when there is none.
func EnsureBrainEntity(ctx context.Context, q Querier, kind, title string, src BrainSource, manual bool, runID, now int64) (int64, error) {
	if !IsBrainEntity(kind) {
		return 0, brainInvalid("not an entity kind")
	}
	n, _, err := InsertBrainNode(ctx, q, BrainNode{Kind: kind, Title: title, Source: src, Manual: manual, RunID: runID}, now)
	return n.ID, err
}

// BrainEdgeWeightMax caps an edge's weight, so one busy pair cannot outweigh
// the whole graph.
const BrainEdgeWeightMax = 10

// LinkBrain adds an edge, or strengthens one that exists by adding weight to
// it, up to BrainEdgeWeightMax. A self-link is ignored.
func LinkBrain(ctx context.Context, q Querier, from, to int64, kind string, weight float64, now int64) error {
	if from == to || from <= 0 || to <= 0 {
		return nil
	}
	if !IsBrainEdgeKind(kind) {
		return brainInvalid("unknown link kind")
	}
	if weight <= 0 {
		weight = 1
	}
	_, err := q.ExecContext(ctx, `INSERT INTO brain_edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (src, dst, kind) DO UPDATE SET weight = MIN(?, weight + excluded.weight)`,
		from, to, kind, min(weight, BrainEdgeWeightMax), now, BrainEdgeWeightMax)
	return err
}

// UnlinkBrain removes every edge between two nodes, in either direction.
func UnlinkBrain(ctx context.Context, q Querier, a, b int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM brain_edges WHERE (src = ? AND dst = ?) OR (src = ? AND dst = ?)`, a, b, b, a)
	return err
}

// BrainPatch is a change to a node; nil fields stay.
type BrainPatch struct {
	Kind    *string `json:"kind"`
	Title   *string `json:"title"`
	Summary *string `json:"summary"`
	Pinned  *bool   `json:"pinned"`
}

// UpdateBrainNode applies a patch and returns the node as stored.
func UpdateBrainNode(ctx context.Context, q Querier, id int64, p BrainPatch, now int64) (BrainNode, error) {
	cur, err := GetBrainNode(ctx, q, id)
	if err != nil {
		return BrainNode{}, err
	}
	if p.Kind != nil {
		if !IsBrainKind(*p.Kind) {
			return BrainNode{}, brainInvalid("unknown memory kind")
		}
		cur.Kind = *p.Kind
	}
	if p.Title != nil {
		cur.Title = ClipRunes(strings.Join(strings.Fields(*p.Title), " "), BrainTitleRunes)
	}
	if p.Summary != nil {
		cur.Summary = ClipRunes(*p.Summary, BrainSummaryRunes)
	}
	if p.Pinned != nil {
		cur.Pinned = *p.Pinned
	}
	norm := NormTitle(cur.Title)
	if norm == "" {
		return BrainNode{}, brainInvalid("a memory needs a title")
	}
	if IsBrainEntity(cur.Kind) {
		var other int64
		err := q.QueryRowContext(ctx, `SELECT id FROM brain_nodes WHERE kind = ? AND norm = ? AND id != ?`, cur.Kind, norm, id).Scan(&other)
		if err == nil {
			return BrainNode{}, ErrBrainDuplicate
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return BrainNode{}, err
		}
	}
	if _, err := q.ExecContext(ctx, `UPDATE brain_nodes SET kind = ?, title = ?, norm = ?, summary = ?, pinned = ?, updated_at = ? WHERE id = ?`,
		cur.Kind, cur.Title, norm, cur.Summary, cur.Pinned, now, id); err != nil {
		return BrainNode{}, err
	}
	return GetBrainNode(ctx, q, id)
}

// DeleteBrainNode removes a node and its edges. A topic or person the delete
// leaves with no edge, and that was neither dropped by hand nor pinned, goes
// too: it existed only to connect what was just deleted.
func DeleteBrainNode(ctx context.Context, q Querier, id int64) error {
	var others []int64
	rows, err := q.QueryContext(ctx, `SELECT dst FROM brain_edges WHERE src = ? UNION SELECT src FROM brain_edges WHERE dst = ?`, id, id)
	if err != nil {
		return err
	}
	for rows.Next() {
		var o int64
		if err := rows.Scan(&o); err != nil {
			rows.Close()
			return err
		}
		others = append(others, o)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	res, err := q.ExecContext(ctx, `DELETE FROM brain_nodes WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrBrainNotFound
	}
	if len(others) == 0 {
		return nil
	}
	_, err = q.ExecContext(ctx, `DELETE FROM brain_nodes WHERE id IN (SELECT value FROM json_each(?))
		AND kind IN ('topic','person') AND manual = 0 AND pinned = 0
		AND NOT EXISTS (SELECT 1 FROM brain_edges e WHERE e.src = brain_nodes.id)
		AND NOT EXISTS (SELECT 1 FROM brain_edges e WHERE e.dst = brain_nodes.id)`, idList(others))
	return err
}

// CountBrainMemories is how many memories (not entities) there are;
// manualOnly counts those dropped in by hand (the free allowance, ADR-063).
func CountBrainMemories(ctx context.Context, q Querier, manualOnly bool) (int, error) {
	var n int
	query := `SELECT COUNT(*) FROM brain_nodes WHERE kind NOT IN ('topic','person','project')`
	if manualOnly {
		query += ` AND manual = 1`
	}
	err := q.QueryRowContext(ctx, query).Scan(&n)
	return n, err
}

// BrainFilter narrows the graph read.
type BrainFilter struct {
	// Query matches a node's title or summary, anywhere, case-insensitively
	// for ASCII.
	Query string
	// Project keeps the memories of one project.
	Project string
	// Since and Until bound when a memory was made, unix ms; 0 is open.
	Since, Until int64
	// Limit is how many memories at most; their entities come with them.
	Limit int
	// Summaries carries each node's summary. Off, the graph is lighter to
	// read and send, and a node's detail is read on its own.
	Summaries bool
}

// BrainGraphMax is the most memories one graph read returns.
const BrainGraphMax = 5000

// BrainGraph is the graph a screen draws: the newest memories that pass the
// filter (pinned ones first), the entities linked to them, and every edge
// between what is returned. Total is how many memories pass the filter.
type BrainGraph struct {
	Nodes []BrainNode `json:"nodes"`
	Edges []BrainEdge `json:"edges"`
	Total int         `json:"total"`
}

// empty is a read of the whole graph: no words, project or span, and no
// limit below the ceiling (the sidebar's thirty newest are a selection).
// Called after the limit is normalised.
func (f BrainFilter) empty() bool {
	return strings.TrimSpace(f.Query) == "" && f.Project == "" && f.Since == 0 && f.Until == 0 && f.Limit >= BrainGraphMax
}

// ReadBrainGraph reads the graph for a filter.
func ReadBrainGraph(ctx context.Context, q Querier, f BrainFilter) (BrainGraph, error) {
	if f.Limit <= 0 || f.Limit > BrainGraphMax {
		f.Limit = BrainGraphMax
	}
	where := []string{`n.kind NOT IN ('topic','person','project')`}
	args := []any{}
	if t := strings.TrimSpace(f.Query); t != "" {
		p := "%" + escapeLike(t) + "%"
		where = append(where, `(n.title LIKE ? ESCAPE '\' OR n.summary LIKE ? ESCAPE '\')`)
		args = append(args, p, p)
	}
	if f.Project != "" {
		where = append(where, `n.project = ?`)
		args = append(args, f.Project)
	}
	if f.Since > 0 {
		where = append(where, `n.created_at >= ?`)
		args = append(args, f.Since)
	}
	if f.Until > 0 {
		where = append(where, `n.created_at < ?`)
		args = append(args, f.Until)
	}
	cond := strings.Join(where, " AND ")
	cols := brainCols
	if !f.Summaries {
		cols = strings.Replace(cols, "n.summary", "''", 1)
	}
	g := BrainGraph{Nodes: []BrainNode{}, Edges: []BrainEdge{}}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_nodes n WHERE `+cond, args...).Scan(&g.Total); err != nil {
		return g, err
	}
	rows, err := q.QueryContext(ctx, `SELECT `+cols+` FROM brain_nodes n WHERE `+cond+`
		ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC LIMIT ?`, append(args, f.Limit)...)
	if err != nil {
		return g, err
	}
	mems, err := scanBrainRows(rows)
	if err != nil {
		return g, err
	}
	in := make(map[int64]bool, len(mems))
	for _, m := range mems {
		in[m.ID] = true
	}
	// The edges. A large selection reads every edge and keeps the ones it
	// needs, which is one scan of a small table; a narrow one walks the
	// indexes from its memories. Both measured in brain_test.go.
	bulk := f.empty() || len(mems) >= brainBulkRead
	var edges []BrainEdge
	if bulk {
		rows, err := q.QueryContext(ctx, `SELECT src, dst, kind, weight FROM brain_edges`)
		if err != nil {
			return g, err
		}
		if edges, err = scanEdges(rows); err != nil {
			return g, err
		}
	} else if edges, err = brainEdgesTouching(ctx, q, mems); err != nil {
		return g, err
	}
	// The entities: with no filter every one of them, so a topic dropped in by
	// hand and nothing links to yet is part of the graph too; else the ones an
	// edge from a selected memory reaches.
	var ents []BrainNode
	if f.empty() {
		rows, err := q.QueryContext(ctx, `SELECT `+cols+` FROM brain_nodes n WHERE n.kind IN ('topic','person','project')
			ORDER BY n.updated_at DESC LIMIT ?`, f.Limit)
		if err != nil {
			return g, err
		}
		if ents, err = scanBrainRows(rows); err != nil {
			return g, err
		}
	} else {
		seen := map[int64]bool{}
		var need []int64
		for _, e := range edges {
			if !in[e.From] && !in[e.To] {
				continue
			}
			for _, id := range []int64{e.From, e.To} {
				if !in[id] && !seen[id] {
					seen[id] = true
					need = append(need, id)
				}
			}
		}
		if ents, err = brainNodesByID(ctx, q, need); err != nil {
			return g, err
		}
		// Only entities join a selection: a memory a selected one relates to
		// did not pass the filter, and the limit counts memories.
		ents = slices.DeleteFunc(ents, func(n BrainNode) bool { return !IsBrainEntity(n.Kind) })
		// A narrow read found only the edges that touch a memory; an edge
		// between two of its entities (a topic part_of a project) is read
		// once the entity set is known.
		if !bulk && len(ents) > 1 {
			extra, err := brainEdgesAmong(ctx, q, ents)
			if err != nil {
				return g, err
			}
			edges = append(edges, extra...)
		}
	}
	nodes := make([]BrainNode, 0, len(mems)+len(ents))
	nodes = append(nodes, mems...)
	nodes = append(nodes, ents...)
	at := make(map[int64]int, len(nodes))
	for i, n := range nodes {
		at[n.ID] = i
	}
	for _, e := range edges {
		i, okFrom := at[e.From]
		j, okTo := at[e.To]
		if !okFrom || !okTo {
			continue
		}
		nodes[i].Degree++
		nodes[j].Degree++
		g.Edges = append(g.Edges, e)
	}
	g.Nodes = nodes
	return g, nil
}

// brainBulkRead is the selection above which the graph read scans every edge
// instead of walking the indexes from each memory.
const brainBulkRead = 400

// idList renders ids as a JSON array for json_each, which keeps one bound
// parameter whatever the count (SQLite caps the number of parameters).
func idList(ids []int64) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, id := range ids {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatInt(id, 10))
	}
	b.WriteByte(']')
	return b.String()
}

func nodeIDs(nodes []BrainNode) []int64 {
	out := make([]int64, len(nodes))
	for i, n := range nodes {
		out[i] = n.ID
	}
	return out
}

func scanEdges(rows *sql.Rows) ([]BrainEdge, error) {
	defer rows.Close()
	out := []BrainEdge{}
	for rows.Next() {
		var e BrainEdge
		if err := rows.Scan(&e.From, &e.To, &e.Kind, &e.Weight); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// brainEdgesTouching returns every edge with an end among the nodes, once.
func brainEdgesTouching(ctx context.Context, q Querier, nodes []BrainNode) ([]BrainEdge, error) {
	if len(nodes) == 0 {
		return nil, nil
	}
	list := idList(nodeIDs(nodes))
	rows, err := q.QueryContext(ctx, `
		SELECT e.src, e.dst, e.kind, e.weight FROM brain_edges e WHERE e.src IN (SELECT value FROM json_each(?))
		UNION
		SELECT e.src, e.dst, e.kind, e.weight FROM brain_edges e WHERE e.dst IN (SELECT value FROM json_each(?))`, list, list)
	if err != nil {
		return nil, err
	}
	return scanEdges(rows)
}

// brainEdgesAmong returns the edges whose both ends are among the nodes.
func brainEdgesAmong(ctx context.Context, q Querier, nodes []BrainNode) ([]BrainEdge, error) {
	list := idList(nodeIDs(nodes))
	rows, err := q.QueryContext(ctx, `SELECT e.src, e.dst, e.kind, e.weight FROM brain_edges e
		WHERE e.src IN (SELECT value FROM json_each(?)) AND e.dst IN (SELECT value FROM json_each(?))`, list, list)
	if err != nil {
		return nil, err
	}
	return scanEdges(rows)
}

func brainNodesByID(ctx context.Context, q Querier, ids []int64) ([]BrainNode, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n WHERE n.id IN (SELECT value FROM json_each(?))`, idList(ids))
	if err != nil {
		return nil, err
	}
	return scanBrainRows(rows)
}

// BrainLink is a neighbour of a node: the node, and the edge between them.
type BrainLink struct {
	Node BrainNode `json:"node"`
	Kind string    `json:"kind"`
	// Out is true when the edge goes from the node asked about to this one.
	Out    bool    `json:"out"`
	Weight float64 `json:"weight"`
}

// BrainNeighbours returns what a node is linked to, strongest first.
func BrainNeighbours(ctx context.Context, q Querier, id int64, limit int) ([]BrainLink, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := q.QueryContext(ctx, `
		SELECT `+brainCols+`, l.kind, l.out, l.weight FROM (
			SELECT dst AS other, kind, 1 AS out, weight FROM brain_edges WHERE src = ?
			UNION ALL
			SELECT src AS other, kind, 0 AS out, weight FROM brain_edges WHERE dst = ?
		) l JOIN brain_nodes n ON n.id = l.other
		ORDER BY l.weight DESC, n.created_at DESC LIMIT ?`, id, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainLink{}
	for rows.Next() {
		var l BrainLink
		if err := rows.Scan(append(brainDest(&l.Node), &l.Kind, &l.Out, &l.Weight)...); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// BrainProjectCount is one project with how many memories it has.
type BrainProjectCount struct {
	Project string `json:"project"`
	Count   int    `json:"count"`
}

// BrainProjects lists the projects memories belong to, most memories first,
// for the screen's filter.
func BrainProjects(ctx context.Context, q Querier) ([]BrainProjectCount, error) {
	rows, err := q.QueryContext(ctx, `SELECT project, COUNT(*) FROM brain_nodes
		WHERE project != '' AND kind NOT IN ('topic','person','project')
		GROUP BY project ORDER BY COUNT(*) DESC, project LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainProjectCount{}
	for rows.Next() {
		var p BrainProjectCount
		if err := rows.Scan(&p.Project, &p.Count); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// BrainEntityTitles returns the titles of the entities of a kind that the most
// edges reach, for the extraction to link new memories to what exists.
func BrainEntityTitles(ctx context.Context, q Querier, kind string, limit int) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT n.title FROM brain_nodes n
		WHERE n.kind = ?
		ORDER BY (SELECT COUNT(*) FROM brain_edges e WHERE e.dst = n.id) DESC, n.updated_at DESC LIMIT ?`, kind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// BrainNoteSource returns where an assistant note came from — its session,
// time and project — and its text, for a memory dropped from it. An event
// that is not main-thread prose is ErrBrainNotFound.
func BrainNoteSource(ctx context.Context, q Querier, eventID int64) (BrainSource, string, error) {
	var src BrainSource
	var text string
	err := q.QueryRowContext(ctx, `
		SELECT e.session_id, e.ts, COALESCE(se.project, ''), COALESCE(json_extract(e.payload, '$.text'), '')
		FROM events e LEFT JOIN sessions se ON se.session_id = e.session_id
		WHERE e.id = ? AND `+assistantTextWhere, eventID).Scan(&src.SessionID, &src.Ts, &src.Project, &text)
	if errors.Is(err, sql.ErrNoRows) {
		return src, "", ErrBrainNotFound
	}
	src.EventID = eventID
	return src, text, err
}

// SessionProject returns a session's project, ” when unknown.
func SessionProject(ctx context.Context, q Querier, sessionID string) (string, error) {
	var p string
	err := q.QueryRowContext(ctx, `SELECT COALESCE(project, '') FROM sessions WHERE session_id = ?`, sessionID).Scan(&p)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrBrainNotFound
	}
	return p, err
}

// BrainNodeByEvent returns the memory dropped in by hand from an event, if
// there is one: dropping the same answer twice keeps one memory.
func BrainNodeByEvent(ctx context.Context, q Querier, eventID int64) (BrainNode, error) {
	v, err := scanBrain(q.QueryRowContext(ctx, `SELECT `+brainCols+` FROM brain_nodes n
		WHERE n.event_id = ? AND n.manual = 1 AND n.kind NOT IN ('topic','person','project') ORDER BY n.id LIMIT 1`, eventID))
	if errors.Is(err, sql.ErrNoRows) {
		return BrainNode{}, ErrBrainNotFound
	}
	return v, err
}

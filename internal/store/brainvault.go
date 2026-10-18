package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Obsidian vaults in Second Brain (migration 0062, ADR-079): the vaults the
// user picked, one source row per note file, and the edges each vault's
// import claims. internal/obsidian decides what a vault says; every write
// of it goes through here.

// BrainNote is the node kind an imported note gets when no node with its
// title or an alias already exists. It is a memory-like node, never an
// entity.
const BrainNote = "note"

// BrainCluster is the project a note is put under when no folder on its
// path is named like a Caprock project.
const BrainCluster = "Obsidian"

// BrainVault is one imported vault.
type BrainVault struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
	// Agents is whether its notes may reach an agent: a new session's
	// handoff, the extraction's list of topics. Off unless the user turns
	// it on (ADR-079).
	Agents    bool   `json:"agents"`
	Notes     int    `json:"notes"`
	ScannedAt int64  `json:"scanned_at,omitempty"`
	ScanMs    int64  `json:"scan_ms"`
	Error     string `json:"error,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

// ErrVaultExists is a vault added twice.
var ErrVaultExists = errors.New("that vault is already imported")

// ErrVaultNotFound is an id no vault has.
var ErrVaultNotFound = errors.New("no such vault")

const vaultCols = `id, name, path, agents, notes, scanned_at, scan_ms, error, created_at`

func scanVault(sc interface{ Scan(...any) error }) (BrainVault, error) {
	var v BrainVault
	err := sc.Scan(&v.ID, &v.Name, &v.Path, &v.Agents, &v.Notes, &v.ScannedAt, &v.ScanMs, &v.Error, &v.CreatedAt)
	return v, err
}

// ListBrainVaults returns the vaults, oldest first.
func ListBrainVaults(ctx context.Context, q Querier) ([]BrainVault, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+vaultCols+` FROM brain_vaults ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainVault{}
	for rows.Next() {
		v, err := scanVault(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetBrainVault returns one vault; ErrVaultNotFound when unknown.
func GetBrainVault(ctx context.Context, q Querier, id int64) (BrainVault, error) {
	v, err := scanVault(q.QueryRowContext(ctx, `SELECT `+vaultCols+` FROM brain_vaults WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return BrainVault{}, ErrVaultNotFound
	}
	return v, err
}

// InsertBrainVault adds a vault; ErrVaultExists when its path is taken.
func InsertBrainVault(ctx context.Context, q Querier, name, path string, agents bool, now int64) (BrainVault, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM brain_vaults WHERE path = ?`, path).Scan(&id)
	if err == nil {
		return BrainVault{}, ErrVaultExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return BrainVault{}, err
	}
	res, err := q.ExecContext(ctx, `INSERT INTO brain_vaults (name, path, agents, created_at) VALUES (?, ?, ?, ?)`, name, path, agents, now)
	if err != nil {
		return BrainVault{}, err
	}
	if id, err = res.LastInsertId(); err != nil {
		return BrainVault{}, err
	}
	return GetBrainVault(ctx, q, id)
}

// SetBrainVaultAgents turns a vault's notes reaching agents on or off.
func SetBrainVaultAgents(ctx context.Context, q Querier, id int64, on bool) error {
	res, err := q.ExecContext(ctx, `UPDATE brain_vaults SET agents = ? WHERE id = ?`, on, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrVaultNotFound
	}
	return nil
}

// RecordBrainVaultScan keeps how a scan went: the notes it found, how long
// it took and why it failed ("" when it did not).
func RecordBrainVaultScan(ctx context.Context, q Querier, id int64, notes int, scanMs int64, errText string, now int64) error {
	if errText != "" {
		_, err := q.ExecContext(ctx, `UPDATE brain_vaults SET error = ?, scanned_at = ?, scan_ms = ? WHERE id = ?`, errText, now, scanMs, id)
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE brain_vaults SET notes = ?, scan_ms = ?, error = '', scanned_at = ? WHERE id = ?`, notes, scanMs, now, id)
	return err
}

// BrainVaultNote is one note file of a vault: the source mark on its node.
type BrainVaultNote struct {
	ID      int64
	VaultID int64
	Path    string
	NodeID  int64
	Title   string
	Aliases []string
	// Keys are the title and aliases normalised (NormTitle): what makes two
	// notes, or a note and a memory, one node.
	Keys    []string
	Links   []string
	Tags    []string
	Project string
	Excerpt string
	Mtime   int64
	Size    int64
}

func lines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func joinLines(l []string) string { return strings.Join(l, "\n") }

const vaultNoteCols = `id, vault_id, path, node_id, title, aliases, keys, links, tags, project, excerpt, mtime, size`

func scanVaultNote(sc interface{ Scan(...any) error }) (BrainVaultNote, error) {
	var n BrainVaultNote
	var aliases, keys, links, tags string
	err := sc.Scan(&n.ID, &n.VaultID, &n.Path, &n.NodeID, &n.Title, &aliases, &keys, &links, &tags, &n.Project, &n.Excerpt, &n.Mtime, &n.Size)
	n.Aliases, n.Keys, n.Links, n.Tags = lines(aliases), lines(keys), lines(links), lines(tags)
	return n, err
}

// BrainVaultNotes returns a vault's note rows.
func BrainVaultNotes(ctx context.Context, q Querier, vaultID int64) ([]BrainVaultNote, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+vaultNoteCols+` FROM brain_vault_notes WHERE vault_id = ? ORDER BY id`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BrainVaultNote
	for rows.Next() {
		n, err := scanVaultNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// EachBrainKey calls fn with every normalised title a node answers to: each
// memory's own title, and each vault note row's title and aliases (a note
// node's title is its row's).
func EachBrainKey(ctx context.Context, q Querier, fn func(key string, nodeID int64)) error {
	rows, err := q.QueryContext(ctx, `SELECT id, norm FROM brain_nodes WHERE kind IN ('idea','decision','finding','question')`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var k string
		if err := rows.Scan(&id, &k); err != nil {
			rows.Close()
			return err
		}
		fn(k, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	rows, err = q.QueryContext(ctx, `SELECT node_id, keys FROM brain_vault_notes`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var keys string
		if err := rows.Scan(&id, &keys); err != nil {
			return err
		}
		for _, k := range lines(keys) {
			fn(k, id)
		}
	}
	return rows.Err()
}

// InsertBrainVaultNote adds a note row and returns its id.
func InsertBrainVaultNote(ctx context.Context, q Querier, n BrainVaultNote) (int64, error) {
	res, err := q.ExecContext(ctx, `INSERT INTO brain_vault_notes
		(vault_id, path, node_id, title, aliases, keys, links, tags, project, excerpt, mtime, size)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.VaultID, n.Path, n.NodeID, n.Title, joinLines(n.Aliases), joinLines(n.Keys), joinLines(n.Links), joinLines(n.Tags), n.Project, n.Excerpt, n.Mtime, n.Size)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateBrainVaultNote rewrites a note row in place (same path, same node).
func UpdateBrainVaultNote(ctx context.Context, q Querier, n BrainVaultNote) error {
	_, err := q.ExecContext(ctx, `UPDATE brain_vault_notes SET node_id = ?, title = ?, aliases = ?, keys = ?, links = ?, tags = ?,
		project = ?, excerpt = ?, mtime = ?, size = ? WHERE id = ?`,
		n.NodeID, n.Title, joinLines(n.Aliases), joinLines(n.Keys), joinLines(n.Links), joinLines(n.Tags), n.Project, n.Excerpt, n.Mtime, n.Size, n.ID)
	return err
}

// DeleteBrainVaultNote removes a note row. The node it marked is not
// touched; SyncBrainNoteNode settles it.
func DeleteBrainVaultNote(ctx context.Context, q Querier, id int64) error {
	_, err := q.ExecContext(ctx, `DELETE FROM brain_vault_notes WHERE id = ?`, id)
	return err
}

// BrainNoteNodeAlone reports whether a node is a note node no note row marks:
// one whose only source just left.
func BrainNoteNodeAlone(ctx context.Context, q Querier, nodeID int64) (bool, error) {
	var ok int
	err := q.QueryRowContext(ctx, `SELECT kind = 'note' AND NOT EXISTS (SELECT 1 FROM brain_vault_notes WHERE node_id = ?)
		FROM brain_nodes WHERE id = ?`, nodeID, nodeID).Scan(&ok)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return ok == 1, err
}

// InsertBrainNoteNode adds the node of a note with no node to join: kind
// note, made by the vault, under its project, its aliases in its search —
// what SyncBrainNoteNode would make of it, so a new node needs no sync.
func InsertBrainNoteNode(ctx context.Context, q Querier, vaultID int64, n BrainVaultNote, now int64) (int64, error) {
	title := ClipRunes(strings.Join(strings.Fields(n.Title), " "), BrainTitleRunes)
	if NormTitle(title) == "" {
		return 0, brainInvalid("a note needs a title")
	}
	summary := ClipRunes(n.Excerpt, BrainSummaryRunes)
	created := n.Mtime
	if created <= 0 {
		created = now
	}
	res, err := q.ExecContext(ctx, `INSERT INTO brain_nodes
		(kind, title, norm, summary, search, source_ts, project, manual, pinned, created_at, updated_at, vault_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
		BrainNote, title, NormTitle(title), summary, BrainSearchDoc(title, summary+"\n"+joinLines(n.Aliases), n.Project), n.Mtime, n.Project, created, now, vaultID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SyncBrainNoteNode settles a node after its note rows changed. A note node
// with no row left is deleted, with its edges. A note node with rows takes
// its title, summary, project and time from the oldest row — the source
// that made it — and belongs to that row's vault. Any node with rows has the
// rows' aliases and the other rows' excerpts in its search, so a search
// finds it by any of its sources; their texts are never merged into its
// summary. deleted is true when the node went.
func SyncBrainNoteNode(ctx context.Context, q Querier, nodeID int64, now int64) (deleted bool, err error) {
	node, err := GetBrainNode(ctx, q, nodeID)
	if errors.Is(err, ErrBrainNotFound) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	rows, err := q.QueryContext(ctx, `SELECT `+vaultNoteCols+` FROM brain_vault_notes WHERE node_id = ? ORDER BY id`, nodeID)
	if err != nil {
		return false, err
	}
	var src []BrainVaultNote
	for rows.Next() {
		n, err := scanVaultNote(rows)
		if err != nil {
			rows.Close()
			return false, err
		}
		src = append(src, n)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	if node.Kind == BrainNote && len(src) == 0 {
		_, err := q.ExecContext(ctx, `DELETE FROM brain_nodes WHERE id = ?`, nodeID)
		return true, err
	}
	title, summary, project, ts := node.Title, node.Summary, node.Source.Project, node.Source.Ts
	var vault any
	if node.Kind == BrainNote {
		p := src[0]
		title = ClipRunes(strings.Join(strings.Fields(p.Title), " "), BrainTitleRunes)
		summary = ClipRunes(p.Excerpt, BrainSummaryRunes)
		project, ts, vault = p.Project, p.Mtime, p.VaultID
	}
	var extra []string
	for i, s := range src {
		extra = append(extra, s.Aliases...)
		if node.Kind != BrainNote || i > 0 {
			extra = append(extra, s.Excerpt)
		}
	}
	search := BrainSearchDoc(title, summary+"\n"+strings.Join(extra, "\n"), project)
	if node.Kind == BrainNote {
		_, err = q.ExecContext(ctx, `UPDATE brain_nodes SET title = ?, norm = ?, summary = ?, project = ?, source_ts = ?, vault_id = ?, search = ?,
			updated_at = CASE WHEN title != ? OR summary != ? OR project != ? THEN ? ELSE updated_at END WHERE id = ?`,
			title, NormTitle(title), summary, project, ts, vault, search, title, summary, project, now, nodeID)
	} else {
		_, err = q.ExecContext(ctx, `UPDATE brain_nodes SET search = ? WHERE id = ?`, search, nodeID)
	}
	return false, err
}

// brainSearchExtra is what a node's search holds past its title, summary and
// project: its note rows' aliases and excerpts (SyncBrainNoteNode), so an
// edit by hand keeps them.
func brainSearchExtra(ctx context.Context, q Querier, n BrainNode) (string, error) {
	rows, err := q.QueryContext(ctx, `SELECT aliases, excerpt FROM brain_vault_notes WHERE node_id = ? ORDER BY id`, n.ID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var extra []string
	first := true
	for rows.Next() {
		var aliases, excerpt string
		if err := rows.Scan(&aliases, &excerpt); err != nil {
			return "", err
		}
		extra = append(extra, lines(aliases)...)
		if n.Kind != BrainNote || !first {
			extra = append(extra, excerpt)
		}
		first = false
	}
	return strings.Join(extra, "\n"), rows.Err()
}

// BrainClaim is an edge a vault's import wants.
type BrainClaim struct {
	Src, Dst int64
	Kind     string
}

// BrainVaultClaims returns the edges a vault claims, each with whether the
// edge was there before any vault claimed it (pre).
func BrainVaultClaims(ctx context.Context, q Querier, vaultID int64) (map[BrainClaim]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT src, dst, kind, pre FROM brain_vault_edges WHERE vault_id = ?`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[BrainClaim]bool{}
	for rows.Next() {
		var c BrainClaim
		var pre bool
		if err := rows.Scan(&c.Src, &c.Dst, &c.Kind, &pre); err != nil {
			return nil, err
		}
		out[c] = pre
	}
	return out, rows.Err()
}

// otherClaims returns the edges vaults other than this one claim, with pre.
func otherClaims(ctx context.Context, q Querier, vaultID int64) (map[BrainClaim]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT src, dst, kind, MAX(pre) FROM brain_vault_edges WHERE vault_id != ? GROUP BY src, dst, kind`, vaultID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[BrainClaim]bool{}
	for rows.Next() {
		var c BrainClaim
		var pre bool
		if err := rows.Scan(&c.Src, &c.Dst, &c.Kind, &pre); err != nil {
			return nil, err
		}
		out[c] = pre
	}
	return out, rows.Err()
}

// ClaimBrainEdges records that a vault wants these edges and makes the ones
// that are not there. An edge that was there before any vault claimed it is
// marked pre, so no vault's removal ever takes it away. A claim does not add
// to an edge's weight, so refreshing a vault does not strengthen its links.
func ClaimBrainEdges(ctx context.Context, q Querier, vaultID int64, claims []BrainClaim, now int64) error {
	if len(claims) == 0 {
		return nil
	}
	others, err := otherClaims(ctx, q, vaultID)
	if err != nil {
		return err
	}
	pq, done := Prepared(q)
	defer done()
	for _, c := range claims {
		if c.Src == c.Dst || c.Src <= 0 || c.Dst <= 0 || !IsBrainEdgeKind(c.Kind) {
			continue
		}
		pre, claimed := others[c]
		if !claimed {
			res, err := pq.ExecContext(ctx, `INSERT INTO brain_edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, 1, ?)
				ON CONFLICT (src, dst, kind) DO NOTHING`, c.Src, c.Dst, c.Kind, now)
			if err != nil {
				return err
			}
			n, _ := res.RowsAffected()
			pre = n == 0
		}
		if _, err := pq.ExecContext(ctx, `INSERT INTO brain_vault_edges (vault_id, src, dst, kind, pre) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT DO NOTHING`, vaultID, c.Src, c.Dst, c.Kind, pre); err != nil {
			return err
		}
	}
	return nil
}

// ReleaseBrainEdges drops a vault's claims on these edges, and each edge
// itself when no other vault claims it and no vault found it already there.
func ReleaseBrainEdges(ctx context.Context, q Querier, vaultID int64, claims map[BrainClaim]bool) error {
	if len(claims) == 0 {
		return nil
	}
	others, err := otherClaims(ctx, q, vaultID)
	if err != nil {
		return err
	}
	pq, done := Prepared(q)
	defer done()
	for c, pre := range claims {
		if _, err := pq.ExecContext(ctx, `DELETE FROM brain_vault_edges WHERE vault_id = ? AND src = ? AND dst = ? AND kind = ?`,
			vaultID, c.Src, c.Dst, c.Kind); err != nil {
			return err
		}
		if _, claimed := others[c]; pre || claimed {
			continue
		}
		if _, err := pq.ExecContext(ctx, `DELETE FROM brain_edges WHERE src = ? AND dst = ? AND kind = ?`, c.Src, c.Dst, c.Kind); err != nil {
			return err
		}
	}
	return nil
}

// EnsureBrainVaultEntity returns the entity of a kind and title, adding it,
// marked as the vault's, when there is none. An existing one is reused
// whoever made it: a #tag that names a topic Second Brain already has joins
// that topic.
func EnsureBrainVaultEntity(ctx context.Context, q Querier, vaultID int64, kind, title string, now int64) (int64, error) {
	if !IsBrainEntity(kind) {
		return 0, brainInvalid("not an entity kind")
	}
	n, created, err := InsertBrainNode(ctx, q, BrainNode{Kind: kind, Title: title}, now)
	if err != nil {
		return 0, err
	}
	if created {
		if _, err := q.ExecContext(ctx, `UPDATE brain_nodes SET vault_id = ? WHERE id = ?`, vaultID, n.ID); err != nil {
			return 0, err
		}
	}
	return n.ID, nil
}

// BrainEntityByNorm returns the id of the entity of a kind with a
// normalised title, 0 when there is none.
func BrainEntityByNorm(ctx context.Context, q Querier, kind, norm string) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM brain_nodes WHERE kind = ? AND norm = ?`, kind, norm).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

// CleanBrainVaultEntities settles the topics, people and projects a vault's
// import made: one no edge reaches any more goes, unless it was pinned;
// one still in use stays and passes to another vault whose edges reach it,
// or to nobody.
func CleanBrainVaultEntities(ctx context.Context, q Querier, vaultID int64) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM brain_nodes WHERE vault_id = ? AND kind IN ('topic','person','project') AND pinned = 0
		AND NOT EXISTS (SELECT 1 FROM brain_edges e WHERE e.src = brain_nodes.id)
		AND NOT EXISTS (SELECT 1 FROM brain_edges e WHERE e.dst = brain_nodes.id)`, vaultID); err != nil {
		return err
	}
	return nil
}

// RemoveBrainVault takes a vault out of Second Brain: its claims on edges
// (and the edges no one else wants), its note rows, the note nodes no other
// source keeps, the entities only it used, and the vault. Nodes it only
// added a source to stay as they were. Set-based: a 5,000-note vault is a
// handful of statements, not one per edge.
func RemoveBrainVault(ctx context.Context, q Querier, id int64, now int64) error {
	if _, err := GetBrainVault(ctx, q, id); err != nil {
		return err
	}
	// The edges only this vault wanted and no vault found there.
	if _, err := q.ExecContext(ctx, `DELETE FROM brain_edges WHERE EXISTS (
			SELECT 1 FROM brain_vault_edges v WHERE v.vault_id = ? AND v.pre = 0
			AND v.src = brain_edges.src AND v.dst = brain_edges.dst AND v.kind = brain_edges.kind)
		AND NOT EXISTS (
			SELECT 1 FROM brain_vault_edges o WHERE o.vault_id != ?
			AND o.src = brain_edges.src AND o.dst = brain_edges.dst AND o.kind = brain_edges.kind)`, id, id); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM brain_vault_edges WHERE vault_id = ?`, id); err != nil {
		return err
	}
	// The nodes another source or Second Brain itself keeps, to settle once
	// this vault's rows are gone.
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT s.node_id FROM brain_vault_notes s JOIN brain_nodes n ON n.id = s.node_id
		WHERE s.vault_id = ? AND (n.kind != 'note' OR EXISTS (
			SELECT 1 FROM brain_vault_notes o WHERE o.node_id = s.node_id AND o.vault_id != ?))`, id, id)
	if err != nil {
		return err
	}
	var keep []int64
	for rows.Next() {
		var n int64
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		keep = append(keep, n)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	// The note nodes only this vault's rows mark: deleting them takes their
	// edges, other vaults' claims on those edges and the rows with them.
	if _, err := q.ExecContext(ctx, `DELETE FROM brain_nodes WHERE kind = 'note' AND id IN (
			SELECT s.node_id FROM brain_vault_notes s WHERE s.vault_id = ?)
		AND NOT EXISTS (SELECT 1 FROM brain_vault_notes o WHERE o.node_id = brain_nodes.id AND o.vault_id != ?)`, id, id); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM brain_vault_notes WHERE vault_id = ?`, id); err != nil {
		return err
	}
	for _, nodeID := range keep {
		if _, err := SyncBrainNoteNode(ctx, q, nodeID, now); err != nil {
			return err
		}
	}
	if err := CleanBrainVaultEntities(ctx, q, id); err != nil {
		return err
	}
	// What it made that others still use is theirs now.
	if _, err := q.ExecContext(ctx, `UPDATE brain_nodes SET vault_id = (
			SELECT v.vault_id FROM brain_vault_edges v WHERE v.dst = brain_nodes.id OR v.src = brain_nodes.id LIMIT 1)
		WHERE vault_id = ?`, id); err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM brain_vaults WHERE id = ?`, id)
	return err
}

// BrainNodeVaults returns, for each of the nodes that has a note row, the
// name of the vault of its oldest one: the mark a screen draws.
func BrainNodeVaults(ctx context.Context, q Querier, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT s.node_id, v.name FROM brain_vault_notes s JOIN brain_vaults v ON v.id = s.vault_id
		WHERE s.node_id IN (SELECT value FROM json_each(?)) ORDER BY s.id DESC`, idList(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name // descending: the oldest row is written last
	}
	return out, rows.Err()
}

// BrainNoteSourceView is one source of a node read on its own: the vault,
// the file, and that file's own excerpt.
type BrainNoteSourceView struct {
	VaultID int64    `json:"vault_id"`
	Vault   string   `json:"vault"`
	Path    string   `json:"path"`
	Title   string   `json:"title"`
	Aliases []string `json:"aliases,omitempty"`
	Excerpt string   `json:"excerpt"`
	Mtime   int64    `json:"mtime"`
}

// BrainNodeSources returns the note files that are sources of a node,
// oldest first.
func BrainNodeSources(ctx context.Context, q Querier, nodeID int64) ([]BrainNoteSourceView, error) {
	rows, err := q.QueryContext(ctx, `SELECT s.vault_id, v.name, s.path, s.title, s.aliases, s.excerpt, s.mtime
		FROM brain_vault_notes s JOIN brain_vaults v ON v.id = s.vault_id WHERE s.node_id = ? ORDER BY s.id`, nodeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrainNoteSourceView{}
	for rows.Next() {
		var s BrainNoteSourceView
		var aliases string
		if err := rows.Scan(&s.VaultID, &s.Vault, &s.Path, &s.Title, &aliases, &s.Excerpt, &s.Mtime); err != nil {
			return nil, err
		}
		s.Aliases = lines(aliases)
		out = append(out, s)
	}
	return out, rows.Err()
}

// brainAgentsMayRead is the condition a node n must meet to reach an agent:
// it is not a note, or every vault it was imported from lets its notes
// reach agents (ADR-079). Used by the handoff; a server that hands Second
// Brain to agents any other way must use it too.
const brainAgentsMayRead = `(n.kind != 'note' OR NOT EXISTS (SELECT 1 FROM brain_vault_notes s JOIN brain_vaults v ON v.id = s.vault_id
	WHERE s.node_id = n.id AND v.agents = 0))`

// BrainAgentsMayRead is brainAgentsMayRead for code outside the store that
// selects from brain_nodes as n.
const BrainAgentsMayRead = brainAgentsMayRead

// brainEntityHidden is the condition an entity n meets when an import made
// it from a vault whose notes may not reach agents: such a topic's name is
// the user's own tag, so the extraction does not send it.
const brainEntityHidden = `(n.vault_id IS NOT NULL AND EXISTS (SELECT 1 FROM brain_vaults v WHERE v.id = n.vault_id AND v.agents = 0))`

// BrainProjectNames returns the names Caprock knows projects by: the
// projects' own and the sessions' — what a vault's folder is matched
// against.
func BrainProjectNames(ctx context.Context, q Querier) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT name FROM projects WHERE archived_at IS NULL
		UNION SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND project != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// CountBrainNotes is how many note nodes there are.
func CountBrainNotes(ctx context.Context, q Querier) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM brain_nodes WHERE kind = 'note'`).Scan(&n)
	return n, err
}

// preparer is what a statement can be prepared on: *sql.DB and *sql.Tx.
type preparer interface {
	PrepareContext(ctx context.Context, query string) (*sql.Stmt, error)
}

// stmtCache is a Querier that prepares each distinct statement once: a scan
// that runs one INSERT forty thousand times parses it once.
type stmtCache struct {
	p preparer
	m map[string]*sql.Stmt
}

// Prepared wraps q so each distinct statement is prepared once and reused,
// and returns the function that closes them. A q that cannot prepare is
// returned as it is.
func Prepared(q Querier) (Querier, func()) {
	p, ok := q.(preparer)
	if !ok {
		return q, func() {}
	}
	c := &stmtCache{p: p, m: map[string]*sql.Stmt{}}
	return c, func() {
		for _, st := range c.m {
			_ = st.Close()
		}
	}
}

func (c *stmtCache) stmt(ctx context.Context, query string) (*sql.Stmt, error) {
	if st, ok := c.m[query]; ok {
		return st, nil
	}
	st, err := c.p.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	c.m[query] = st
	return st, nil
}

func (c *stmtCache) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	st, err := c.stmt(ctx, query)
	if err != nil {
		return nil, err
	}
	return st.ExecContext(ctx, args...)
}

func (c *stmtCache) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	st, err := c.stmt(ctx, query)
	if err != nil {
		return nil, err
	}
	return st.QueryContext(ctx, args...)
}

func (c *stmtCache) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	st, err := c.stmt(ctx, query)
	if err != nil {
		// A *sql.Row carrying the error: the same statement on the
		// underlying querier fails the same way at Scan.
		return c.p.(Querier).QueryRowContext(ctx, query, args...)
	}
	return st.QueryRowContext(ctx, args...)
}

// brainMCPMayRead excludes a whole node when any source is private, including
// a source attached to an existing memory: search also holds source excerpts.
const brainMCPMayRead = `(NOT EXISTS (SELECT 1 FROM brain_vault_notes s JOIN brain_vaults v ON v.id = s.vault_id
 WHERE s.node_id = n.id AND v.agents = 0) AND NOT ` + brainEntityHidden + `)`

// BrainAgentNodes returns the selected nodes that may reach an MCP client.
func BrainAgentNodes(ctx context.Context, q Querier, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT n.id FROM brain_nodes n WHERE n.id IN (SELECT value FROM json_each(?)) AND `+brainMCPMayRead, idList(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

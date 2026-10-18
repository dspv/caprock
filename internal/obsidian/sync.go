package obsidian

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// Limits on what one vault may make the daemon do (resources are the moat):
// how many notes a vault may hold, how much of one note is read, and how
// often the vaults are looked at without being asked.
const (
	MaxNotes     = 50_000
	MaxNoteBytes = 4 << 20
	// Interval is how often every vault is looked at: a walk that stats each
	// note and reads only the ones whose time or size changed.
	Interval = 10 * time.Minute
	// FirstLook is how long after the daemon starts the first look waits.
	FirstLook = 2 * time.Minute
)

// ErrNotFolder is a vault path that is not a folder on this machine.
var ErrNotFolder = errors.New("not a folder on this computer")

// ErrNotAbsolute is a vault path that is not absolute.
var ErrNotAbsolute = errors.New("the vault's path must be absolute")

// ErrTooMany is a folder with more notes than a vault may hold.
var ErrTooMany = fmt.Errorf("more than %d notes: pick the vault's own folder", MaxNotes)

// Result is what one scan of a vault did.
type Result struct {
	// Notes is how many Markdown notes the vault holds.
	Notes int `json:"notes"`
	// Read is how many were read: new or changed since the last scan.
	Read int `json:"read"`
	// Added, Changed and Removed count note files new to Second Brain,
	// changed, and gone from the vault.
	Added   int `json:"added"`
	Changed int `json:"changed"`
	Removed int `json:"removed"`
	// Merged is how many added notes joined a node that was already there
	// (the same title or alias) instead of making one.
	Merged int `json:"merged"`
	// Links is how many edges the vault's import wants now; Linked and
	// Unlinked how many it added and dropped in this scan.
	Links    int `json:"links"`
	Linked   int `json:"linked"`
	Unlinked int `json:"unlinked"`
	// Skipped is how many notes could not be kept (no title, unreadable).
	Skipped int `json:"skipped"`
	// Ms is how long the scan took.
	Ms int64 `json:"ms"`
	// WriteMs includes acquiring, running and committing the write transaction.
	WriteMs int64 `json:"write_ms"`
}

// Service imports and refreshes vaults: one scan at a time.
type Service struct {
	Store *store.Store
	Log   *slog.Logger
	// Changed is told when a scan changed Second Brain, to publish a frame.
	Changed func(vaultID int64, removed bool)
	Now     func() time.Time
	mu      sync.Mutex
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// CleanPath checks a folder the user picked: absolute, a folder, cleaned.
func CleanPath(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" || !filepath.IsAbs(dir) {
		return "", ErrNotAbsolute
	}
	dir = filepath.Clean(dir)
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return "", ErrNotFolder
	}
	return dir, nil
}

// Add imports a vault: the folder is checked, kept, and scanned at once.
func (s *Service) Add(ctx context.Context, dir string, agents bool) (store.BrainVault, Result, error) {
	dir, err := CleanPath(dir)
	if err != nil {
		return store.BrainVault{}, Result{}, err
	}
	name := filepath.Base(dir)
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := store.InsertBrainVault(ctx, s.Store.DB(), name, dir, agents, s.now().UnixMilli())
	if err != nil {
		return store.BrainVault{}, Result{}, err
	}
	r, err := s.scan(ctx, v, true)
	if v2, gerr := store.GetBrainVault(ctx, s.Store.DB(), v.ID); gerr == nil {
		v = v2
	}
	return v, r, err
}

// Refresh scans one vault again. force rereads every note and resolves every
// link and tag, including edits that kept their previous size and timestamp.
func (s *Service) Refresh(ctx context.Context, id int64, force bool) (store.BrainVault, Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := store.GetBrainVault(ctx, s.Store.DB(), id)
	if err != nil {
		return v, Result{}, err
	}
	r, err := s.scan(ctx, v, force)
	if v2, gerr := store.GetBrainVault(ctx, s.Store.DB(), id); gerr == nil {
		v = v2
	}
	return v, r, err
}

// RefreshAll looks at every vault: a walk, and reads only of what changed.
func (s *Service) RefreshAll(ctx context.Context) {
	vaults, err := store.ListBrainVaults(ctx, s.Store.DB())
	if err != nil {
		s.log().Warn("obsidian: list vaults", "component", "obsidian", "err", err)
		return
	}
	for _, v := range vaults {
		if ctx.Err() != nil {
			return
		}
		if _, _, err := s.Refresh(ctx, v.ID, false); err != nil && ctx.Err() == nil {
			s.log().Warn("obsidian: refresh", "component", "obsidian", "vault", v.ID, "err", err)
		}
	}
}

// Remove takes a vault out of Second Brain.
func (s *Service) Remove(ctx context.Context, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.Store.WithTx(ctx, func(q store.Querier) error {
		return store.RemoveBrainVault(ctx, q, id, s.now().UnixMilli())
	})
	if err == nil && s.Changed != nil {
		s.Changed(id, true)
	}
	return err
}

// SetAgents turns a vault's notes reaching agents on or off.
func (s *Service) SetAgents(ctx context.Context, id int64, on bool) (store.BrainVault, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := store.SetBrainVaultAgents(ctx, s.Store.DB(), id, on); err != nil {
		return store.BrainVault{}, err
	}
	if s.Changed != nil {
		s.Changed(id, false)
	}
	return store.GetBrainVault(ctx, s.Store.DB(), id)
}

// Run looks at every vault FirstLook after it starts and every Interval
// after that, until ctx ends. No file watcher: a walk that stats is cheap
// on a large vault, a watcher per folder is not.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTimer(FirstLook)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s.RefreshAll(ctx)
		t.Reset(Interval)
	}
}

// file is one note on disk.
type file struct {
	rel   string
	mtime int64
	size  int64
}

// Walk lists a vault's Markdown notes: every .md file under root, outside
// folders whose name starts with a dot (.obsidian, .trash, .git) and
// node_modules, not following links. Attachments are never opened.
func Walk(ctx context.Context, root string) ([]file, error) {
	var out []file
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if p == root {
				return err
			}
			return err // keep the previous import if any folder is unreadable
		}
		if p == root && !d.IsDir() {
			return ErrNotFolder
		}
		name := d.Name()
		if d.IsDir() {
			if p != root && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !strings.EqualFold(filepath.Ext(name), ".md") || strings.HasPrefix(name, ".") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		out = append(out, file{rel: filepath.ToSlash(rel), mtime: info.ModTime().UnixMilli(), size: info.Size()})
		if len(out) > MaxNotes {
			return ErrTooMany
		}
		return nil
	})
	return out, err
}

func readNote(root, rel string) ([]byte, error) {
	vault, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer vault.Close()
	f, err := vault.Open(filepath.FromSlash(rel))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, MaxNoteBytes))
}

// keyIndex is which node answers to a normalised title, counted so a note
// row leaving takes its keys with it. The lowest node id wins a tie.
type keyIndex map[string]map[int64]int

func (k keyIndex) add(key string, node int64) {
	if key == "" {
		return
	}
	m := k[key]
	if m == nil {
		m = map[int64]int{}
		k[key] = m
	}
	m[node]++
}

func (k keyIndex) drop(key string, node int64) {
	if m := k[key]; m != nil {
		if m[node]--; m[node] <= 0 {
			delete(m, node)
		}
	}
}

func (k keyIndex) best(key string) int64 {
	var out int64
	for id := range k[key] {
		if out == 0 || id < out {
			out = id
		}
	}
	return out
}

// loadKeys builds the index from what is stored: every vault note row's keys
// and every memory's own title (a note node's title is its row's).
func loadKeys(ctx context.Context, q store.Querier) (keyIndex, error) {
	k := keyIndex{}
	err := store.EachBrainKey(ctx, q, k.add)
	return k, err
}

// match is the node the first of a note's keys that any node answers to
// names, 0 when none does.
func match(k keyIndex, keys []string) int64 {
	for _, key := range keys {
		if id := k.best(key); id > 0 {
			return id
		}
	}
	return 0
}

// keysOf is a note's title and aliases, normalised, without duplicates,
// the title first.
func keysOf(title string, aliases []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range append([]string{title}, aliases...) {
		if k := store.NormTitle(s); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// projectFor is the project a note goes under: the nearest folder on its
// path named like a Caprock project (compared normalised), else the
// Obsidian cluster.
func projectFor(rel string, projects map[string]string) string {
	dir := path.Dir(rel)
	if dir == "." || dir == "/" {
		return store.BrainCluster
	}
	parts := strings.Split(dir, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if name, ok := projects[store.NormTitle(parts[i])]; ok {
			return name
		}
	}
	return store.BrainCluster
}

// scan brings one vault's part of Second Brain up to date with its folder.
// Files whose time and size are unchanged are not opened. A folder that
// cannot be read is recorded as the vault's error and nothing is removed:
// a disk that is not mounted is not a vault emptied.
func (s *Service) scan(ctx context.Context, v store.BrainVault, force bool) (Result, error) {
	start := s.now()
	var r Result
	db := s.Store.DB()
	files, err := Walk(ctx, v.Path)
	elapsed := func() int64 { return s.now().Sub(start).Milliseconds() }
	if err != nil {
		msg := err.Error()
		if errors.Is(err, fs.ErrNotExist) {
			msg = "the folder is not there"
		} else if errors.Is(err, ErrTooMany) {
			msg = ErrTooMany.Error()
		}
		_ = store.RecordBrainVaultScan(ctx, db, v.ID, 0, elapsed(), msg, s.now().UnixMilli())
		return r, fmt.Errorf("%s: %w", v.Path, err)
	}
	r.Notes = len(files)
	rows, err := store.BrainVaultNotes(ctx, db, v.ID)
	if err != nil {
		return r, err
	}
	byPath := make(map[string]store.BrainVaultNote, len(rows))
	for _, row := range rows {
		byPath[row.Path] = row
	}
	// Read what is new or changed, before any transaction: the disk is the
	// slow part and the database is not held while it is read.
	type parsed struct {
		f    file
		note Note
	}
	var changed []parsed
	onDisk := make(map[string]bool, len(files))
	for _, f := range files {
		if ctx.Err() != nil {
			return r, ctx.Err()
		}
		onDisk[f.rel] = true
		if row, ok := byPath[f.rel]; !force && ok && row.Mtime == f.mtime && row.Size == f.size {
			continue
		}
		data, err := readNote(v.Path, f.rel)
		if err != nil {
			r.Skipped++
			continue
		}
		r.Read++
		changed = append(changed, parsed{f: f, note: Parse(f.rel, data)})
	}
	var gone []store.BrainVaultNote
	for _, row := range rows {
		if !onDisk[row.Path] {
			gone = append(gone, row)
		}
	}
	if len(changed) == 0 && len(gone) == 0 && !force {
		r.Ms = elapsed()
		return r, store.RecordBrainVaultScan(ctx, db, v.ID, r.Notes, r.Ms, "", s.now().UnixMilli())
	}
	names, err := store.BrainProjectNames(ctx, db)
	if err != nil {
		return r, err
	}
	projects := make(map[string]string, len(names))
	for _, n := range names {
		if k := store.NormTitle(n); k != "" {
			if _, ok := projects[k]; !ok {
				projects[k] = n
			}
		}
	}
	now := s.now().UnixMilli()
	writeStart := time.Now()
	err = s.Store.WithTx(ctx, func(tx store.Querier) error {
		// Each statement prepared once for the scan: a first import runs the
		// same few thousands of times.
		q, done := store.Prepared(tx)
		defer done()
		keys, err := loadKeys(ctx, q)
		if err != nil {
			return err
		}
		touched := map[int64]bool{}
		detach := func(row store.BrainVaultNote) error {
			if err := store.DeleteBrainVaultNote(ctx, q, row.ID); err != nil {
				return err
			}
			for _, k := range row.Keys {
				keys.drop(k, row.NodeID)
			}
			touched[row.NodeID] = true
			return nil
		}
		for _, row := range gone {
			if err := detach(row); err != nil {
				return err
			}
			r.Removed++
		}
		sort.Slice(changed, func(i, j int) bool { return changed[i].f.rel < changed[j].f.rel })
		for _, c := range changed {
			vn := store.BrainVaultNote{
				VaultID: v.ID, Path: c.f.rel, Title: c.note.Title, Aliases: c.note.Aliases,
				Keys: keysOf(c.note.Title, c.note.Aliases), Links: c.note.Links, Tags: c.note.Tags,
				Project: projectFor(c.f.rel, projects), Excerpt: c.note.Excerpt, Mtime: c.f.mtime, Size: c.f.size,
			}
			if len(vn.Keys) == 0 || store.NormTitle(vn.Title) == "" {
				r.Skipped++
				if row, ok := byPath[c.f.rel]; ok {
					if err := detach(row); err != nil {
						return err
					}
				}
				continue
			}
			if row, ok := byPath[c.f.rel]; ok {
				if row.Title == vn.Title && row.Excerpt == vn.Excerpt && row.Project == vn.Project &&
					row.Mtime == vn.Mtime && row.Size == vn.Size && sameStrings(row.Aliases, vn.Aliases) &&
					sameStrings(row.Keys, vn.Keys) && sameStrings(row.Links, vn.Links) && sameStrings(row.Tags, vn.Tags) {
					continue
				}
				if sameStrings(row.Keys, vn.Keys) {
					vn.ID, vn.NodeID = row.ID, row.NodeID
					if err := store.UpdateBrainVaultNote(ctx, q, vn); err != nil {
						return err
					}
					touched[row.NodeID] = true
					r.Changed++
					continue
				}
				// Its title or aliases changed: it may now be another node.
				if err := detach(row); err != nil {
					return err
				}
				vn.NodeID = match(keys, vn.Keys)
				if vn.NodeID == 0 {
					// Nothing else answers to it: a note node that was its
					// alone stays its, so a pin or a link made by hand keeps.
					sole, err := store.BrainNoteNodeAlone(ctx, q, row.NodeID)
					if err != nil {
						return err
					}
					if sole {
						vn.NodeID = row.NodeID
					}
				}
				if vn.NodeID != row.NodeID {
					if _, err := store.SyncBrainNoteNode(ctx, q, row.NodeID, now); err != nil {
						return err
					}
				}
				r.Changed++
			} else {
				r.Added++
				if vn.NodeID = match(keys, vn.Keys); vn.NodeID > 0 {
					r.Merged++
				}
			}
			fresh := vn.NodeID == 0
			if fresh {
				if vn.NodeID, err = store.InsertBrainNoteNode(ctx, q, v.ID, vn, now); err != nil {
					return err
				}
			}
			if _, err := store.InsertBrainVaultNote(ctx, q, vn); err != nil {
				return err
			}
			for _, k := range vn.Keys {
				keys.add(k, vn.NodeID)
			}
			// A node made just now from this row is already what a sync
			// would make it; one it joined, or kept, is settled below.
			if !fresh {
				touched[vn.NodeID] = true
			}
		}
		// A node that loses its last row goes; its keys left the index with
		// the rows (detach), so no link resolves to it below.
		for id := range touched {
			if _, err := store.SyncBrainNoteNode(ctx, q, id, now); err != nil {
				return err
			}
		}
		return s.link(ctx, q, v.ID, keys, now, &r)
	})
	r.WriteMs = time.Since(writeStart).Milliseconds()
	if err != nil {
		return r, err
	}
	r.Ms = elapsed()
	if err := store.RecordBrainVaultScan(ctx, db, v.ID, r.Notes, r.Ms, "", s.now().UnixMilli()); err != nil {
		return r, err
	}
	if s.Changed != nil && (r.Added+r.Changed+r.Removed+r.Linked+r.Unlinked > 0) {
		s.Changed(v.ID, false)
	}
	return r, nil
}

// link makes the edges a vault's notes ask for and drops the ones they no
// longer do: each note part_of its project and of a topic per tag, and
// relates to every note or memory a [[link]] names.
func (s *Service) link(ctx context.Context, q store.Querier, vaultID int64, keys keyIndex, now int64, r *Result) error {
	rows, err := store.BrainVaultNotes(ctx, q, vaultID)
	if err != nil {
		return err
	}
	want := map[store.BrainClaim]bool{}
	projects := map[string]int64{}
	topics := map[string]int64{}
	for _, row := range rows {
		pid, ok := projects[row.Project]
		if !ok {
			if pid, err = store.EnsureBrainVaultEntity(ctx, q, vaultID, store.BrainProject, row.Project, now); err != nil {
				return err
			}
			projects[row.Project] = pid
		}
		want[store.BrainClaim{Src: row.NodeID, Dst: pid, Kind: store.EdgePartOf}] = true
		for _, tag := range row.Tags {
			key := strings.ToLower(tag)
			tid, ok := topics[key]
			if !ok {
				if tid, err = topicFor(ctx, q, vaultID, tag, now); err != nil {
					return err
				}
				topics[key] = tid
			}
			if tid > 0 {
				want[store.BrainClaim{Src: row.NodeID, Dst: tid, Kind: store.EdgePartOf}] = true
			}
		}
		for _, l := range row.Links {
			if to := keys.best(store.NormTitle(l)); to > 0 && to != row.NodeID {
				want[store.BrainClaim{Src: row.NodeID, Dst: to, Kind: store.EdgeRelates}] = true
			}
		}
	}
	have, err := store.BrainVaultClaims(ctx, q, vaultID)
	if err != nil {
		return err
	}
	var add []store.BrainClaim
	for c := range want {
		if _, ok := have[c]; !ok {
			add = append(add, c)
		}
	}
	drop := map[store.BrainClaim]bool{}
	for c, pre := range have {
		if !want[c] {
			drop[c] = pre
		}
	}
	if err := store.ReleaseBrainEdges(ctx, q, vaultID, drop); err != nil {
		return err
	}
	if err := store.ClaimBrainEdges(ctx, q, vaultID, add, now); err != nil {
		return err
	}
	r.Linked, r.Unlinked, r.Links = len(add), len(drop), len(want)
	return store.CleanBrainVaultEntities(ctx, q, vaultID)
}

// topicFor is the topic a #tag joins: one Second Brain already has under the
// tag's name, or under it with - and _ read as spaces ("machine-learning"
// joins "machine learning"); else a new topic named as the tag is written.
func topicFor(ctx context.Context, q store.Querier, vaultID int64, tag string, now int64) (int64, error) {
	spaced := strings.NewReplacer("-", " ", "_", " ").Replace(tag)
	for _, t := range []string{tag, spaced} {
		id, err := store.BrainEntityByNorm(ctx, q, store.BrainTopic, store.NormTitle(t))
		if err != nil || id > 0 {
			return id, err
		}
	}
	if store.NormTitle(tag) == "" {
		return 0, nil
	}
	return store.EnsureBrainVaultEntity(ctx, q, vaultID, store.BrainTopic, tag, now)
}

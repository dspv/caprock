package store

import (
	"context"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Second Brain's search (migration 0056; 03-contracts.md § Second Brain).
//
// Every node carries `search`: its title, summary and project folded the
// same way a query is (FoldSearch), so matching any script in any case, with
// or without accents, is a plain substring test. A query is split into
// words, and every word has to match — in the title, the summary, the
// project, or the name of a topic, person or project the memory is linked
// to. When that finds few memories, words of four letters or more may also
// match a word one or two edits away (a typo, or a different ending), and
// those memories are said to be close matches. Each memory gets a rank:
// title hits above summary hits above close matches.

// metaBrainSearchFold is the FoldSearch version the search column was last
// written with. Changing brainSearchFold re-folds every node on the next
// open, so a change to the folding reaches rows written before it.
const (
	metaBrainSearchFold = "brain_search_fold"
	brainSearchFold     = "1"
)

// FoldSearch folds text for matching: compatibility-decomposed (NFKD, so a
// full-width "Ａ" is "a" and "ﬁ" is "fi"), the combining diacritics of
// U+0300–U+036F dropped (é is e, ü is u, ά is α), lower-cased by Unicode's
// rules, and the final sigma made the ordinary one. Other marks stay — a
// Japanese voicing mark is a different letter, not an accent. The screen's
// highlighting folds the same way (ui/src/lib/brainsearch.ts).
func FoldSearch(s string) string {
	s = norm.NFKD.String(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 0x300 && r <= 0x36f {
			continue
		}
		r = unicode.ToLower(r)
		if r == 'ς' {
			r = 'σ'
		}
		b.WriteRune(r)
	}
	return b.String()
}

// foldLine folds text and collapses its whitespace to single spaces.
func foldLine(s string) string {
	return strings.Join(strings.Fields(FoldSearch(s)), " ")
}

// BrainSearchDoc is what brain_nodes.search holds for a node: its folded
// title, summary and project, one per line, the title first.
func BrainSearchDoc(title, summary, project string) string {
	return foldLine(title) + "\n" + foldLine(summary) + "\n" + foldLine(project)
}

// isWordRune reports whether r belongs to a word: a letter, digit or mark.
// ASCII and folded (lower-case) Greek and Cyrillic are decided without a
// table lookup.
func isWordRune(r rune) bool {
	if r < utf8.RuneSelf {
		return 'a' <= r && r <= 'z' || '0' <= r && r <= '9' || 'A' <= r && r <= 'Z'
	}
	return 0x3b1 <= r && r <= 0x3c9 || 0x430 <= r && r <= 0x45f ||
		unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r)
}

// eachToken calls fn with each word of folded text, until fn returns false.
func eachToken(s string, fn func(string) bool) {
	start := -1
	for i := 0; i < len(s); {
		r, size := rune(s[i]), 1
		if r >= utf8.RuneSelf {
			r, size = utf8.DecodeRuneInString(s[i:])
		}
		if isWordRune(r) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			if !fn(s[start:i]) {
				return
			}
			start = -1
		}
		i += size
	}
	if start >= 0 {
		fn(s[start:])
	}
}

// brainQueryWordsMax caps the words of one query.
const brainQueryWordsMax = 8

// brainQueryWords folds a query and splits it at whitespace, each word once.
// Punctuation stays part of a word, so "100%" is looked for as written.
func brainQueryWords(q string) []string {
	var out []string
	for _, w := range strings.Fields(FoldSearch(q)) {
		if !slices.Contains(out, w) {
			out = append(out, w)
		}
		if len(out) == brainQueryWordsMax {
			break
		}
	}
	return out
}

// brainMaxEdits is how many edits a word may be from a close match: one for
// a word of four to seven letters, two for a longer one, none for a shorter
// one or one with anything but letters and digits in it.
func brainMaxEdits(w string) int {
	for _, r := range w {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.IsMark(r) {
			return 0
		}
	}
	switch n := utf8.RuneCountInString(w); {
	case n >= 8:
		return 2
	case n >= 4:
		return 1
	}
	return 0
}

// Rank points one word earns, by where it matched. A memory's rank is the
// sum over the query's words.
const (
	brainRankTitleWord   = 40 // a word of the title is the word
	brainRankTitlePrefix = 30 // a word of the title starts with it
	brainRankTitleIn     = 25 // inside the title elsewhere
	brainRankSummary     = 20 // in the summary or the project
	brainRankLinked      = 15 // in a linked topic's, person's or project's name
	brainRankCloseTitle  = 10 // a close match in the title
	brainRankClose       = 5  // a close match anywhere else
)

// Bounds on the close-match pass, which runs only when the exact one finds
// fewer than brainFewHits memories. It reads at most brainCloseScan of the
// newest memories that pass the other filters and compares each word with
// at most brainCloseVocab distinct words of theirs, so a large brain costs
// a bounded amount.
const (
	brainFewHits    = 5
	brainCloseScan  = 20000
	brainCloseVocab = 50000
	brainTermsMax   = 32
	// brainTokenRunesMax: a longer "word" (a hash, a path run together) is
	// never compared for a close match.
	brainTokenRunesMax = 40
)

// brainHit is one memory that matched, with its rank.
type brainHit struct {
	id      int64
	rank    int
	close   bool
	pinned  bool
	created int64
}

// brainMatcher scores a memory's search document against the query's words.
type brainMatcher struct {
	words []string
	// linked[i] holds the memories linked to an entity whose name contains
	// word i; closeLinked[i] those linked to one with a close match of it.
	linked, closeLinked []map[int64]bool
	// edits[i] is how far a close match of word i may be; nil outside the
	// close pass.
	edits []int
	runes [][]rune
	// pieces[i] are the pieces of word i that nearIn looks for.
	pieces [][]string
	// seen[i] remembers, for each distinct word compared with word i,
	// whether it is close, so each is compared once per search.
	seen []map[string]bool
	// compared counts the comparisons, against brainCloseVocab.
	compared int
	ed       editDistance
	// used collects the close words that made a match, for highlighting.
	used map[string]bool
}

// isNear reports whether token t is a close match of word i.
func (m *brainMatcher) isNear(i int, t string) bool {
	if v, ok := m.seen[i][t]; ok {
		return v
	}
	if m.compared >= brainCloseVocab {
		return false
	}
	m.compared++
	v := t != m.words[i] && len(t) >= 3 && m.ed.close(m.runes[i], t, m.edits[i])
	m.seen[i][t] = v
	return v
}

// nearIn returns a word of s that is a close match of word i.
//
// Only the words around a piece of word i are compared: a word within d
// edits of it keeps at least one of d+1 pieces whole, and the pieces of a
// second cut, one letter later, keep that true of a swap of two letters
// that straddles the first cut. strings.Index finds pieces far faster than
// splitting every memory into words.
func (m *brainMatcher) nearIn(i int, s string) (string, bool) {
	for _, p := range m.pieces[i] {
		for from := 0; from < len(s); {
			j := strings.Index(s[from:], p)
			if j < 0 {
				break
			}
			j += from
			a, b := tokenAround(s, j, j+len(p))
			if t := s[a:b]; m.isNear(i, t) {
				return t, true
			}
			from = b
		}
	}
	return "", false
}

// tokenAround widens s[a:b] to the whole word around it.
func tokenAround(s string, a, b int) (int, int) {
	for a > 0 {
		r, n := utf8.DecodeLastRuneInString(s[:a])
		if !isWordRune(r) {
			break
		}
		a -= n
	}
	for b < len(s) {
		r, n := utf8.DecodeRuneInString(s[b:])
		if !isWordRune(r) {
			break
		}
		b += n
	}
	return a, b
}

// brainPieces cuts a word into d+1 nearly equal pieces, and again with
// each cut one letter later, for nearIn. A piece of one letter would match
// nearly everything; where the second cut would make one (a word of four
// letters), the word with each pair of neighbours swapped stands in for it,
// which finds the one swap a single edit allows.
func brainPieces(w []rune, d int) []string {
	var out []string
	add := func(p string) {
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	for shift := 0; shift <= 1; shift++ {
		start := 0
		for k := 1; k <= d+1; k++ {
			end := len(w)
			if k <= d {
				end = k*len(w)/(d+1) + shift
			}
			if end-start >= 2 {
				add(string(w[start:end]))
			} else if d == 1 {
				v := slices.Clone(w)
				for j := 0; j+1 < len(v); j++ {
					v[j], v[j+1] = v[j+1], v[j]
					add(string(v))
					v[j], v[j+1] = v[j+1], v[j]
				}
			}
			start = end
		}
	}
	return out
}

// score ranks one document; ok is false when some word does not match.
func (m *brainMatcher) score(id int64, doc string) (rank int, isClose, ok bool) {
	title, rest, _ := strings.Cut(doc, "\n")
	for i, w := range m.words {
		s := 0
		switch {
		case strings.Contains(title, w):
			s = brainRankTitleIn
			eachToken(title, func(t string) bool {
				if t == w {
					s = brainRankTitleWord
					return false
				}
				if strings.HasPrefix(t, w) {
					s = brainRankTitlePrefix
				}
				return true
			})
		case strings.Contains(rest, w):
			s = brainRankSummary
		case m.linked[i][id]:
			s = brainRankLinked
		case m.edits != nil && m.edits[i] > 0:
			if t, hit := m.nearIn(i, title); hit {
				s = brainRankCloseTitle
				m.used[t] = true
			} else if t, hit := m.nearIn(i, rest); hit {
				s = brainRankClose
				m.used[t] = true
			} else if m.closeLinked[i][id] {
				s = brainRankClose
			}
			isClose = s > 0
		}
		if s == 0 {
			return 0, false, false
		}
		rank += s
	}
	return rank, isClose, true
}

// brainEntityDoc is an entity's id and folded name.
type brainEntityDoc struct {
	id   int64
	name string
}

func brainEntityDocs(ctx context.Context, q Querier) ([]brainEntityDoc, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, search FROM brain_nodes WHERE kind IN ('topic','person','project')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []brainEntityDoc
	for rows.Next() {
		var e brainEntityDoc
		if err := rows.Scan(&e.id, &e.name); err != nil {
			return nil, err
		}
		e.name, _, _ = strings.Cut(e.name, "\n")
		out = append(out, e)
	}
	return out, rows.Err()
}

// brainLinkedTo returns, per word, the nodes linked to the entities picked
// for it, with one read of the edges.
func brainLinkedTo(ctx context.Context, q Querier, picked []map[int64]bool) ([]map[int64]bool, error) {
	out := make([]map[int64]bool, len(picked))
	all := map[int64]bool{}
	for _, set := range picked {
		for id := range set {
			all[id] = true
		}
	}
	if len(all) == 0 {
		return out, nil
	}
	ids := make([]int64, 0, len(all))
	for id := range all {
		ids = append(ids, id)
	}
	list := idList(ids)
	rows, err := q.QueryContext(ctx, `
		SELECT e.src, e.dst FROM brain_edges e WHERE e.src IN (SELECT value FROM json_each(?))
		UNION
		SELECT e.src, e.dst FROM brain_edges e WHERE e.dst IN (SELECT value FROM json_each(?))`, list, list)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	add := func(i int, id int64) {
		if out[i] == nil {
			out[i] = map[int64]bool{}
		}
		out[i][id] = true
	}
	for rows.Next() {
		var a, b int64
		if err := rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		for i, set := range picked {
			if set[a] {
				add(i, b)
			}
			if set[b] {
				add(i, a)
			}
		}
	}
	return out, rows.Err()
}

// searchBrain finds the memories that pass cond (the graph read's other
// filters, over brain_nodes n) and match the query, with the words to
// highlight: the query's own and the close words that matched.
func searchBrain(ctx context.Context, q Querier, cond string, args []any, query string) ([]brainHit, []string, error) {
	words := brainQueryWords(query)
	if len(words) == 0 {
		return nil, nil, nil
	}
	ents, err := brainEntityDocs(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	picked := make([]map[int64]bool, len(words))
	for i, w := range words {
		for _, e := range ents {
			if strings.Contains(e.name, w) {
				if picked[i] == nil {
					picked[i] = map[int64]bool{}
				}
				picked[i][e.id] = true
			}
		}
	}
	m := &brainMatcher{words: words, used: map[string]bool{}}
	if m.linked, err = brainLinkedTo(ctx, q, picked); err != nil {
		return nil, nil, err
	}

	// One read of the memories that pass the other filters, newest first;
	// the matching is Go's. Narrowing in SQL measured slower: LIKE's and
	// instr's byte loops lose to strings.Contains, and every row's page is
	// read either way.
	rows, err := q.QueryContext(ctx, `SELECT n.id, n.search, n.pinned, n.created_at FROM brain_nodes n WHERE `+cond+`
		ORDER BY n.id DESC`, args...)
	if err != nil {
		return nil, nil, err
	}
	var hits []brainHit
	var rest []brainCand
	for rows.Next() {
		var c brainCand
		if err := rows.Scan(&c.hit.id, &c.doc, &c.hit.pinned, &c.hit.created); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if rank, _, ok := m.score(c.hit.id, c.doc); ok {
			c.hit.rank = rank
			hits = append(hits, c.hit)
		} else if len(rest) < brainCloseScan {
			rest = append(rest, c)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	terms := slices.Clone(words)
	if len(hits) >= brainFewHits {
		return hits, terms, nil
	}

	// The close pass: few exact hits, so look in the rest for words a typo
	// or an ending away. Each distinct word of theirs is compared once.
	m.edits = make([]int, len(words))
	m.runes = make([][]rune, len(words))
	m.seen = make([]map[string]bool, len(words))
	m.pieces = make([][]string, len(words))
	anyEligible := false
	for i, w := range words {
		m.edits[i] = brainMaxEdits(w)
		m.runes[i] = []rune(w)
		m.pieces[i] = brainPieces(m.runes[i], m.edits[i])
		m.seen[i] = map[string]bool{}
		anyEligible = anyEligible || m.edits[i] > 0
	}
	if !anyEligible {
		return hits, terms, nil
	}
	closePicked := make([]map[int64]bool, len(words))
	for i := range words {
		if m.edits[i] == 0 {
			continue
		}
		for _, e := range ents {
			if _, hit := m.nearIn(i, e.name); hit {
				if closePicked[i] == nil {
					closePicked[i] = map[int64]bool{}
				}
				closePicked[i][e.id] = true
			}
		}
	}
	if m.closeLinked, err = brainLinkedTo(ctx, q, closePicked); err != nil {
		return nil, nil, err
	}
	for _, c := range rest {
		if rank, isClose, ok := m.score(c.hit.id, c.doc); ok {
			c.hit.rank, c.hit.close = rank, isClose
			hits = append(hits, c.hit)
		}
	}
	extra := make([]string, 0, len(m.used))
	for t := range m.used {
		extra = append(extra, t)
	}
	slices.Sort(extra)
	terms = append(terms, extra[:min(len(extra), brainTermsMax-len(terms))]...)
	return hits, terms, nil
}

// brainCand is a memory the exact pass did not match, kept for the close one.
type brainCand struct {
	hit brainHit
	doc string
}

// sortBrainHits orders hits best first: rank, then pinned, then newest.
func sortBrainHits(hits []brainHit) {
	slices.SortFunc(hits, func(a, b brainHit) int {
		switch {
		case a.rank != b.rank:
			return b.rank - a.rank
		case a.pinned != b.pinned:
			if a.pinned {
				return -1
			}
			return 1
		case a.created != b.created:
			if a.created > b.created {
				return -1
			}
			return 1
		case a.id > b.id:
			return -1
		case a.id < b.id:
			return 1
		}
		return 0
	})
}

// editDistance holds the rows of the optimal-string-alignment distance
// (Levenshtein plus swapping two neighbours), reused between comparisons.
type editDistance struct {
	r0, r1, r2 []int
	tr         []rune
}

// close reports whether token t is within d edits of word w, or — for a word
// of five letters or more — begins with something that is, so "decisiom"
// finds "decisions" and a different ending of a word is found too.
func (e *editDistance) close(w []rune, t string, d int) bool {
	n := utf8.RuneCountInString(t)
	if n > brainTokenRunesMax || n < len(w)-d {
		return false
	}
	e.tr = append(e.tr[:0], []rune(t)...)
	if n <= len(w)+d && e.within(w, e.tr, d) {
		return true
	}
	if len(w) < 5 || n <= len(w)-d {
		return false
	}
	for k := len(w) - d; k <= len(w)+d && k < n; k++ {
		if e.within(w, e.tr[:k], d) {
			return true
		}
	}
	return false
}

// within reports whether a and b are at most d edits apart, giving up as
// soon as a whole row exceeds d.
func (e *editDistance) within(a, b []rune, d int) bool {
	if abs(len(a)-len(b)) > d {
		return false
	}
	n := len(b) + 1
	if cap(e.r0) < n {
		e.r0, e.r1, e.r2 = make([]int, n), make([]int, n), make([]int, n)
	}
	prev2, prev, cur := e.r2[:n], e.r0[:n], e.r1[:n]
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		low := cur[0]
		for j := 1; j < n; j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			v := min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				v = min(v, prev2[j-2]+1)
			}
			cur[j] = v
			low = min(low, v)
		}
		if low > d {
			return false
		}
		prev2, prev, cur = prev, cur, prev2
	}
	return prev[n-1] <= d
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// backfillBrainSearch fills brain_nodes.search (migration 0056) for the
// nodes written before it, and re-folds every node when the folding has
// changed (metaBrainSearchFold). Otherwise it reads only rows with an empty
// search — none, once filled, since every insert and update writes it — which
// costs one scan of a small table.
func (s *Store) backfillBrainSearch(ctx context.Context) error {
	query := `SELECT id, title, summary, project FROM brain_nodes WHERE search = ''`
	refold := false
	if v, err := s.GetMeta(ctx, metaBrainSearchFold); err != nil || v != brainSearchFold {
		query = `SELECT id, title, summary, project FROM brain_nodes`
		refold = true
	}
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	type row struct {
		id  int64
		doc string
	}
	var pending []row
	for rows.Next() {
		var id int64
		var title, summary, project string
		if err := rows.Scan(&id, &title, &summary, &project); err != nil {
			_ = rows.Close()
			return err
		}
		pending = append(pending, row{id, BrainSearchDoc(title, summary, project)})
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(pending) > 0 {
		err := s.WithTx(ctx, func(q Querier) error {
			for _, r := range pending {
				if _, err := q.ExecContext(ctx, `UPDATE brain_nodes SET search = ? WHERE id = ?`, r.doc, r.id); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if refold {
		return s.SetMeta(ctx, metaBrainSearchFold, brainSearchFold)
	}
	return nil
}

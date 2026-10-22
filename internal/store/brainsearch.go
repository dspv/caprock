package store

import (
	"context"
	"math"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Second Brain's search (migration 0056; 03-contracts.md § Second Brain).
//
// Every node carries `search`: its title, summary, project and keywords
// (migration 0069) folded the same way a query is (FoldSearch), one per
// line, so matching any script in any case, with or without accents, is a
// string test. A query is split into words at anything that is not a letter,
// digit or mark; a word and its synonyms (brainSynonyms) make a term. A
// memory matches when any term is a whole word of its title, keywords,
// summary or project, or of the name of a topic, person or project it is
// linked to; a term of four letters or more may also be the start of a
// longer word ("router" finds "routers"). Each term weighs by how rare it is
// among the memories searched (an IDF), times where it matched: title and
// keywords above summary and project above a linked name. When that finds
// few memories, words of four letters or more may also match a word one or
// two edits away (a typo, or a different ending), and those memories are
// said to be close matches. A superseded memory comes after every current
// one (ReadBrainGraph).

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
// title, summary and project, one per line, the title first, and its
// keywords on a fourth line when it has any.
func BrainSearchDoc(title, summary, project string, keywords ...string) string {
	doc := foldLine(title) + "\n" + foldLine(summary) + "\n" + foldLine(project)
	if len(keywords) > 0 {
		doc += "\n" + foldLine(strings.Join(keywords, ", "))
	}
	return doc
}

// brainDocFields splits a search document into its title and keywords (the
// heavy fields) and its summary and project.
func brainDocFields(doc string) (heavy, light [2]string) {
	parts := strings.SplitN(doc, "\n", 4)
	for len(parts) < 4 {
		parts = append(parts, "")
	}
	return [2]string{parts[0], parts[3]}, [2]string{parts[1], parts[2]}
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

// brainSynonyms are the words a search treats as one, folded. A query word
// or two-word phrase in a set looks for every member of it.
var brainSynonyms = [][]string{
	{"pr", "prs", "pull request", "pull requests"},
	{"cost", "costs", "price", "prices", "pricing", "spend", "spending"},
	{"decision", "decisions", "rule", "rules"},
}

// brainSynonymsOf returns the set a folded word or phrase belongs to.
func brainSynonymsOf(w string) []string {
	for _, set := range brainSynonyms {
		if slices.Contains(set, w) {
			return set
		}
	}
	return nil
}

// brainTerm is one thing a query looks for: its own word (or two-word
// phrase), folded, and that with its synonyms.
type brainTerm struct {
	word string
	alts []string
}

// brainQueryTerms folds a query, splits it into words at anything that is
// not a letter, digit or mark, and makes each word — or two neighbouring
// words that are a phrase of brainSynonyms — a term, each once. A
// whitespace-separated piece that is several words joined by punctuation
// ("read-only", "project-3") is a term of its own too, first, so a memory
// with the whole of it ranks above one with only a part.
func brainQueryTerms(q string) []brainTerm {
	var words, joined []string
	for _, f := range strings.Fields(FoldSearch(q)) {
		n := 0
		eachToken(f, func(t string) bool {
			if len(words) < 2*brainQueryWordsMax {
				words = append(words, t)
			}
			n++
			return true
		})
		if n > 1 {
			if j := strings.TrimFunc(f, func(r rune) bool { return !isWordRune(r) }); j != "" {
				joined = append(joined, j)
			}
		}
	}
	allStop := true
	for _, w := range words {
		allStop = allStop && brainStopwords[w]
	}
	var out []brainTerm
	add := func(w string, alts []string) {
		for _, t := range out {
			if t.word == w {
				return
			}
		}
		if alts == nil {
			alts = []string{w}
		} else if alts[0] != w {
			alts = append([]string{w}, slices.DeleteFunc(slices.Clone(alts), func(a string) bool { return a == w })...)
		}
		out = append(out, brainTerm{word: w, alts: alts})
	}
	for _, j := range joined {
		if len(out) < brainQueryWordsMax/2 {
			add(j, nil)
		}
	}
	for i := 0; i < len(words) && len(out) < brainQueryWordsMax; i++ {
		if i+1 < len(words) {
			if set := brainSynonymsOf(words[i] + " " + words[i+1]); set != nil {
				add(words[i]+" "+words[i+1], set)
				i++
				continue
			}
		}
		if brainStopwords[words[i]] && !allStop {
			continue
		}
		add(words[i], brainSynonymsOf(words[i]))
	}
	return out
}

// brainStopwords are English words too common to say what a query is about
// ("cost per pull request", "no account no cloud"). They are left out of a
// query that has any other word.
var brainStopwords = map[string]bool{
	"a": true, "an": true, "the": true, "and": true, "or": true, "of": true, "to": true, "in": true,
	"on": true, "at": true, "by": true, "for": true, "per": true, "as": true, "is": true, "are": true,
	"was": true, "be": true, "it": true, "its": true, "this": true, "that": true, "with": true,
	"no": true, "not": true, "from": true, "what": true, "how": true, "why": true, "we": true, "do": true,
}

// brainSynonymWeight is what a synonym's match weighs against the query's
// own word: "cost" is found as "spend", a little below "cost" itself.
const brainSynonymWeight = 0.9

// noWordBreaks reports whether w is in a script written without spaces
// (Han, Hiragana, Katakana, Thai and the like), where a whole word cannot be
// told from its neighbours, so a substring is the match.
func noWordBreaks(w string) bool {
	for _, r := range w {
		if r >= 0x2e80 && (unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
			unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Thai, r) || unicode.Is(unicode.Lao, r) ||
			unicode.Is(unicode.Khmer, r) || unicode.Is(unicode.Myanmar, r)) {
			return true
		}
	}
	return false
}

// brainPrefixRunes is the shortest term that may match the start of a
// longer word: "router" finds "routers", while "pr" never finds "project".
const brainPrefixRunes = 4

// Match strengths of wordIn.
const (
	matchNone   = 0
	matchPrefix = 1
	matchWhole  = 2
)

// wordIn reports how w occurs in s, both folded: as a whole word, as the
// start of a longer word (only for a term of brainPrefixRunes or more), or
// not at all. A word is bounded by anything that is not a letter, digit or
// mark (isWordRune), so "pr" is not in "project" but is in "the pr, merged".
func wordIn(s, w string) int {
	if w == "" {
		return matchNone
	}
	if noWordBreaks(w) {
		if strings.Contains(s, w) {
			return matchWhole
		}
		return matchNone
	}
	prefixOK := utf8.RuneCountInString(w) >= brainPrefixRunes
	best := matchNone
	for from := 0; from < len(s); {
		j := strings.Index(s[from:], w)
		if j < 0 {
			break
		}
		j += from
		startOK := true
		if j > 0 {
			r, _ := utf8.DecodeLastRuneInString(s[:j])
			startOK = !isWordRune(r)
		}
		if startOK {
			end := j + len(w)
			endOK := true
			if end < len(s) {
				r, _ := utf8.DecodeRuneInString(s[end:])
				endOK = !isWordRune(r)
			}
			if endOK {
				return matchWhole
			}
			if prefixOK {
				best = matchPrefix
			}
		}
		from = j + 1
	}
	return best
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

// What one term weighs by where it matched; times the term's IDF, summed
// over the terms, times 100, is a memory's rank.
const (
	brainWeightTitle         = 3.0 // a whole word of the title or the keywords
	brainWeightTitlePrefix   = 2.0 // the start of a word there
	brainWeightSummary       = 1.0 // a whole word of the summary or the project
	brainWeightSummaryPrefix = 0.7 // the start of a word there
	brainWeightLinked        = 0.8 // in a linked topic's, person's or project's name
	brainWeightCloseTitle    = 0.6 // a close match in the title or the keywords
	brainWeightClose         = 0.3 // a close match anywhere else
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
	id         int64
	rank       int
	close      bool
	pinned     bool
	superseded bool
	created    int64
	// levels is what each term weighed where it matched, before its IDF.
	levels []float64
}

// brainMatcher scores a memory's search document against the query's terms.
type brainMatcher struct {
	terms []brainTerm
	// words are the terms' own words, for the close pass.
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

// match weighs each term where it matches a document exactly, best place
// first; ok is false when no term matches.
func (m *brainMatcher) match(id int64, doc string) (levels []float64, ok bool) {
	heavy, light := brainDocFields(doc)
	for i, t := range m.terms {
		best := 0.0
		for k, a := range t.alts {
			f := 1.0
			if k > 0 {
				f = brainSynonymWeight
			}
			for _, field := range heavy {
				switch wordIn(field, a) {
				case matchWhole:
					best = max(best, f*brainWeightTitle)
				case matchPrefix:
					best = max(best, f*brainWeightTitlePrefix)
				}
			}
			if best >= brainWeightTitle {
				break
			}
			for _, field := range light {
				switch wordIn(field, a) {
				case matchWhole:
					best = max(best, f*brainWeightSummary)
				case matchPrefix:
					best = max(best, f*brainWeightSummaryPrefix)
				}
			}
		}
		if best == 0 && m.linked[i][id] {
			best = brainWeightLinked
		}
		if best > 0 {
			if levels == nil {
				levels = make([]float64, len(m.terms))
			}
			levels[i] = best
		}
	}
	return levels, levels != nil
}

// matchClose weighs, for a document no term matched exactly, each term of
// four letters or more by a close match of its own word.
func (m *brainMatcher) matchClose(id int64, doc string) (levels []float64, ok bool) {
	heavy, light := brainDocFields(doc)
	for i := range m.terms {
		if m.edits[i] == 0 {
			continue
		}
		s := 0.0
		if t, hit := m.nearIn(i, heavy[0]+"\n"+heavy[1]); hit {
			s = brainWeightCloseTitle
			m.used[t] = true
		} else if t, hit := m.nearIn(i, light[0]+"\n"+light[1]); hit {
			s = brainWeightClose
			m.used[t] = true
		} else if m.closeLinked[i][id] {
			s = brainWeightClose
		}
		if s > 0 {
			if levels == nil {
				levels = make([]float64, len(m.terms))
			}
			levels[i] = s
		}
	}
	return levels, levels != nil
}

// brainEntityDoc is an entity's id and folded name.
type brainEntityDoc struct {
	id   int64
	name string
}

func brainEntityDocs(ctx context.Context, q Querier, agents bool) ([]brainEntityDoc, error) {
	cond := ""
	if agents {
		cond = " AND " + brainMCPMayRead
	}
	rows, err := q.QueryContext(ctx, `SELECT id, search FROM brain_nodes n WHERE kind IN ('topic','person','project')`+cond)
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
// filters, over brain_nodes n) and match the query, each with its rank,
// and the words to highlight: the query's own, their synonyms and the close
// words that matched.
func searchBrain(ctx context.Context, q Querier, cond string, args []any, query string, agents bool) ([]brainHit, []string, error) {
	terms := brainQueryTerms(query)
	if len(terms) == 0 {
		return nil, nil, nil
	}
	words := make([]string, len(terms))
	for i, t := range terms {
		words[i] = t.word
	}
	ents, err := brainEntityDocs(ctx, q, agents)
	if err != nil {
		return nil, nil, err
	}
	picked := make([]map[int64]bool, len(terms))
	for i, t := range terms {
		for _, e := range ents {
			for _, a := range t.alts {
				if wordIn(e.name, a) != matchNone {
					if picked[i] == nil {
						picked[i] = map[int64]bool{}
					}
					picked[i][e.id] = true
					break
				}
			}
		}
	}
	m := &brainMatcher{terms: terms, words: words, used: map[string]bool{}}
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
	var hitDocs []string
	var rest []brainCand
	searched := 0
	for rows.Next() {
		var c brainCand
		if err := rows.Scan(&c.hit.id, &c.doc, &c.hit.pinned, &c.hit.created); err != nil {
			rows.Close()
			return nil, nil, err
		}
		searched++
		if levels, ok := m.match(c.hit.id, c.doc); ok {
			c.hit.levels = levels
			hits = append(hits, c.hit)
			hitDocs = append(hitDocs, c.doc)
		} else if len(rest) < brainCloseScan {
			rest = append(rest, c)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	// Each term's IDF over the memories searched: a word most memories have
	// ("project") weighs little, a rare one ("hero") much.
	idf := make([]float64, len(terms))
	for i := range terms {
		df := 0
		for _, h := range hits {
			if h.levels[i] > 0 {
				df++
			}
		}
		idf[i] = math.Log(1 + float64(max(searched, 1))/float64(max(df, 1)))
	}
	rank := func(levels []float64) int {
		s := 0.0
		for i, l := range levels {
			s += l * idf[i]
		}
		return int(math.Round(s * 100))
	}
	for i := range hits {
		hits[i].rank = rank(hits[i].levels)
	}
	var marks []string
	for _, t := range terms {
		for _, a := range t.alts {
			if !slices.Contains(marks, a) && len(marks) < brainTermsMax {
				marks = append(marks, a)
			}
		}
	}
	if len(hits) >= brainFewHits {
		return hits, marks, nil
	}

	// The close pass: few exact hits, so look in the rest for words a typo
	// or an ending away. Each distinct word of theirs is compared once.
	m.edits = make([]int, len(words))
	m.runes = make([][]rune, len(words))
	m.seen = make([]map[string]bool, len(words))
	m.pieces = make([][]string, len(words))
	anyEligible := false
	for i, w := range words {
		if !strings.Contains(w, " ") {
			m.edits[i] = brainMaxEdits(w)
		}
		m.runes[i] = []rune(w)
		m.pieces[i] = brainPieces(m.runes[i], m.edits[i])
		m.seen[i] = map[string]bool{}
		anyEligible = anyEligible || m.edits[i] > 0
	}
	if !anyEligible {
		return hits, marks, nil
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
	// A memory that matched some terms exactly may match the others close:
	// "sqlite postgers" finds the memory about both.
	for k := range hits {
		need := false
		for i, l := range hits[k].levels {
			need = need || (l == 0 && m.edits[i] > 0)
		}
		if !need {
			continue
		}
		levels, ok := m.matchClose(hits[k].id, hitDocs[k])
		if !ok {
			continue
		}
		for i, l := range levels {
			if l > 0 && hits[k].levels[i] == 0 {
				hits[k].levels[i] = l
				hits[k].close = true
			}
		}
		hits[k].rank = rank(hits[k].levels)
	}
	for _, c := range rest {
		if levels, ok := m.matchClose(c.hit.id, c.doc); ok {
			c.hit.levels, c.hit.close = levels, true
			c.hit.rank = rank(levels)
			hits = append(hits, c.hit)
		}
	}
	extra := make([]string, 0, len(m.used))
	for t := range m.used {
		if !slices.Contains(marks, t) {
			extra = append(extra, t)
		}
	}
	slices.Sort(extra)
	marks = append(marks, extra[:max(0, min(len(extra), brainTermsMax-len(marks)))]...)
	return hits, marks, nil
}

// markSuperseded sets superseded on the hits a supersedes edge points at.
func markSuperseded(ctx context.Context, q Querier, hits []brainHit) error {
	if len(hits) == 0 {
		return nil
	}
	ids := make([]int64, len(hits))
	for i, h := range hits {
		ids[i] = h.id
	}
	got, err := brainSupersededBy(ctx, q, ids)
	if err != nil {
		return err
	}
	for i := range hits {
		hits[i].superseded = got[hits[i].id] != 0
	}
	return nil
}

// brainCand is a memory the exact pass did not match, kept for the close one.
type brainCand struct {
	hit brainHit
	doc string
}

// sortBrainHits orders hits best first: current before superseded, then
// rank, then pinned, then newest.
func sortBrainHits(hits []brainHit) {
	slices.SortFunc(hits, func(a, b brainHit) int {
		switch {
		case a.superseded != b.superseded:
			if a.superseded {
				return 1
			}
			return -1
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
	query := `SELECT id, title, summary, project, keywords FROM brain_nodes WHERE search = ''`
	refold := false
	if v, err := s.GetMeta(ctx, metaBrainSearchFold); err != nil || v != brainSearchFold {
		query = `SELECT id, title, summary, project, keywords FROM brain_nodes`
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
		var kw BrainKeywords
		if err := rows.Scan(&id, &title, &summary, &project, &kw); err != nil {
			_ = rows.Close()
			return err
		}
		pending = append(pending, row{id, BrainSearchDoc(title, summary, project, kw...)})
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

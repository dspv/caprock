package termbuf

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// Screen replays terminal output onto a cols×rows grid and returns the text of
// each row, trailing blanks trimmed: what a terminal fed the same bytes would
// show now.
//
// It is the smallest emulator that reads what a TUI drew, not a terminal: it
// follows printing, line feeds, carriage returns, the cursor moves and erases
// a renderer uses (absolute and relative, in either screen buffer), and
// ignores colours, modes, titles and anything else that does not move text.
// Claude Code's renderer writes a line as words between cursor moves
// (`Do\x1b[5Gyou\x1b[9Gwant`), so reading the screen without placing the cursor
// is reading it wrong.
//
// The bytes need not start at a clean boundary — a ring that dropped its
// oldest bytes starts mid-sequence — and the result is still right for
// whatever the output drew after that, which for a dialog on the screen now is
// the part that matters. cols or rows ≤ 0 pick a wide default.
func Screen(b []byte, cols, rows int) []string {
	if cols <= 0 {
		cols = 512
	}
	if rows <= 0 {
		rows = 50
	}
	s := newScreen(cols, rows)
	s.feed(b)
	g := s.grid()
	out := make([]string, len(g))
	for i, row := range g {
		var sb strings.Builder
		for _, r := range row {
			if r != 0 { // the second cell of a wide character
				sb.WriteRune(r)
			}
		}
		out[i] = strings.TrimRight(sb.String(), " ")
	}
	return out
}

type screen struct {
	cols, rows int
	main, alt  [][]rune
	inAlt      bool
	x, y       int
	savedX     int
	savedY     int
	// wrapNext is the pending wrap of a terminal that just printed into the
	// last column: the next printable character goes to the next line.
	wrapNext bool
	// top and bottom are the scroll region, inclusive.
	top, bottom int
}

func newScreen(cols, rows int) *screen {
	s := &screen{cols: cols, rows: rows, bottom: rows - 1}
	s.main = blankGrid(cols, rows)
	s.alt = blankGrid(cols, rows)
	return s
}

func blankGrid(cols, rows int) [][]rune {
	g := make([][]rune, rows)
	for i := range g {
		g[i] = blankRow(cols)
	}
	return g
}

func blankRow(cols int) []rune {
	r := make([]rune, cols)
	for i := range r {
		r[i] = ' '
	}
	return r
}

func (s *screen) grid() [][]rune {
	if s.inAlt {
		return s.alt
	}
	return s.main
}

func (s *screen) feed(b []byte) {
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c == 0x1b:
			i = s.escape(b, i)
			continue
		case c == '\r':
			s.x, s.wrapNext = 0, false
		case c == '\n', c == 0x0b, c == 0x0c:
			s.lineFeed()
		case c == '\b':
			if s.x > 0 {
				s.x--
			}
			s.wrapNext = false
		case c == '\t':
			s.x = min((s.x/8+1)*8, s.cols-1)
			s.wrapNext = false
		case c < 0x20 || c == 0x7f:
			// BEL, SO, SI and the rest move nothing.
		case c < 0x80:
			s.put(rune(c))
		default:
			r, n := utf8.DecodeRune(b[i:])
			if r == utf8.RuneError && n <= 1 {
				i++ // a sequence cut by the ring's start, or not UTF-8
				continue
			}
			if r >= 0x80 && r < 0xa0 {
				i += n // C1 controls
				continue
			}
			s.put(r)
			i += n
			continue
		}
		i++
	}
}

func (s *screen) put(r rune) {
	if s.wrapNext {
		s.x = 0
		s.lineFeed()
		s.wrapNext = false
	}
	if isCombining(r) {
		return
	}
	w := 1
	if isWide(r) {
		w = 2
	}
	g := s.grid()
	g[s.y][s.x] = r
	if w == 2 && s.x+1 < s.cols {
		g[s.y][s.x+1] = 0 // the wide character's second cell
	}
	if s.x+w >= s.cols {
		s.x = s.cols - 1
		s.wrapNext = true
		return
	}
	s.x += w
}

func (s *screen) lineFeed() {
	s.wrapNext = false
	if s.y == s.bottom {
		s.scrollUp(1)
		return
	}
	if s.y < s.rows-1 {
		s.y++
	}
}

func (s *screen) scrollUp(n int) {
	g := s.grid()
	for ; n > 0; n-- {
		copy(g[s.top:s.bottom], g[s.top+1:s.bottom+1])
		g[s.bottom] = blankRow(s.cols)
	}
}

func (s *screen) scrollDown(n int) {
	g := s.grid()
	for ; n > 0; n-- {
		copy(g[s.top+1:s.bottom+1], g[s.top:s.bottom])
		g[s.top] = blankRow(s.cols)
	}
}

// escape handles the sequence starting at b[i] (an ESC) and returns the index
// after it. A sequence cut off at the end of b is dropped.
func (s *screen) escape(b []byte, i int) int {
	if i+1 >= len(b) {
		return len(b)
	}
	switch b[i+1] {
	case '[':
		return s.csi(b, i+2)
	case ']', 'P', '_', '^', 'X':
		// OSC, DCS, APC, PM, SOS: skip to BEL or ST.
		for j := i + 2; j < len(b); j++ {
			if b[j] == 0x07 {
				return j + 1
			}
			if b[j] == 0x1b && j+1 < len(b) && b[j+1] == '\\' {
				return j + 2
			}
		}
		return len(b)
	case '7':
		s.savedX, s.savedY = s.x, s.y
	case '8':
		s.x, s.y, s.wrapNext = s.savedX, s.savedY, false
	case 'D':
		s.lineFeed()
	case 'E':
		s.x = 0
		s.lineFeed()
	case 'M':
		s.wrapNext = false
		if s.y == s.top {
			s.scrollDown(1)
		} else if s.y > 0 {
			s.y--
		}
	case 'c':
		*s = *newScreen(s.cols, s.rows)
	case '(', ')', '*', '+', '#', '%', ' ':
		// Character set and line-size selections take one more byte.
		return min(i+3, len(b))
	}
	return i + 2
}

func (s *screen) csi(b []byte, j int) int {
	start := j
	for j < len(b) && b[j] >= 0x30 && b[j] <= 0x3f {
		j++
	}
	params := string(b[start:j])
	for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f {
		j++ // intermediates
	}
	if j >= len(b) {
		return len(b)
	}
	final := b[j]
	if final < 0x40 || final > 0x7e {
		return j // not a CSI after all; resume at the stray byte
	}
	private := strings.HasPrefix(params, "?") || strings.HasPrefix(params, ">") || strings.HasPrefix(params, "<") || strings.HasPrefix(params, "=")
	if private {
		if params[0] == '?' && (final == 'h' || final == 'l') {
			s.privateMode(params[1:], final == 'h')
		}
		return j + 1
	}
	p := parseParams(params)
	arg := func(k, def int) int {
		if k < len(p) && p[k] > 0 {
			return p[k]
		}
		return def
	}
	g := s.grid()
	switch final {
	case 'A':
		s.y = max(s.y-arg(0, 1), 0)
	case 'B', 'e':
		s.y = min(s.y+arg(0, 1), s.rows-1)
	case 'C', 'a':
		s.x = min(s.x+arg(0, 1), s.cols-1)
	case 'D':
		s.x = max(s.x-arg(0, 1), 0)
	case 'E':
		s.y, s.x = min(s.y+arg(0, 1), s.rows-1), 0
	case 'F':
		s.y, s.x = max(s.y-arg(0, 1), 0), 0
	case 'G', '`':
		s.x = within(arg(0, 1)-1, s.cols)
	case 'd':
		s.y = within(arg(0, 1)-1, s.rows)
	case 'H', 'f':
		s.y = within(arg(0, 1)-1, s.rows)
		s.x = within(arg(1, 1)-1, s.cols)
	case 'J':
		s.eraseDisplay(arg(0, 0))
	case 'K':
		s.eraseLine(arg(0, 0))
	case 'X':
		for k := s.x; k < min(s.x+arg(0, 1), s.cols); k++ {
			g[s.y][k] = ' '
		}
	case 'P':
		n := min(arg(0, 1), s.cols-s.x)
		row := g[s.y]
		copy(row[s.x:], row[s.x+n:])
		for k := s.cols - n; k < s.cols; k++ {
			row[k] = ' '
		}
	case '@':
		n := min(arg(0, 1), s.cols-s.x)
		row := g[s.y]
		copy(row[s.x+n:], row[s.x:s.cols-n])
		for k := s.x; k < s.x+n; k++ {
			row[k] = ' '
		}
	case 'L', 'M':
		if s.y >= s.top && s.y <= s.bottom {
			top := s.top
			s.top = s.y
			if final == 'L' {
				s.scrollDown(arg(0, 1))
			} else {
				s.scrollUp(arg(0, 1))
			}
			s.top = top
		}
	case 'S':
		s.scrollUp(arg(0, 1))
	case 'T':
		s.scrollDown(arg(0, 1))
	case 'r':
		top, bottom := arg(0, 1)-1, arg(1, s.rows)-1
		if top < bottom && bottom < s.rows {
			s.top, s.bottom = top, bottom
		} else {
			s.top, s.bottom = 0, s.rows-1
		}
		s.x, s.y = 0, 0
	case 's':
		s.savedX, s.savedY = s.x, s.y
	case 'u':
		s.x, s.y = s.savedX, s.savedY
	}
	if final != 'm' {
		s.wrapNext = false
	}
	return j + 1
}

func (s *screen) privateMode(params string, on bool) {
	for _, f := range strings.Split(params, ";") {
		switch f {
		case "1049", "1047", "47":
			if on == s.inAlt {
				continue
			}
			if on {
				s.savedX, s.savedY = s.x, s.y
				s.alt = blankGrid(s.cols, s.rows)
				s.inAlt = true
			} else {
				s.inAlt = false
				s.x, s.y = s.savedX, s.savedY
			}
			s.wrapNext = false
		}
	}
}

func (s *screen) eraseDisplay(mode int) {
	g := s.grid()
	switch mode {
	case 0:
		s.eraseLine(0)
		for y := s.y + 1; y < s.rows; y++ {
			g[y] = blankRow(s.cols)
		}
	case 1:
		s.eraseLine(1)
		for y := 0; y < s.y; y++ {
			g[y] = blankRow(s.cols)
		}
	case 2, 3:
		for y := range g {
			g[y] = blankRow(s.cols)
		}
	}
}

func (s *screen) eraseLine(mode int) {
	row := s.grid()[s.y]
	from, to := s.x, s.cols
	switch mode {
	case 1:
		from, to = 0, s.x+1
	case 2:
		from = 0
	}
	for k := from; k < min(to, s.cols); k++ {
		row[k] = ' '
	}
}

func parseParams(s string) []int {
	if s == "" {
		return nil
	}
	var out []int
	for _, f := range strings.Split(s, ";") {
		if k := strings.IndexByte(f, ':'); k >= 0 {
			f = f[:k]
		}
		n, _ := strconv.Atoi(f)
		out = append(out, n)
	}
	return out
}

// within is v kept to 0…n-1.
func within(v, n int) int { return max(0, min(v, n-1)) }

// isWide reports a character a terminal gives two cells: CJK, Hangul,
// full-width forms and most emoji. Close enough for reading text by row; a
// renderer that disagrees moves the cursor explicitly anyway.
func isWide(r rune) bool {
	switch {
	case r >= 0x1100 && r <= 0x115f,
		r >= 0x2e80 && r <= 0x303e,
		r >= 0x3041 && r <= 0x33ff,
		r >= 0x3400 && r <= 0x4dbf,
		r >= 0x4e00 && r <= 0x9fff,
		r >= 0xa000 && r <= 0xa4cf,
		r >= 0xac00 && r <= 0xd7a3,
		r >= 0xf900 && r <= 0xfaff,
		r >= 0xfe30 && r <= 0xfe4f,
		r >= 0xff00 && r <= 0xff60,
		r >= 0xffe0 && r <= 0xffe6,
		r >= 0x1f300 && r <= 0x1f64f,
		r >= 0x1f900 && r <= 0x1f9ff,
		r >= 0x20000 && r <= 0x3fffd:
		return true
	}
	return false
}

// isCombining reports a mark drawn onto the cell before it.
func isCombining(r rune) bool {
	return r >= 0x0300 && r <= 0x036f || r == 0x200d || r >= 0xfe00 && r <= 0xfe0f
}

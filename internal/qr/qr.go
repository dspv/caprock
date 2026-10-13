// Package qr is a dependency-free QR code encoder.
//
// It is a module-for-module port of the dashboard's ui/src/lib/qr.ts, so the
// daemon can print the same pairing code in a terminal that the pairing screen
// draws in the browser. Rule 4 is the reason it exists at all: the pairing URL
// carries a code that lets a device in, and it must not leave the machine to
// be drawn, so no image service and no third-party library.
//
// Deliberately narrow, exactly as qr.ts is: byte mode, error correction level
// M, versions 1 to 10 (up to MaxBytes bytes of UTF-8). Keeping the two encoders
// identical, including the mask choice, means a code scanned from the terminal
// and one scanned from the screen are the same symbol, and testdata/vectors.json
// (generated from qr.ts) proves it.
package qr

import (
	"errors"
	"strings"
)

// MaxBytes is the longest UTF-8 input a version-10, level-M code in byte mode
// holds: 216 data codewords less 2.5 bytes of mode and length header.
const MaxBytes = 213

// ErrTooLong is returned for input longer than MaxBytes.
var ErrTooLong = errors.New("qr: text too long for a QR code here")

// Error correction level M, per version (index 0 unused).
var (
	eccPerBlock = [...]int{-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26}
	numBlocks   = [...]int{-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5}
)

const (
	maxVersion = 10
	// eclM is level M's two format bits; M is 0b00 in the format field.
	eclM = 0
)

// Code is a square of modules.
type Code struct {
	// Size is the width and height in modules, without a quiet zone.
	Size    int
	modules [][]bool
}

// Dark reports whether the module at column x, row y is dark. Coordinates
// outside the symbol are light, which is what a quiet zone is.
func (c *Code) Dark(x, y int) bool {
	if x < 0 || y < 0 || x >= c.Size || y >= c.Size {
		return false
	}
	return c.modules[y][x]
}

// Encode encodes text as UTF-8 into the smallest code that holds it.
func Encode(text string) (*Code, error) {
	data := []byte(text)
	version := 1
	for ; version <= maxVersion; version++ {
		if 4+countBits(version)+len(data)*8 <= dataCodewords(version)*8 {
			break
		}
	}
	if version > maxVersion {
		return nil, ErrTooLong
	}

	// The bit stream: mode, length, data, terminator, padding.
	capacity := dataCodewords(version) * 8
	bits := make([]byte, 0, capacity)
	put := func(val, n int) {
		for i := n - 1; i >= 0; i-- {
			bits = append(bits, byte((val>>uint(i))&1))
		}
	}
	put(0b0100, 4)
	put(len(data), countBits(version))
	for _, b := range data {
		put(int(b), 8)
	}
	put(0, min(4, capacity-len(bits)))
	put(0, (8-len(bits)%8)%8)
	for pad := 0xec; len(bits) < capacity; pad ^= 0xec ^ 0x11 {
		put(pad, 8)
	}

	words := make([]byte, 0, len(bits)/8)
	for i := 0; i < len(bits); i += 8 {
		var b byte
		for j := 0; j < 8; j++ {
			b = b<<1 | bits[i+j]
		}
		words = append(words, b)
	}

	g := newGrid(version)
	g.drawFunctionPatterns()
	g.drawCodewords(withECC(words, version))

	// Every mask produces a valid code; the lowest penalty scans best. Ties go
	// to the lower mask, as in qr.ts, so both pick the same one.
	best, bestScore := 0, -1
	for m := 0; m < 8; m++ {
		g.applyMask(m)
		g.drawFormatBits(m)
		if score := g.penalty(); bestScore < 0 || score < bestScore {
			best, bestScore = m, score
		}
		g.applyMask(m) // XOR again to undo
	}
	g.applyMask(best)
	g.drawFormatBits(best)
	return &Code{Size: g.size, modules: g.modules}, nil
}

// countBits is the width of the byte-mode length field.
func countBits(ver int) int {
	if ver < 10 {
		return 8
	}
	return 16
}

// rawDataModules counts data and error-correction modules in a version, before
// the format and version areas.
func rawDataModules(ver int) int {
	n := (16*ver+128)*ver + 64
	if ver >= 2 {
		align := ver/7 + 2
		n -= (25*align-10)*align - 55
		if ver >= 7 {
			n -= 36
		}
	}
	return n
}

func dataCodewords(ver int) int {
	return rawDataModules(ver)/8 - eccPerBlock[ver]*numBlocks[ver]
}

// withECC splits data into blocks, appends Reed-Solomon codewords, and
// interleaves them.
func withECC(data []byte, ver int) []byte {
	nb := numBlocks[ver]
	eccLen := eccPerBlock[ver]
	raw := rawDataModules(ver) / 8
	numShort := nb - raw%nb
	shortLen := raw / nb
	divisor := rsDivisor(eccLen)
	blocks := make([][]byte, 0, nb)
	for i, k := 0, 0; i < nb; i++ {
		n := shortLen - eccLen
		if i >= numShort {
			n++
		}
		dat := append([]byte(nil), data[k:k+n]...)
		k += n
		ecc := rsRemainder(dat, divisor)
		if i < numShort {
			dat = append(dat, 0)
		}
		blocks = append(blocks, append(dat, ecc...))
	}
	out := make([]byte, 0, raw)
	for i := range blocks[0] {
		for j := range blocks {
			// Skip the padding byte that short blocks carry to line up.
			if i != shortLen-eccLen || j >= numShort {
				out = append(out, blocks[j][i])
			}
		}
	}
	return out
}

// gfMul multiplies in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1.
func gfMul(x, y byte) byte {
	var z int
	for i := 7; i >= 0; i-- {
		z = (z << 1) ^ ((z >> 7) * 0x11d)
		z ^= int((y>>uint(i))&1) * int(x)
	}
	return byte(z)
}

func rsDivisor(degree int) []byte {
	out := make([]byte, degree)
	out[degree-1] = 1
	var root byte = 1
	for i := 0; i < degree; i++ {
		for j := range out {
			out[j] = gfMul(out[j], root)
			if j+1 < len(out) {
				out[j] ^= out[j+1]
			}
		}
		root = gfMul(root, 0x02)
	}
	return out
}

func rsRemainder(data, divisor []byte) []byte {
	out := make([]byte, len(divisor))
	for _, b := range data {
		factor := b ^ out[0]
		copy(out, out[1:])
		out[len(out)-1] = 0
		for i := range out {
			out[i] ^= gfMul(divisor[i], factor)
		}
	}
	return out
}

type grid struct {
	version int
	size    int
	modules [][]bool
	// fn marks function-pattern modules, which data and masks leave alone.
	fn [][]bool
}

func newGrid(version int) *grid {
	size := version*4 + 17
	g := &grid{version: version, size: size}
	g.modules = make([][]bool, size)
	g.fn = make([][]bool, size)
	for y := range size {
		g.modules[y] = make([]bool, size)
		g.fn[y] = make([]bool, size)
	}
	return g
}

func (g *grid) set(x, y int, dark bool) {
	g.modules[y][x] = dark
	g.fn[y][x] = true
}

func (g *grid) drawFunctionPatterns() {
	s := g.size
	for i := 0; i < s; i++ {
		g.set(6, i, i%2 == 0)
		g.set(i, 6, i%2 == 0)
	}
	g.finder(3, 3)
	g.finder(s-4, 3)
	g.finder(3, s-4)
	pos := g.alignmentPositions()
	n := len(pos)
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			corner := (i == 0 && j == 0) || (i == 0 && j == n-1) || (i == n-1 && j == 0)
			if !corner {
				g.alignment(pos[i], pos[j])
			}
		}
	}
	g.drawFormatBits(0) // reserve the area; redrawn once the mask is chosen
	g.drawVersion()
}

func (g *grid) finder(cx, cy int) {
	for dy := -4; dy <= 4; dy++ {
		for dx := -4; dx <= 4; dx++ {
			x, y := cx+dx, cy+dy
			if x < 0 || y < 0 || x >= g.size || y >= g.size {
				continue
			}
			d := max(abs(dx), abs(dy))
			g.set(x, y, d != 2 && d != 4)
		}
	}
}

func (g *grid) alignment(cx, cy int) {
	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			g.set(cx+dx, cy+dy, max(abs(dx), abs(dy)) != 1)
		}
	}
}

func (g *grid) alignmentPositions() []int {
	if g.version == 1 {
		return nil
	}
	n := g.version/7 + 2
	// Ceiling division, as Math.ceil in qr.ts; both operands are positive.
	den := n*2 - 2
	step := (g.version*4 + 4 + den - 1) / den * 2
	out := []int{6}
	for p := g.size - 7; len(out) < n; p -= step {
		out = append([]int{6, p}, out[1:]...)
	}
	return out
}

func (g *grid) drawFormatBits(mask int) {
	data := eclM<<3 | mask
	rem := data
	for i := 0; i < 10; i++ {
		rem = (rem << 1) ^ ((rem >> 9) * 0x537)
	}
	bits := (data<<10 | rem) ^ 0x5412
	bit := func(i int) bool { return (bits>>uint(i))&1 == 1 }
	s := g.size
	for i := 0; i <= 5; i++ {
		g.set(8, i, bit(i))
	}
	g.set(8, 7, bit(6))
	g.set(8, 8, bit(7))
	g.set(7, 8, bit(8))
	for i := 9; i < 15; i++ {
		g.set(14-i, 8, bit(i))
	}
	for i := 0; i < 8; i++ {
		g.set(s-1-i, 8, bit(i))
	}
	for i := 8; i < 15; i++ {
		g.set(8, s-15+i, bit(i))
	}
	g.set(8, s-8, true) // the dark module, always dark
}

func (g *grid) drawVersion() {
	if g.version < 7 {
		return
	}
	rem := g.version
	for i := 0; i < 12; i++ {
		rem = (rem << 1) ^ ((rem >> 11) * 0x1f25)
	}
	bits := g.version<<12 | rem
	for i := 0; i < 18; i++ {
		dark := (bits>>uint(i))&1 == 1
		a := g.size - 11 + i%3
		b := i / 3
		g.set(a, b, dark)
		g.set(b, a, dark)
	}
}

func (g *grid) drawCodewords(data []byte) {
	s := g.size
	i := 0
	for right := s - 1; right >= 1; right -= 2 {
		if right == 6 {
			right = 5 // skip the vertical timing column
		}
		for vert := 0; vert < s; vert++ {
			for j := 0; j < 2; j++ {
				x := right - j
				upward := (right+1)&2 == 0
				y := vert
				if upward {
					y = s - 1 - vert
				}
				if !g.fn[y][x] && i < len(data)*8 {
					g.modules[y][x] = (data[i>>3]>>uint(7-(i&7)))&1 == 1
					i++
				}
			}
		}
	}
}

func (g *grid) applyMask(m int) {
	for y := 0; y < g.size; y++ {
		for x := 0; x < g.size; x++ {
			if g.fn[y][x] {
				continue
			}
			var invert bool
			switch m {
			case 0:
				invert = (x+y)%2 == 0
			case 1:
				invert = y%2 == 0
			case 2:
				invert = x%3 == 0
			case 3:
				invert = (x+y)%3 == 0
			case 4:
				invert = (x/3+y/2)%2 == 0
			case 5:
				invert = (x*y)%2+(x*y)%3 == 0
			case 6:
				invert = ((x*y)%2+(x*y)%3)%2 == 0
			default:
				invert = ((x+y)%2+(x*y)%3)%2 == 0
			}
			if invert {
				g.modules[y][x] = !g.modules[y][x]
			}
		}
	}
}

// penalty is the score qr.ts uses: runs, 2x2 blocks, finder look-alikes and
// balance. It is kept identical to qr.ts rather than to the letter of the
// standard, because the mask it picks is what makes the two codes match.
func (g *grid) penalty() int {
	s := g.size
	score := 0
	line := make([]bool, s)
	for pass := 0; pass < 2; pass++ {
		for a := 0; a < s; a++ {
			for b := 0; b < s; b++ {
				if pass == 0 {
					line[b] = g.modules[a][b]
				} else {
					line[b] = g.modules[b][a]
				}
			}
			run := 1
			for b := 1; b <= s; b++ {
				if b < s && line[b] == line[b-1] {
					run++
					continue
				}
				if run >= 5 {
					score += run - 2
				}
				run = 1
			}
			score += finderLike(line) * 40
		}
	}
	for y := 0; y+1 < s; y++ {
		for x := 0; x+1 < s; x++ {
			a, b, c, d := g.modules[y][x], g.modules[y][x+1], g.modules[y+1][x], g.modules[y+1][x+1]
			if a == b && b == c && c == d {
				score += 3
			}
		}
	}
	dark := 0
	for _, row := range g.modules {
		for _, v := range row {
			if v {
				dark++
			}
		}
	}
	total := s * s
	score += abs(dark*20-total*10) / total * 10
	return score
}

// finderLike counts 1:1:3:1:1 dark-light patterns with four light modules on
// one side.
func finderLike(line []bool) int {
	pat := [7]bool{true, false, true, true, true, false, true}
	allLight := func(seg []bool) bool {
		for _, v := range seg {
			if v {
				return false
			}
		}
		return true
	}
	n := 0
	for i := 0; i+7 <= len(line); i++ {
		match := true
		for k, p := range pat {
			if line[i+k] != p {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		before := i >= 4 && allLight(line[i-4:i])
		after := i+11 <= len(line) && allLight(line[i+7:i+11])
		if before || after {
			n++
		}
	}
	return n
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// Terminal renders the code with Unicode half blocks, two module rows per
// line, inside a quiet zone of quiet modules on every side (the standard asks
// for 4; a negative value is treated as 0).
//
// The drawing is inverted on purpose: a dark module is a space and a light
// module is a block, as `qrencode -t utf8` does. A space takes the terminal's
// background and a block its foreground, and on the usual dark terminal that
// makes the light modules light and the dark modules dark, which is what a
// scanner needs. Drawing dark modules as blocks instead gives a negative code
// on a dark terminal, which many phone cameras refuse to read. On a light
// terminal (dark text on white) this drawing comes out as a negative; the
// common iOS and Android scanners read inverted codes, and the drawn quiet
// zone keeps the symbol framed either way. A rendering that is positive on
// every background would need ANSI colours, which not every output keeps.
func (c *Code) Terminal(quiet int) string {
	quiet = max(quiet, 0)
	n := c.Size + 2*quiet
	var b strings.Builder
	for y := 0; y < n; y += 2 {
		for x := 0; x < n; x++ {
			top := !c.Dark(x-quiet, y-quiet)
			// The row past the bottom edge is outside the zone, so it
			// stays unpainted rather than adding a stray light row.
			bottom := y+1 < n && !c.Dark(x-quiet, y+1-quiet)
			switch {
			case top && bottom:
				b.WriteString("█")
			case top:
				b.WriteString("▀")
			case bottom:
				b.WriteString("▄")
			default:
				b.WriteByte(' ')
			}
		}
		b.WriteByte('\n')
	}
	return b.String()
}

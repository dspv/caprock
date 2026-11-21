package diskio

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeCounter is a process counter the test moves by hand.
type fakeCounter struct{ n uint64 }

func (c *fakeCounter) read() uint64 { return c.n }

func TestMeterSplitsByWhatRan(t *testing.T) {
	c := &fakeCounter{}
	m := newMeter(c.read)

	c.n = 100 // before anything: the first reading is the baseline, not a read
	m.begin("a")
	c.n += 40 // a alone
	m.begin("b")
	c.n += 30 // a and b: 15 each
	m.end("a", 7)
	c.n += 10 // b alone
	m.end("b", 0)
	c.n += 5 // nothing running

	got := m.snapshot()
	for name, want := range map[string]uint64{"a": 55, "b": 25, Unattributed: 5} {
		if got[name].ReadBytes != want {
			t.Errorf("%s read %d, want %d", name, got[name].ReadBytes, want)
		}
	}
	if got["a"].LogicalBytes != 7 || got["a"].Ops != 1 || got["b"].Ops != 1 {
		t.Errorf("a = %+v, b = %+v", got["a"], got["b"])
	}
	var sum uint64
	for _, s := range got {
		sum += s.ReadBytes
	}
	if sum != c.n-100 {
		t.Errorf("the shares add up to %d, the counter moved %d", sum, c.n-100)
	}
}

func TestMeterSplitsAnOddRemainder(t *testing.T) {
	c := &fakeCounter{}
	m := newMeter(c.read)
	m.begin("a")
	m.begin("a")
	m.begin("b")
	c.n += 10 // three in flight: no byte lost to the division
	got := m.snapshot()
	if a, b := got["a"].ReadBytes, got["b"].ReadBytes; a+b != 10 || a < 6 {
		t.Errorf("a %d b %d, want 10 in all with a's two operations holding two thirds", a, b)
	}
}

func TestDeltaAndSort(t *testing.T) {
	before := map[string]Source{"a": {Name: "a", ReadBytes: 10}, "b": {Name: "b", ReadBytes: 5}}
	after := map[string]Source{"a": {Name: "a", ReadBytes: 12}, "b": {Name: "b", ReadBytes: 50, LogicalBytes: 9}, "c": {Name: "c", LogicalBytes: 3}, "d": {Name: "d"}}
	d := Delta(before, after)
	var names []string
	for _, s := range d {
		names = append(names, s.Name)
	}
	if strings.Join(names, ",") != "b,a,c" {
		t.Fatalf("order %v, want b,a,c (d moved nothing)", names)
	}
	if d[0].ReadBytes != 45 || d[0].LogicalBytes != 9 {
		t.Errorf("b = %+v", d[0])
	}
}

func TestFileCountsWhatIsRead(t *testing.T) {
	p := filepath.Join(t.TempDir(), "t.jsonl")
	body := bytes.Repeat([]byte("line\n"), 1000)
	if err := os.WriteFile(p, body, 0o600); err != nil {
		t.Fatal(err)
	}
	name := "test file " + t.Name()
	f, err := Open(name, p)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var out bytes.Buffer
	if _, err := io.Copy(&out, f); err != nil { // WriteTo, not the *os.File one
		t.Fatal(err)
	}
	var one [1]byte
	if _, err := f.ReadAt(one[:], 4); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), body) || one[0] != '\n' {
		t.Fatal("the file read back wrong")
	}
	if got := Snapshot()[name]; got.LogicalBytes != uint64(len(body))+1 {
		t.Errorf("logical %d, want %d", got.LogicalBytes, len(body)+1)
	}
	if _, err := ReadFile(name, p); err != nil {
		t.Fatal(err)
	}
	if got := Snapshot()[name]; got.LogicalBytes != 2*uint64(len(body))+1 {
		t.Errorf("logical after ReadFile %d", got.LogicalBytes)
	}
}

func BenchmarkBeginEnd(b *testing.B) {
	for b.Loop() {
		Begin("bench")()
	}
}

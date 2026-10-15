package daemon

import (
	"math"
	"sort"
	"time"
)

// The resource meter's last hour (03-contracts.md § Resources, history):
// every sample the meter takes is also kept, in a fixed ring of
// resourceHistoryCap slots, so the status bar's popover can draw CPU and
// memory over time. It adds no sampling of its own — the meter samples only
// while somebody is looking, so the history has gaps where nobody was — and
// it holds a bounded amount: 12 bytes a session a sample (memory kept in
// KiB, a session as an index into one table of ids), the slots allocated
// once with the meter, each slot's session slice reused when the ring wraps.
const resourceHistoryCap = int(time.Hour / resourceEvery) // 720 at 5 s

type histPoint struct {
	cpu    float32
	memKiB uint32 // up to 4 TiB
	warm   bool
}

type histSession struct {
	id uint16 // into resourceHistory.ids
	histPoint
}

type histSample struct {
	at       int64 // unix ms
	caprock  histPoint
	all      histPoint
	sessions []histSession
}

// resourceHistory is the ring. Callers hold resourceMeter.mu.
type resourceHistory struct {
	slots [resourceHistoryCap]histSample
	next  int // the slot the next sample goes into
	n     int // how many slots are filled
	// ids is every session id the ring holds, once; idx finds one. Rebuilt
	// each time the ring wraps, so ended sessions' ids are let go.
	ids []string
	idx map[string]uint16
}

func kib(b uint64) uint32 {
	k := (b + 512) / 1024
	if k > math.MaxUint32 {
		return math.MaxUint32
	}
	return uint32(k)
}

func (h *resourceHistory) intern(id string) (uint16, bool) {
	if h.idx == nil {
		h.idx = map[string]uint16{}
	}
	if i, ok := h.idx[id]; ok {
		return i, true
	}
	if len(h.ids) > math.MaxUint16 {
		return 0, false // never within an hour; the session is left out rather than mixed up
	}
	i := uint16(len(h.ids))
	h.ids = append(h.ids, id)
	h.idx[id] = i
	return i, true
}

// record keeps one report. A report that failed to read the process table
// carries nothing to draw and is skipped.
func (h *resourceHistory) record(r *ResourceReport) {
	if r == nil || r.Error != "" {
		return
	}
	s := &h.slots[h.next]
	s.at = r.At
	if cap(s.sessions) < len(r.Sessions) {
		s.sessions = make([]histSession, 0, len(r.Sessions))
	}
	s.sessions = s.sessions[:0]
	var allCPU float64
	var allMem uint64
	for _, x := range r.Sessions {
		id, ok := h.intern(x.SessionID)
		if !ok {
			continue
		}
		s.sessions = append(s.sessions, histSession{id: id, histPoint: histPoint{cpu: float32(x.CPUPct), memKiB: kib(x.MemBytes), warm: x.Warm}})
		if x.Warm {
			allCPU += x.CPUPct
		}
		allMem += x.MemBytes
	}
	s.all = histPoint{cpu: float32(allCPU), memKiB: kib(allMem), warm: true}
	s.caprock = caprockPoint(r.Caprock)
	h.next = (h.next + 1) % resourceHistoryCap
	if h.n < resourceHistoryCap {
		h.n++
	}
	if h.next == 0 {
		h.reintern()
	}
}

// caprockPoint is Caprock's own total: the daemon, the terminal holders, the
// app and its web view.
func caprockPoint(c CaprockResources) histPoint {
	cpu := c.Daemon.CPUPct + c.Hosts.CPUPct
	mem := c.Daemon.MemBytes + c.Hosts.MemBytes
	if c.App != nil {
		cpu += c.App.CPUPct
		mem += c.App.MemBytes
	}
	if c.Webview != nil {
		cpu += c.Webview.CPUPct
		mem += c.Webview.MemBytes
	}
	return histPoint{cpu: float32(cpu), memKiB: kib(mem), warm: true}
}

// reintern keeps only the ids some slot still holds, renumbering the slots.
func (h *resourceHistory) reintern() {
	ids := make([]string, 0, len(h.ids))
	idx := make(map[string]uint16, len(h.ids))
	for i := 0; i < h.n; i++ {
		ss := h.slots[i].sessions
		for j := range ss {
			id := h.ids[ss[j].id]
			n, ok := idx[id]
			if !ok {
				n = uint16(len(ids))
				ids = append(ids, id)
				idx[id] = n
			}
			ss[j].id = n
		}
	}
	h.ids, h.idx = ids, idx
}

// Series is one line of the history: values aligned with ResourceHistory.At,
// null where there is no figure — a session not running then, or a CPU
// before its first rate.
type Series struct {
	CPU []*float64 `json:"cpu"`
	Mem []*uint64  `json:"mem"`
}

// ResourceHistory is GET /v1/resources/history.
type ResourceHistory struct {
	IntervalS int                `json:"interval_s"`
	Capacity  int                `json:"capacity"`
	At        []int64            `json:"at"`
	Caprock   Series             `json:"caprock"`
	All       Series             `json:"all"`
	Sessions  map[string]*Series `json:"sessions"`
}

func newSeries(n int) *Series { return &Series{CPU: make([]*float64, n), Mem: make([]*uint64, n)} }

func (s *Series) set(i int, p histPoint) {
	m := uint64(p.memKiB) * 1024
	s.Mem[i] = &m
	if p.warm {
		v := math.Round(float64(p.cpu)*10) / 10
		s.CPU[i] = &v
	}
}

// since returns the samples taken after sinceMs (unix ms; 0 for all of
// them), oldest first.
func (h *resourceHistory) since(sinceMs int64) *ResourceHistory {
	out := &ResourceHistory{IntervalS: int(resourceEvery / time.Second), Capacity: resourceHistoryCap, Sessions: map[string]*Series{}}
	start := (h.next - h.n + resourceHistoryCap) % resourceHistoryCap
	picked := make([]*histSample, 0, h.n)
	for i := 0; i < h.n; i++ {
		s := &h.slots[(start+i)%resourceHistoryCap]
		if s.at > sinceMs {
			picked = append(picked, s)
		}
	}
	// Recorded in time order; a clock stepped back could break that.
	sort.SliceStable(picked, func(i, j int) bool { return picked[i].at < picked[j].at })
	n := len(picked)
	out.At = make([]int64, n)
	out.Caprock, out.All = *newSeries(n), *newSeries(n)
	for i, s := range picked {
		out.At[i] = s.at
		out.Caprock.set(i, s.caprock)
		out.All.set(i, s.all)
		for _, x := range s.sessions {
			id := h.ids[x.id]
			se := out.Sessions[id]
			if se == nil {
				se = newSeries(n)
				out.Sessions[id] = se
			}
			se.set(i, x.histPoint)
		}
	}
	return out
}

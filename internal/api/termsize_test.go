package api

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// sizeLog records what the PTY was given.
type sizeLog struct {
	mu    sync.Mutex
	sizes [][2]int
}

func (l *sizeLog) resize(_ string, cols, rows int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sizes = append(l.sizes, [2]int{cols, rows})
}

// take returns what was given since the last take.
func (l *sizeLog) take() [][2]int {
	l.mu.Lock()
	defer l.mu.Unlock()
	got := l.sizes
	l.sizes = nil
	return got
}

func newTestSizes() (*ptySizes, *sizeLog) {
	l := &sizeLog{}
	p := newPTYSizes(l.resize)
	p.gap = 0
	return p, l
}

func wantSizes(t *testing.T, l *sizeLog, step string, want ...[2]int) {
	t.Helper()
	got := l.take()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("%s: the PTY was given %v; want %v", step, got, want)
	}
}

// Vova's steps (2026-10-12): the desktop has the session, a phone opens it,
// types from the phone, and the desktop is used again.
func TestPTYSizeFollowsTheTerminalInUse(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	wantSizes(t, l, "the only terminal", [2]int{149, 40}, [2]int{150, 40})

	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	wantSizes(t, l, "a phone opening the session repaints at the desktop's size", [2]int{149, 40}, [2]int{150, 40})

	// Its box changing while it is a viewer changes nothing.
	p.size(phone, 46, 30, false)
	wantSizes(t, l, "a viewer's own resize")

	p.claim(phone) // a key from the phone
	wantSizes(t, l, "the phone types", [2]int{45, 30}, [2]int{46, 30})
	p.claim(phone)
	wantSizes(t, l, "the next key, at the size already in use")

	// The desktop's box changing while the phone is in use is remembered.
	p.size(desk, 160, 40, false)
	wantSizes(t, l, "the desktop's window resized while a viewer")

	p.claim(desk) // focus or a key on the desktop
	wantSizes(t, l, "back to the desktop", [2]int{159, 40}, [2]int{160, 40})

	// The one in use resizing its own box goes through as sent.
	p.size(desk, 170, 42, false)
	wantSizes(t, l, "the desktop's window resized while in use", [2]int{170, 42})
}

func TestPTYSizeFocusInTheResizeFrameClaims(t *testing.T) {
	p, l := newTestSizes()
	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	l.take()
	// The desktop's tab comes to the front and reconnects: its first size
	// comes with focus, and it takes the PTY with one repaint.
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, true)
	wantSizes(t, l, "first size with focus", [2]int{149, 40}, [2]int{150, 40})
	p.size(phone, 44, 30, false)
	wantSizes(t, l, "the phone, now a viewer")
}

func TestPTYSizeGoesToTheLastUsedWhenTheOneInUseLeaves(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	p.claim(phone)
	l.take()
	p.leave(phone)
	wantSizes(t, l, "the phone closes its terminal", [2]int{149, 40}, [2]int{150, 40})
	p.size(desk, 151, 40, false)
	wantSizes(t, l, "the desktop is in use again", [2]int{151, 40})
}

// A socket that drops and comes back for the same tab is still in use: it
// does not have to type first, and the other terminal it was handed to on
// the way gives it back.
func TestPTYSizeTheSameTabReconnectingKeepsThePTY(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	l.take()
	p.leave(desk)
	wantSizes(t, l, "the desktop's socket drops", [2]int{44, 30}, [2]int{45, 30})
	desk2 := p.join("s1", "desk")
	p.size(desk2, 150, 40, false)
	wantSizes(t, l, "the desktop reconnects", [2]int{149, 40}, [2]int{150, 40})
	p.size(phone, 44, 30, false)
	wantSizes(t, l, "the phone is a viewer again")
}

func TestPTYSizeAClaimBeforeAnySizeWaitsForIt(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	l.take()
	phone := p.join("s1", "phone")
	p.claim(phone) // typed before its first resize arrived
	wantSizes(t, l, "a claim with no size")
	p.size(phone, 45, 30, false)
	wantSizes(t, l, "its first size, as the owner", [2]int{44, 30}, [2]int{45, 30})
}

func TestPTYSizeStartsOverWhenEveryTerminalLeaves(t *testing.T) {
	p, l := newTestSizes()
	a := p.join("s1", "a")
	p.size(a, 100, 30, false)
	p.leave(a)
	l.take()
	if p.state("s1") != nil {
		t.Fatal("a session with no terminal kept its state")
	}
	b := p.join("s1", "b")
	p.size(b, 80, 24, false)
	wantSizes(t, l, "a fresh attach", [2]int{79, 24}, [2]int{80, 24})
}

// The same policy over the socket: two clients, the second only watching
// until it types, and the first taking the PTY back with focus.
func TestTermV2TwoClientsTheOneInUseSizesThePTY(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	srv, ag := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	desk := dialV2(ctx, t, srv, "?client=desk")
	defer func() { _ = desk.CloseNow() }()
	mustHello(ctx, t, desk)
	mustFrame(ctx, t, desk)
	_ = desk.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":150,"rows":40}}`))
	waitFor(t, func() bool { return len(ag.sized()) == 2 })

	phone := dialV2(ctx, t, srv, "?client=phone")
	defer func() { _ = phone.CloseNow() }()
	mustHello(ctx, t, phone)
	mustFrame(ctx, t, phone)
	_ = phone.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":45,"rows":30}}`))
	waitFor(t, func() bool { return len(ag.sized()) == 4 })
	if got := ag.sized()[2:]; fmt.Sprint(got) != "[[149 40] [150 40]]" {
		t.Fatalf("a phone attaching gave the PTY %v; want a repaint at the desktop's 150x40", got)
	}

	_ = phone.Write(ctx, websocket.MessageBinary, input(1, "x"))
	waitFor(t, func() bool { return len(ft.typedNow()) == 1 })
	if got := ag.sized()[4:]; fmt.Sprint(got) != "[[44 30] [45 30]]" {
		t.Fatalf("after the phone typed the PTY was given %v; want the phone's 45x30", got)
	}

	_ = desk.Write(ctx, websocket.MessageText, []byte(`{"focus":true}`))
	waitFor(t, func() bool { return len(ag.sized()) == 8 })
	if got := ag.sized()[6:]; fmt.Sprint(got) != "[[149 40] [150 40]]" {
		t.Fatalf("after the desktop took focus the PTY was given %v; want the desktop's 150x40", got)
	}
	// Focus again at the size in use changes nothing.
	_ = desk.Write(ctx, websocket.MessageText, []byte(`{"focus":true}`))
	_ = desk.Write(ctx, websocket.MessageText, []byte(`{"ping":1}`))
	for {
		if f := mustFrame(ctx, t, desk); f.text["pong"] != nil {
			break
		}
	}
	if n := len(ag.sized()); n != 8 {
		t.Fatalf("a second focus resized the PTY: %v", ag.sized())
	}
}

// The bug (Vova, 2026-10-13): a session open on the laptop and then on a
// phone, the phone types, the phone is put away — and the laptop stayed
// drawn at the phone's width until the session was reopened. Going out of
// sight gives the PTY back at once, without waiting for the socket to die.
func TestPTYSizeGoesBackWhenTheOneInUseGoesOutOfSight(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	p.claim(phone)
	l.take()

	p.release(phone)
	wantSizes(t, l, "the phone locks", [2]int{149, 40}, [2]int{150, 40})
	p.size(phone, 44, 30, false)
	wantSizes(t, l, "the phone out of sight is a viewer")
	p.size(desk, 151, 40, false)
	wantSizes(t, l, "the desktop is in use again", [2]int{151, 40})

	// Its socket dies while locked and comes back when it is unlocked:
	// picking the phone up again is not taking the session over.
	p.leave(phone)
	wantSizes(t, l, "the locked phone's socket is taken for dead")
	phone2 := p.join("s1", "phone")
	p.size(phone2, 44, 30, false)
	wantSizes(t, l, "the phone reconnects, a viewer", [2]int{150, 40}, [2]int{151, 40})

	p.claim(phone2)
	wantSizes(t, l, "the phone types again", [2]int{43, 30}, [2]int{44, 30})
}

// A viewer going out of sight changes nothing, and neither does the one in
// use when no other terminal is in sight: a lone desktop window hidden and
// shown keeps its size.
func TestPTYSizeReleaseWithNobodyToTakeItKeepsTheSize(t *testing.T) {
	p, l := newTestSizes()
	desk := p.join("s1", "desk")
	p.size(desk, 150, 40, false)
	l.take()
	p.release(desk)
	wantSizes(t, l, "the only terminal goes out of sight")
	p.size(desk, 140, 40, false)
	wantSizes(t, l, "still the one in use", [2]int{140, 40})

	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	l.take()
	p.release(phone)
	wantSizes(t, l, "a viewer goes out of sight")
	p.claim(phone)
	l.take()
	p.release(phone)
	wantSizes(t, l, "the phone in use goes out of sight while the desktop is out of sight too")
}

// The PTY goes to the terminal used most recently among those in sight: a
// hidden browser tab used later than the app does not win over it.
func TestPTYSizeReleasePrefersATerminalInSight(t *testing.T) {
	p, l := newTestSizes()
	app := p.join("s1", "app")
	p.size(app, 150, 40, false)
	tab := p.join("s1", "tab")
	p.size(tab, 120, 35, false)
	p.claim(tab)
	p.release(tab)
	wantSizes(t, l, "the app, then the tab, then the tab hidden",
		[2]int{149, 40}, [2]int{150, 40}, [2]int{149, 40}, [2]int{150, 40},
		[2]int{119, 35}, [2]int{120, 35}, [2]int{149, 40}, [2]int{150, 40})

	phone := p.join("s1", "phone")
	p.size(phone, 45, 30, false)
	p.claim(phone)
	l.take()
	// The phone's socket closes: the app is in sight, the tab is not.
	p.leave(phone)
	wantSizes(t, l, "the phone leaves", [2]int{149, 40}, [2]int{150, 40})

	// With nobody in sight, a socket closing still hands the PTY on.
	p.release(app)
	p.claim(tab)
	p.release(tab)
	l.take()
	p.leave(tab)
	wantSizes(t, l, "the tab leaves, only the hidden app is left", [2]int{149, 40}, [2]int{150, 40})
}

// Over the socket: a blur frame from the phone in use gives the desktop its
// size back while the phone stays connected.
func TestTermV2BlurGivesThePTYBack(t *testing.T) {
	ft := newFakeTerm(1 << 10)
	srv, ag := v2Server(t, ft)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	desk := dialV2(ctx, t, srv, "?client=desk")
	defer func() { _ = desk.CloseNow() }()
	mustHello(ctx, t, desk)
	mustFrame(ctx, t, desk)
	_ = desk.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":150,"rows":40}}`))
	waitFor(t, func() bool { return len(ag.sized()) == 2 })

	phone := dialV2(ctx, t, srv, "?client=phone")
	defer func() { _ = phone.CloseNow() }()
	mustHello(ctx, t, phone)
	mustFrame(ctx, t, phone)
	_ = phone.Write(ctx, websocket.MessageText, []byte(`{"resize":{"cols":45,"rows":30},"focus":true}`))
	waitFor(t, func() bool { return len(ag.sized()) == 4 })

	_ = phone.Write(ctx, websocket.MessageText, []byte(`{"blur":true}`))
	waitFor(t, func() bool { return len(ag.sized()) == 6 })
	if got := ag.sized()[4:]; fmt.Sprint(got) != "[[149 40] [150 40]]" {
		t.Fatalf("after the phone went out of sight the PTY was given %v; want the desktop's 150x40", got)
	}
}

package bus

import "testing"

func TestPublishFanOutAndDrop(t *testing.T) {
	b := New()
	a := b.Subscribe(1)
	c := b.Subscribe(1)
	b.Publish(Frame{Type: FrameEvent, Data: 1})
	b.Publish(Frame{Type: FrameEvent, Data: 2}) // dropped for both (buffer 1)
	if got := <-a.C; got.Data != 1 {
		t.Fatalf("a got %v", got)
	}
	if got := <-c.C; got.Data != 1 {
		t.Fatalf("c got %v", got)
	}
	if b.dropped != 2 {
		t.Fatalf("dropped %d", b.dropped)
	}
	a.Unsubscribe()
	a.Unsubscribe() // idempotent
	if _, ok := <-a.C; ok {
		t.Fatal("channel not closed")
	}
	if b.Subscribers() != 1 {
		t.Fatalf("subs %d", b.Subscribers())
	}
}

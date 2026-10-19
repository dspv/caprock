package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
)

// The footprint and the shell list on the live socket (03-contracts.md
// § Footprint, § Projects and shells). The app used to ask GET /v1/footprint
// and GET /v1/shells every 10 s each, from every open window; now the daemon
// looks at that pace and sends a frame only when something changed, and the
// app polls once a minute as a fallback.

// livePushEvery is how often the footprint and the shells are checked for a
// change: the pace the app polled them at.
const livePushEvery = 10 * time.Second

// livePushed is the last footprint sent, without its time, to tell a change.
type livePushed struct {
	mu        sync.Mutex
	footprint []byte
}

// changed records f as sent and reports whether it differs from the last.
func (p *livePushed) changed(f *FootprintReport) bool {
	c := *f
	c.At = 0
	b, err := json.Marshal(&c)
	if err != nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if bytes.Equal(b, p.footprint) {
		return false
	}
	p.footprint = b
	return true
}

// pushLive sends a "footprint" frame and a "shells" frame when each changed.
// Only while a /v1/live client is connected — nobody else would hear them —
// and from the meter's last sample: it takes none and does not count as
// asking, so it never keeps the meter sampling by itself.
func (d *Daemon) pushLive(ctx context.Context) {
	if d.api == nil || d.api.LiveClients() == 0 {
		return
	}
	d.api.PublishShells()
	d.res.mu.Lock()
	rep := d.res.last
	d.res.mu.Unlock()
	if rep == nil {
		return
	}
	f := d.footprintFrom(ctx, rep, false, false)
	if d.pushed.changed(f) {
		d.bus.Publish(bus.Frame{Type: bus.FrameFootprint, Data: f})
	}
}

package daemon

import (
	"context"
	"testing"

	"github.com/dspv/caprock/internal/remote"
)

// A request that switched access from anywhere on before the startup read
// ran keeps its settings: the startup read must not put back a stale "off"
// (which left the host online and every pairing link empty).
func TestStartupKeepsSettingsARequestAlreadyChanged(t *testing.T) {
	dir := t.TempDir()
	d := &Daemon{log: quietLog(), opt: Options{DataDir: dir}, baseCtx: context.Background()}
	// Startup has not run; a request reads the settings (as the pairing
	// panel does) and then turns access on in memory and on disk.
	if st := d.RemoteState(""); st.Enabled || st.HostID == "" {
		t.Fatalf("first read: %+v", st)
	}
	d.mu.Lock()
	d.remoteSet.Enabled = true
	if err := remote.Save(dir, d.remoteSet); err != nil {
		t.Fatal(err)
	}
	keys := d.remoteSet.Sign
	d.mu.Unlock()

	d.startRemoteFromSettings(context.Background())

	st := d.RemoteState("123456")
	if !st.Enabled || st.Link == "" {
		t.Fatalf("after startup: %+v", st)
	}
	d.mu.Lock()
	same := string(d.remoteSet.Sign) == string(keys)
	d.mu.Unlock()
	if !same {
		t.Fatal("startup replaced the keys a request had already loaded")
	}
}

package daemon

import "testing"

// A footprint frame goes out when the footprint changed, not when only its
// time did.
func TestFootprintPushedOnChange(t *testing.T) {
	var p livePushed
	f := &FootprintReport{At: 1, DataDir: "/d", Memory: FootprintMemory{TotalMemBytes: 100}}
	if !p.changed(f) {
		t.Fatal("the first footprint was not sent")
	}
	f.At = 2
	if p.changed(f) {
		t.Fatal("a new time alone was sent again")
	}
	f.Memory.TotalMemBytes = 200
	if !p.changed(f) {
		t.Fatal("a change in memory was not sent")
	}
	f.Disk.TotalBytes = 5
	if !p.changed(f) {
		t.Fatal("a change on disk was not sent")
	}
}

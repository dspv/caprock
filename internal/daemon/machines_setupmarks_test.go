package daemon

import "testing"

// TestMachinesAdapterKeepsSetupMarks: the API reaches setup marks through a
// type assertion on the machines it was given, so an adapter that forgets the
// method compiles fine and answers 501 to every Done there (owner, 2026-11-28).
func TestMachinesAdapterKeepsSetupMarks(t *testing.T) {
	var m any = &machinesAdapter{}
	if _, ok := m.(interface {
		SetSetupDone(id string, done []string) error
	}); !ok {
		t.Fatal("machinesAdapter has no SetSetupDone: Done there answers 501")
	}
}

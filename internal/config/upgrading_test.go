package config

import (
	"os"
	"testing"
	"time"
)

func TestUpgradingMarkerLivesUntilDone(t *testing.T) {
	dir := t.TempDir()
	if _, ok := ReadUpgrading(dir); ok {
		t.Fatal("an upgrade read before one started")
	}
	done := MarkUpgrading(dir)
	u, ok := ReadUpgrading(dir)
	if !ok || u.PID != os.Getpid() || u.StartedAt == 0 {
		t.Fatalf("upgrade not read while running: %+v %v", u, ok)
	}
	done()
	if _, err := os.Stat(UpgradingPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("upgrading.json left behind: %v", err)
	}
}

func TestStaleUpgradingMarkerIsIgnored(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(UpgradingPath(dir), []byte(`{"pid":1,"started_at":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-UpgradingStale)
	if err := os.Chtimes(UpgradingPath(dir), old, old); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadUpgrading(dir); ok {
		t.Fatal("a stale upgrading.json read as an upgrade under way")
	}
}

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// UpgradingPath is <data_dir>/upgrading.json: there while the daemon upgrades
// its database, before it listens (03-contracts.md § Runtime file).
func UpgradingPath(dir string) string { return filepath.Join(dir, "upgrading.json") }

type Upgrading struct {
	PID       int   `json:"pid"`
	StartedAt int64 `json:"started_at"` // unix ms
}

// The daemon touches upgrading.json every UpgradingBeat while it upgrades; a
// file older than UpgradingStale was left by one that died.
const (
	UpgradingBeat  = 2 * time.Second
	UpgradingStale = 10 * time.Second
)

// MarkUpgrading writes upgrading.json and keeps it fresh until done is
// called, which removes it.
func MarkUpgrading(dir string) (done func()) {
	path := UpgradingPath(dir)
	b, _ := json.Marshal(Upgrading{PID: os.Getpid(), StartedAt: time.Now().UnixMilli()})
	_ = WriteFileAtomic(path, b, 0o600)
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		t := time.NewTicker(UpgradingBeat)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-t.C:
				_ = os.Chtimes(path, now, now)
			}
		}
	}()
	return func() {
		close(stop)
		<-stopped
		_ = os.Remove(path)
	}
}

func ReadUpgrading(dir string) (u Upgrading, ok bool) {
	path := UpgradingPath(dir)
	fi, err := os.Stat(path)
	if err != nil || time.Since(fi.ModTime()) >= UpgradingStale {
		return u, false
	}
	b, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(b, &u) != nil {
		return u, false
	}
	return u, true
}

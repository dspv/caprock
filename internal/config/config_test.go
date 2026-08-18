package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDataDirEnvOverride(t *testing.T) {
	t.Setenv(EnvDataDir, filepath.Join(t.TempDir(), "x"))
	dir, err := DataDir()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(dir) != "x" {
		t.Fatalf("got %s", dir)
	}
}

func TestLoadDefaultsAndRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg != Defaults() {
		t.Fatalf("expected defaults, got %+v", cfg)
	}
	cfg.Port = 5000
	cfg.LoopK = 7
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 5000 || got.LoopK != 7 || got.LoopTMinutes != 3 {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestLoadTolerantOfUnknownAndBadValues(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(ConfigPath(dir), []byte(`{"port":0,"loop_k":-1,"future_field":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != DefaultPort || cfg.LoopK != 5 {
		t.Fatalf("bad values not defaulted: %+v", cfg)
	}
}

func TestRuntimeLifecycle(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadRuntime(dir); err == nil {
		t.Fatal("expected error when runtime.json is absent")
	}
	rt, err := NewRuntime(4173, "test")
	if err != nil {
		t.Fatal(err)
	}
	if len(rt.Token) != 48 {
		t.Fatalf("token length %d", len(rt.Token))
	}
	if err := WriteRuntime(dir, rt); err != nil {
		t.Fatal(err)
	}
	got, err := ReadRuntime(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != rt.Token || got.Port != 4173 {
		t.Fatalf("mismatch: %+v", got)
	}
	if err := RemoveRuntime(dir); err != nil {
		t.Fatal(err)
	}
	if err := RemoveRuntime(dir); err != nil {
		t.Fatalf("second remove should be a no-op: %v", err)
	}
}

func TestWriteFileAtomicOverwrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	for _, s := range []string{"one", "two"} {
		if err := WriteFileAtomic(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(p)
	if string(b) != "two" {
		t.Fatalf("got %q", b)
	}
	if entries, _ := os.ReadDir(filepath.Dir(p)); len(entries) != 1 {
		t.Fatalf("temp files left behind: %d entries", len(entries))
	}
}

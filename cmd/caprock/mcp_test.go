package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

// `caprock mcp` end to end, as a client runs it: the daemon found through
// runtime.json in the data directory, the protocol on stdin/stdout, a tool
// answered from the daemon's API — and nothing on stdout but JSON-RPC.
func TestMCPCommandOverStdio(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	repo := filepath.Join(t.TempDir(), "acme")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, st.DB(), "s1", store.SessionPatch{Cwd: repo, Title: "Ship it", FromHook: true}); err != nil {
		t.Fatal(err)
	}
	tb, _ := cost.Embedded()
	srv := httptest.NewServer(api.New(api.Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test", Now: time.Now}))
	t.Cleanup(srv.Close)
	_, portS, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portS)

	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)
	if err := config.WriteRuntime(dir, config.Runtime{Port: port, Token: "t", PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	t.Chdir(repo)

	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"recent_sessions","arguments":{}}}`,
	}, "\r\n") + "\r\n"
	var out, errOut bytes.Buffer
	root := newRoot()
	root.SetArgs([]string{"mcp"})
	root.SetIn(strings.NewReader(in))
	root.SetOut(&out)
	root.SetErr(&errOut)
	if err := root.Execute(); err != nil {
		t.Fatalf("mcp: %v (%s)", err, errOut.String())
	}
	var res []map[string]any
	sc := bufio.NewScanner(&out)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("stdout carries something other than JSON-RPC: %q", sc.Text())
		}
		res = append(res, m)
	}
	if len(res) != 3 {
		t.Fatalf("%d responses, want 3: %s", len(res), out.String())
	}
	tools := res[1]["result"].(map[string]any)["tools"].([]any)
	names := map[string]bool{}
	for _, tl := range tools {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"search_memories", "recent_sessions", "session_prose", "cost", "ci_status", "loop_alerts"} {
		if !names[want] {
			t.Errorf("tools/list lacks %s", want)
		}
	}
	text := res[2]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, `"id":"s1"`) || !strings.Contains(text, "Ship it") {
		t.Errorf("recent_sessions from the server's directory: %s", text)
	}
}

// With no daemon, every call says how to start one instead of failing the
// protocol.
func TestMCPCommandWithoutADaemon(t *testing.T) {
	t.Setenv(config.EnvDataDir, t.TempDir())
	in := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"loop_alerts","arguments":{}}}` + "\n"
	var out bytes.Buffer
	root := newRoot()
	root.SetArgs([]string{"mcp"})
	root.SetIn(strings.NewReader(in))
	root.SetOut(&out)
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"isError":true`) || !strings.Contains(out.String(), "caprock up") {
		t.Errorf("answer %s", out.String())
	}
}

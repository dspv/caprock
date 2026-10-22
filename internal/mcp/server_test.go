package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func echoServer() *Server {
	return &Server{
		Name: "caprock", Version: "test", Instructions: "read-only",
		Tools: []Tool{
			{Name: "echo", Title: "Echo", Description: "Says it back.", Schema: obj(map[string]any{"say": str("what")}),
				Call: func(_ context.Context, args json.RawMessage) (any, error) {
					var a struct {
						Say string `json:"say"`
					}
					_ = json.Unmarshal(args, &a)
					if a.Say == "fail" {
						return nil, errors.New("asked to fail")
					}
					return map[string]string{"said": a.Say}, nil
				}},
			{Name: "big", Description: "Too much.", Schema: obj(map[string]any{}),
				Call: func(context.Context, json.RawMessage) (any, error) { return strings.Repeat("é", 100), nil }},
		},
		MaxText: 51,
	}
}

// serve runs the server over the given input and returns each response line,
// decoded.
func serve(t *testing.T, s *Server, input string) []map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	var res []map[string]any
	sc := bufio.NewScanner(&out)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if bytes.Contains(line, []byte("\r")) {
			t.Errorf("a response line carries a carriage return: %q", line)
		}
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("response is not one JSON object per line: %q", line)
		}
		res = append(res, m)
	}
	return res
}

// The session an MCP client opens: initialize, the initialized
// notification, tools/list, tools/call — with Windows line endings on some
// lines, a notification that must not be answered, and a ping.
func TestProtocolHandshakeListAndCall(t *testing.T) {
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}` + "\r",
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\r",
		`{"jsonrpc":"2.0","id":"three","method":"tools/call","params":{"name":"echo","arguments":{"say":"hi"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"say":"fail"}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}`,
		`{"jsonrpc":"2.0","id":6,"method":"ping"}`,
		``,
		`{"jsonrpc":"2.0","id":7,"method":"resources/subscribe"}`,
		`not json`,
		`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"big"}}`,
	}, "\n") + "\n"
	res := serve(t, echoServer(), in)
	if len(res) != 9 {
		t.Fatalf("%d responses, want 9 (the notification and the blank line get none): %v", len(res), res)
	}
	init := res[0]["result"].(map[string]any)
	if init["protocolVersion"] != "2025-06-18" {
		t.Errorf("protocol version %v, want the client's", init["protocolVersion"])
	}
	if init["serverInfo"].(map[string]any)["name"] != "caprock" || init["instructions"] != "read-only" {
		t.Errorf("initialize %v", init)
	}
	if _, ok := init["capabilities"].(map[string]any)["tools"]; !ok {
		t.Error("the tools capability is not declared")
	}

	tools := res[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("tools %v", tools)
	}
	echo := tools[0].(map[string]any)
	if echo["name"] != "echo" || echo["inputSchema"].(map[string]any)["type"] != "object" {
		t.Errorf("tool %v", echo)
	}
	if ann := echo["annotations"].(map[string]any); ann["readOnlyHint"] != true || ann["destructiveHint"] != false {
		t.Errorf("annotations %v", ann)
	}

	if res[2]["id"] != "three" {
		t.Errorf("a string id is echoed back: %v", res[2]["id"])
	}
	call := res[2]["result"].(map[string]any)
	if call["isError"] != nil || call["content"].([]any)[0].(map[string]any)["text"] != `{"said":"hi"}` {
		t.Errorf("call %v", call)
	}
	fail := res[3]["result"].(map[string]any)
	if fail["isError"] != true || !strings.Contains(fail["content"].([]any)[0].(map[string]any)["text"].(string), "asked to fail") {
		t.Errorf("a tool's failure is a result with isError: %v", res[3])
	}
	if e := res[4]["error"].(map[string]any); e["code"].(float64) != codeInvalidParams {
		t.Errorf("unknown tool %v", e)
	}
	if _, ok := res[5]["result"]; !ok {
		t.Errorf("ping %v", res[5])
	}
	if e := res[6]["error"].(map[string]any); e["code"].(float64) != codeMethodNotFound {
		t.Errorf("unknown method %v", e)
	}
	if e := res[7]["error"].(map[string]any); e["code"].(float64) != codeParse || res[7]["id"] != nil {
		t.Errorf("parse error %v", res[7])
	}
	big := res[8]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(big, "[cut at 51 bytes") || !strings.HasPrefix(big, strings.Repeat("é", 25)+"\n") {
		t.Errorf("the cap cuts on a rune boundary and says so: %q", big)
	}
}

func TestUnknownProtocolVersionGetsTheNewest(t *testing.T) {
	res := serve(t, echoServer(), `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`+"\n")
	if v := res[0]["result"].(map[string]any)["protocolVersion"]; v != protocolVersions[0] {
		t.Errorf("version %v", v)
	}
}

// A line longer than the cap is answered with a parse error, and the session
// goes on.
func TestOverlongLineIsAnsweredAndSkipped(t *testing.T) {
	long := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"` + strings.Repeat("a", maxLine) + `"}}`
	res := serve(t, echoServer(), long+"\n"+`{"jsonrpc":"2.0","id":2,"method":"ping"}`+"\n")
	if len(res) != 2 || res[0]["error"] == nil || res[1]["id"].(float64) != 2 {
		t.Fatalf("responses %v", res)
	}
}

// Input that ends without a newline is still read.
func TestLastLineWithoutNewline(t *testing.T) {
	res := serve(t, echoServer(), `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if len(res) != 1 {
		t.Fatalf("responses %v", res)
	}
}

func TestRedact(t *testing.T) {
	for _, s := range []string{
		"sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		"sk-proj-abcdefghijklmnopqrstuvwxyz",
		"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
		"xoxb-1234567890-abcdefghij",
		"AKIAQ3EGUKZ7FAKEFAKE",
		"AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
		"123456789:AAHdqTcvCH1v" + "GWJxfSeofSAs0K5PALDsawq",
		"sk_live_abcdefghijklmnop1234",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"Authorization: Bearer abcdefghijklmnopqrstuvwxyz.012345",
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
	} {
		got := Redact("before " + s + " after")
		if strings.Contains(got, s) || !strings.Contains(got, "[redacted: ") || !strings.HasPrefix(got, "before ") {
			t.Errorf("not redacted: %q", got)
		}
	}
	for _, s := range []string{"task-list-for-the-day", "a sketch of sk-", "commit 0123456789abcdef0123456789abcdef01234567"} {
		if Redact(s) != s {
			t.Errorf("ordinary text changed: %q -> %q", s, Redact(s))
		}
	}
}

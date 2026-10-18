// Package mcp is `caprock mcp`: a read-only Model Context Protocol server on
// stdio, so the user's own coding agents (Claude Code, Codex, any MCP client)
// can ask Caprock what it knows — Second Brain, recent sessions and the prose
// written in them, cost per repository and day, CI, loop alerts (ADR-078;
// contract in .ai/03-contracts.md § MCP server).
//
// It opens no listener. Each tool call is answered from the local daemon's
// loopback HTTP API, read-only (GET) endpoints only, and the answer is
// trimmed and passed through Redact before it reaches the agent. Nothing it
// exposes can type into a session, start or stop one, or change a setting.
//
// The protocol is JSON-RPC 2.0, one message per line (MCP's stdio transport):
// initialize, ping, tools/list and tools/call. The official Go SDK was not
// taken: four methods do not justify a dependency tree in a binary whose
// moat is being small (ADR-078).
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

// Protocol versions this server speaks. tools/list and tools/call are the
// same in each; a client asking for one of these is answered with it, any
// other with the newest.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// maxLine bounds one incoming message. Requests are small; a client that
// sends more is broken, and the line is answered with a parse error.
const maxLine = 4 << 20

// JSON-RPC error codes.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

// Tool is one tool the server offers.
type Tool struct {
	Name        string
	Title       string
	Description string
	// Schema is the JSON Schema of its arguments (an object).
	Schema map[string]any
	// OpenWorld says the answer may involve a service outside this computer
	// (GitHub, for CI), which the user switched on in Caprock.
	OpenWorld bool
	// Call answers it. A returned error is shown to the agent as the tool's
	// failure (isError), not as a protocol error.
	Call func(ctx context.Context, args json.RawMessage) (any, error)
}

// Server is an MCP server over one stream pair.
type Server struct {
	Name    string
	Version string
	// Instructions is the line a client may show its model about the server.
	Instructions string
	Tools        []Tool
	// MaxText bounds a tool result's text, in bytes; 0 is DefaultMaxText.
	MaxText int
}

// DefaultMaxText is the cap on one tool result's text: enough for a page of
// sessions or memories, small enough not to flood an agent's context.
const DefaultMaxText = 48 << 10

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Serve reads requests from in and writes responses to out until in ends or
// ctx is done. Requests are answered one at a time, in order; a notification
// (no id) is never answered.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	r := bufio.NewReaderSize(in, 64<<10)
	var mu sync.Mutex
	write := func(v response) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		// "\n" on every OS: the transport is newline-delimited, and a
		// Windows client splits on "\n" and trims a "\r" if one comes.
		_, err = out.Write(append(b, '\n'))
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		line, err := readLine(r)
		if len(bytes.TrimSpace(line)) > 0 {
			if resp, ok := s.handle(ctx, line); ok {
				if werr := write(resp); werr != nil {
					return werr
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// readLine reads one line without its "\n" or "\r\n". A line past maxLine is
// read to its end and returned as a lone "{", so it is answered with a parse
// error rather than ending the session.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	tooLong := false
	for {
		chunk, err := r.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > maxLine {
				tooLong, buf = true, nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if tooLong {
			return []byte("{"), err
		}
		return bytes.TrimRight(buf, "\r\n"), err
	}
}

func (s *Server) handle(ctx context.Context, line []byte) (response, bool) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{codeParse, "parse error"}}, true
	}
	notification := len(req.ID) == 0 || string(req.ID) == "null"
	if req.JSONRPC != "2.0" || req.Method == "" {
		if notification {
			return response{}, false
		}
		return response{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{codeInvalidRequest, "invalid request"}}, true
	}
	result, rerr := s.dispatch(ctx, req)
	if notification {
		return response{}, false
	}
	if rerr != nil {
		return response{JSONRPC: "2.0", ID: req.ID, Error: rerr}, true
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}, true
}

func (s *Server) dispatch(ctx context.Context, req request) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		v := protocolVersions[0]
		for _, known := range protocolVersions {
			if p.ProtocolVersion == known {
				v = known
			}
		}
		res := map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": s.Name, "title": "Caprock", "version": s.Version},
		}
		if s.Instructions != "" {
			res["instructions"] = s.Instructions
		}
		return res, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		list := make([]map[string]any, 0, len(s.Tools))
		for _, t := range s.Tools {
			list = append(list, map[string]any{
				"name":        t.Name,
				"title":       t.Title,
				"description": t.Description,
				"inputSchema": t.Schema,
				"annotations": map[string]any{
					"title":           t.Title,
					"readOnlyHint":    true,
					"destructiveHint": false,
					"idempotentHint":  true,
					"openWorldHint":   t.OpenWorld,
				},
			})
		}
		return map[string]any{"tools": list}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil || p.Name == "" {
			return nil, &rpcError{codeInvalidParams, "tools/call needs a tool name"}
		}
		for _, t := range s.Tools {
			if t.Name == p.Name {
				return s.call(ctx, t, p.Arguments), nil
			}
		}
		return nil, &rpcError{codeInvalidParams, "unknown tool: " + p.Name}
	case "resources/list":
		return map[string]any{"resources": []any{}}, nil
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	}
	if strings.HasPrefix(req.Method, "notifications/") {
		return map[string]any{}, nil
	}
	return nil, &rpcError{codeMethodNotFound, "method not found: " + req.Method}
}

// call runs a tool and shapes its answer as MCP content: one text block of
// compact JSON, redacted and bounded.
func (s *Server) call(ctx context.Context, t Tool, args json.RawMessage) map[string]any {
	if len(bytes.TrimSpace(args)) == 0 || string(bytes.TrimSpace(args)) == "null" {
		args = json.RawMessage("{}")
	}
	v, err := t.Call(ctx, args)
	if err != nil {
		return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": Redact(err.Error())}}}
	}
	var text string
	if str, ok := v.(string); ok {
		text = str
	} else {
		b, merr := json.Marshal(v)
		if merr != nil {
			return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": "could not encode the answer"}}}
		}
		text = string(b)
	}
	text = Redact(text)
	limit := s.MaxText
	if limit <= 0 {
		limit = DefaultMaxText
	}
	if len(text) > limit {
		text = clipBytes(text, limit) + fmt.Sprintf("\n[cut at %d bytes: ask for fewer items]", limit)
	}
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}
}

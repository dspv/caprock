package main

import (
	"context"
	"os"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/mcp"
	"github.com/dspv/caprock/internal/version"
)

// mcpInstructions is what a client may show its model about the server.
const mcpInstructions = "Caprock records every coding-agent session on this computer. " +
	"Use these read-only tools to recall earlier work: search_memories and next_session_handoff for decisions and findings kept in Second Brain, " +
	"recent_sessions, session_summary and session_prose for what sessions in this repository did and wrote, search_prose to find a past explanation, " +
	"cost for spend and tokens, ci_status for GitHub Actions, loop_alerts for sessions stuck repeating a tool call. " +
	"Memories and prose may be stale: check them against the code before relying on them."

// mcpCmd is `caprock mcp`: the read-only MCP server on stdio (ADR-078). The
// user's agent starts it — `claude mcp add caprock -- caprock mcp` — and it
// answers from the running daemon. Stdout carries the protocol and nothing
// else; it opens no listener of its own.
func mcpCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "mcp",
		Short: "Serve Caprock to your coding agents over MCP (stdio, read-only)",
		Long: "Runs a Model Context Protocol server on stdin/stdout, so Claude Code, Codex or any MCP\n" +
			"client can read what Caprock knows: Second Brain, recent sessions and their prose, cost per\n" +
			"repository, CI and loop alerts. Read-only: no tool types into a session, starts or stops one,\n" +
			"or changes a setting. It reads the running daemon over loopback and opens no port.\n\n" +
			"Add it to Claude Code:  claude mcp add caprock -- caprock mcp\n" +
			"Add it to Codex (~/.codex/config.toml):\n" +
			"  [mcp_servers.caprock]\n" +
			"  command = \"caprock\"\n" +
			"  args = [\"mcp\"]",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			// No signal handling: the read of stdin cannot be interrupted, and
			// the client ends the server by closing stdin or by a signal, whose
			// default action is the right one here.
			return runMCP(cmd.Context(), cmd)
		},
	}
}

func runMCP(ctx context.Context, cmd *cobra.Command) error {
	cwd, _ := os.Getwd()
	client := &mcp.Client{Base: mcp.RuntimeBase(config.DataDir)}
	srv := &mcp.Server{
		Name:         "caprock",
		Version:      version.Version,
		Instructions: mcpInstructions,
		Tools:        mcp.Tools(client, cwd),
	}
	return srv.Serve(ctx, cmd.InOrStdin(), cmd.OutOrStdout())
}

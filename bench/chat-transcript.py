#!/usr/bin/env python3
"""chat-transcript.py <home> [turns]
Writes one Claude Code transcript under <home>/.claude/projects/ for the
phone harness's chat-open timing: <turns> (default 150) user prompts, each
answered with a tool call, its result and a paragraph of text. The last
assistant message ends with "bench-last-message", which the harness waits
for. Prints the session id. Synthetic text, no model calls."""
import json, os, sys, uuid
from datetime import datetime, timedelta, timezone

home = sys.argv[1]
turns = int(sys.argv[2]) if len(sys.argv) > 2 else 150
sid = "be7c4000-0000-4000-8000-000000000001"
cwd = os.path.join(home, "chat-project")
os.makedirs(cwd, exist_ok=True)
folder = os.path.join(home, ".claude", "projects", "-" + cwd.strip("/").replace("/", "-"))
os.makedirs(folder, exist_ok=True)
t = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)
parent = None
lines = []


def add(kind, message, **extra):
    global parent, t
    t += timedelta(seconds=7)
    u = str(uuid.uuid4())
    row = {"isSidechain": False, "userType": "external", "entrypoint": "cli", "cwd": cwd, "sessionId": sid,
           "version": "2.1.221", "gitBranch": "main", "parentUuid": parent, "type": kind, "uuid": u,
           "timestamp": t.isoformat().replace("+00:00", "Z"), "message": message}
    row.update(extra)
    lines.append(json.dumps(row))
    parent = u


usage = {"input_tokens": 12, "output_tokens": 180, "cache_read_input_tokens": 20000, "cache_creation_input_tokens": 400}
body = ("The handler now retries with a capped backoff, and the test covers the third attempt. "
        "I kept the public signature as it was, so callers do not change; the only new type is `RetryPolicy`.\n\n"
        "- `sender.go`: the loop and the jitter\n- `sender_test.go`: three cases, one per outcome\n\n"
        "```go\nfor attempt := 0; attempt < p.Max; attempt++ {\n\tif err = send(ctx); err == nil {\n\t\treturn nil\n\t}\n}\n```")
for i in range(turns):
    add("user", {"role": "user", "content": f"Step {i + 1}: make the webhook sender retry, then show me the diff."}, promptId=f"p-{i}")
    tool_id = f"toolu_{i:05d}"
    add("assistant", {"model": "claude-sonnet-4-6", "id": f"msg-{i}-a", "type": "message", "role": "assistant",
                      "content": [{"type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": f"go test ./internal/sender/... -run TestRetry{i}"}}],
                      "usage": usage}, requestId=f"req-{i}-a")
    add("user", {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok  \tgithub.com/acme/app/internal/sender\t0.214s"}]})
    last = " bench-last-message" if i == turns - 1 else ""
    add("assistant", {"model": "claude-sonnet-4-6", "id": f"msg-{i}-b", "type": "message", "role": "assistant",
                      "content": [{"type": "text", "text": f"Done with step {i + 1}. " + body + last}], "usage": usage},
        requestId=f"req-{i}-b")

with open(os.path.join(folder, sid + ".jsonl"), "w") as f:
    f.write("\n".join(lines) + "\n")
print(sid)

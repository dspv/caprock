#!/usr/bin/env node
// Starts `caprock mcp` for the Caprock MCP bundle (caprock.mcpb), on every OS.
//
// The bundle carries no caprock of its own: a second copy would be unsigned
// and drift from the version the user's daemon runs. It finds the installed
// one in the order plugins/caprock/scripts/caprock-mcp (and .cmd) use: PATH,
// the app's own copy in Caprock's data directory, the app bundle on macOS,
// Homebrew, ~/.local/bin, Scoop and WinGet on Windows, then Go's bin. Node
// rather than those shell scripts because a client unpacking the bundle may
// drop the executable bit, and on Windows the extension folder holds a space
// that cmd quoting gets wrong. Nothing is downloaded and nothing is sent;
// with no caprock found it says where to get one, on stderr, and exits 1.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const win = process.platform === "win32";
const exe = win ? "caprock.exe" : "caprock";

function candidates(env, home) {
  const out = [];
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (dir) out.push(path.join(dir, exe));
  }
  if (env.CAPROCK_DATA_DIR) out.push(path.join(env.CAPROCK_DATA_DIR, "bin", exe));
  if (win) {
    if (env.APPDATA) out.push(path.join(env.APPDATA, "caprock", "bin", exe));
    if (env.SCOOP) out.push(path.join(env.SCOOP, "shims", exe));
    out.push(path.join(home, "scoop", "shims", exe));
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe));
  } else {
    const config = process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
    out.push(path.join(config, "caprock", "bin", exe));
    if (process.platform === "darwin") out.push("/Applications/Caprock.app/Contents/MacOS/caprock");
    out.push(
      "/opt/homebrew/bin/caprock",
      "/usr/local/bin/caprock",
      "/home/linuxbrew/.linuxbrew/bin/caprock",
      path.join(home, ".local", "bin", exe),
    );
  }
  if (env.GOBIN) out.push(path.join(env.GOBIN, exe));
  out.push(path.join(env.GOPATH || path.join(home, "go"), "bin", exe));
  return out;
}

function runnable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!win) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const found = candidates(process.env, os.homedir()).find(runnable);
if (!found) {
  process.stderr.write(
    "caprock: Caprock is not installed on this computer (or not where the bundle looks).\n" +
      "Install it from https://caprock.dev/install and open it once, then restart this app.\n" +
      "Installed somewhere else? Add the server by hand with the full path: https://github.com/dspv/caprock/blob/master/docs/mcp.md\n",
  );
  process.exit(1);
}

const child = spawn(found, ["mcp", ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (err) => {
  process.stderr.write(`caprock: could not start ${found}: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

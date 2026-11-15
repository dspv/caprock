#!/usr/bin/env python3
"""Builds caprock.mcpb and the server.json the MCP Registry gets, for one release.

    scripts/mcp-bundle.py vX.Y.Z OUTDIR

caprock.mcpb is an MCP bundle (github.com/modelcontextprotocol/mcpb): a zip of
mcpb/manifest.json, the launcher mcpb/server/index.js and the plugin's icon.
Claude Desktop installs it in one click; the launcher starts the caprock
already installed (docs/mcp.md). OUTDIR/server.json is mcpb/server.json with
the release's version, the bundle's download URL on that release and its
SHA-256, which is what `mcp-publisher publish` sends to the registry
(release.yml, job mcp-registry).

The versions in mcpb/ are placeholders: the tag is the only version, written
here into the copies, so no release step has to bump them. The zip is built
the same way every time (fixed dates and modes, sorted names), so the same
commit gives the same SHA-256.
"""
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "https://github.com/dspv/caprock"
NAME = "caprock.mcpb"


def read(path):
    with open(path, "rb") as f:
        return f.read()


def build(tag, out, root=ROOT):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise SystemExit(f"mcp-bundle: {tag!r} is not a stable release tag (vX.Y.Z)")
    version = tag[1:]
    src = os.path.join(root, "mcpb")
    with open(os.path.join(src, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["version"] = version
    files = {
        "manifest.json": (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode(),
        "server/index.js": read(os.path.join(src, "server", "index.js")),
        manifest["icon"]: read(os.path.join(root, "plugins", "caprock", ".claude-plugin", "icon.png")),
    }
    os.makedirs(out, exist_ok=True)
    bundle = os.path.join(out, NAME)
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])
    sha = hashlib.sha256(read(bundle)).hexdigest()

    with open(os.path.join(src, "server.json"), encoding="utf-8") as f:
        server = json.load(f)
    server["version"] = version
    (pkg,) = server["packages"]
    pkg["identifier"] = f"{REPO}/releases/download/{tag}/{NAME}"
    pkg["fileSha256"] = sha
    with open(os.path.join(out, "server.json"), "w", encoding="utf-8") as f:
        f.write(json.dumps(server, indent=2) + "\n")
    return bundle, sha


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__.split("\n\n")[1])
    path, digest = build(sys.argv[1], sys.argv[2])
    print(f"{path}  sha256 {digest}")

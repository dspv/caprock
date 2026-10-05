// Package version exposes the build-time version string stamped via -ldflags.
package version

// Version is set at build time: -X github.com/dspv/caprock/internal/version.Version=v0.1.0
var Version = "dev"

// APILevel is the HTTP and WebSocket API's level, reported in GET /v1/status
// and runtime.json. It is an integer raised by every change a client must know
// about — a new endpoint or frame a client depends on, or a changed shape —
// and never lowered. A client (the desktop app, a bundled UI) declares the
// minimum it needs and treats a lower daemon as one that needs an upgrade,
// rather than guessing from a version string that a `git describe` build does
// not even carry as semver.
//
// History: 1 — the level itself (the desktop app's first daemon).
const APILevel = 1

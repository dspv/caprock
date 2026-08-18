// Package version exposes the build-time version string stamped via -ldflags.
package version

// Version is set at build time: -X github.com/dspv/caprock/internal/version.Version=v0.1.0
var Version = "dev"

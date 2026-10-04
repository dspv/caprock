package api

import (
	"context"
	"path/filepath"

	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/store"
)

// What a phone holding the controller role may ask of POST /v1/agents
// (ADR-034).
//
// The gate lets a controller reach the route; this narrows what the body may
// say. The machine's own dashboard can start any binary in any folder, because
// whoever sits at it already can. A phone is a remote keyboard, and its token
// is a bearer secret that could be copied off it — so it starts one of the
// coding agents Caprock knows how to launch, in a folder where sessions have
// already run, and nothing else.

// spawnFieldsAControllerMayNotSet are the request fields that turn "start an
// agent" into "run something": an arbitrary binary, arbitrary flags, a folder
// made from nothing, or a scratch folder outside every project.
var spawnFieldsAControllerMayNotSet = []string{"command", "args", "create", "chat"}

// controllerSpawnRefusal returns why a paired controller may not make this
// spawn request, or "" when it may.
func (s *Server) controllerSpawnRefusal(ctx context.Context, req map[string]any) string {
	for _, k := range spawnFieldsAControllerMayNotSet {
		if v, ok := req[k]; ok && !isZero(v) {
			return "a phone starts one of the coding agents Caprock knows, not " + k + " — set that up on the machine Caprock runs on"
		}
	}
	cwd, _ := req["cwd"].(string)
	if cwd == "" || !filepath.IsAbs(cwd) {
		return "pick one of your projects to start the session in"
	}
	known, err := store.KnownDir(ctx, s.d.Store.DB(), filepath.Clean(cwd))
	if err != nil || !known {
		return "a phone starts sessions only in folders where sessions have already run — start the first one on the machine Caprock runs on"
	}
	return ""
}

// isZero reports whether a decoded JSON value is its type's zero: a field
// sent as false, "" or [] asks for nothing and is not refused.
func isZero(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case bool:
		return !x
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return false
}

// stillControls reports whether the device holding token may still type into
// a terminal. A socket stays open for as long as the phone keeps the page, so
// the role is asked again for every frame rather than trusted from the
// handshake: taking control away, revoking the device or switching network
// access off all stop the next keystroke.
func (s *Server) stillControls(token string) bool {
	ps, _ := s.lanState()
	return ps != nil && ps.RoleOf(token) == pairing.RoleController
}

package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/store"
)

// What a phone holding the controller role may ask of POST /v1/agents
// (ADR-034).
//
// The gate lets a controller reach the route; this narrows what the body may
// say. The machine's own dashboard can start any binary in any folder, because
// whoever sits at it already can. A phone is for working away from the desk,
// so it starts one of the coding agents Caprock knows how to launch, in any
// mode, in any folder under the home directory (or one where sessions have
// already run), making that folder one level deep if asked — and nothing
// else: no binary or flags of its own, no path outside home.
//
// Bypass mode is allowed (owner decision, ADR-034): a controller can already
// run any command by typing `!cmd` into a session, so refusing the mode added
// friction, not a boundary. The boundary is who holds the role — granted only
// from the machine, taken away there in one click, reachable only on the
// owner's own network.

// spawnFieldsAControllerMayNotSet are the request fields that turn "start an
// agent" into "run something": an arbitrary binary, arbitrary flags, or a
// scratch folder outside every project.
var spawnFieldsAControllerMayNotSet = []string{"command", "args", "chat"}

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
		return "pick a folder to start the session in"
	}
	cwd = filepath.Clean(cwd)
	if known, err := store.KnownDir(ctx, s.d.Store.DB(), cwd); err == nil && known {
		return ""
	}
	create, _ := req["create"].(bool)
	if !underHome(cwd, create) {
		return "a phone starts sessions in folders under your home directory"
	}
	return ""
}

// underHome reports whether dir, with every symlink resolved, is the home
// directory or inside it. A dir that does not exist yet passes only when
// create is set and its parent is inside home, the one level makeProjectDir
// will make. Resolving first is what stops ~/link-to-etc passing as ~.
func underHome(dir string, create bool) bool {
	home := homeRoot()
	if home == "" {
		return false
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		if !create || !os.IsNotExist(err) {
			return false
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(dir))
		if err != nil {
			return false
		}
		real = filepath.Join(parent, filepath.Base(dir))
	}
	return within(home, real)
}

// homeRoot is the user's home directory with symlinks resolved, or "" when
// there is none.
func homeRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(home); err == nil {
		return real
	}
	return ""
}

// within reports whether path is root or below it. Both must be resolved.
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// deviceBrowseRoot is where a controller's folder picker is rooted: the
// owner's browse root when it lies inside home, home otherwise. The machine's
// own picker may be rooted anywhere; a phone's never leaves home.
func (s *Server) deviceBrowseRoot() string {
	home := homeRoot()
	if root := s.browseRoot(); home != "" && within(home, root) {
		return root
	}
	return home
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

package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenCode 2's background service, and its stream.
//
// OpenCode 1's TUI ran its own server; OpenCode 2's connects to one shared
// background service (`opencode service`, started on first use) unless it is
// told `--standalone`. The service writes where it listens and the password it
// requires to `~/.local/state/opencode/service.json` — measured on 2.0.26:
//
//	{"id":"…","version":"2.0.26","url":"http://127.0.0.1:49374","pid":76596,"password":"…"}
//
// Its event stream is `GET /api/event` with HTTP basic auth, user `opencode`
// (any other user is refused with 401), and each frame is
// `{"id","created","type","data":{"sessionID",…}}` rather than OpenCode 1's
// `{"type","properties"}`. As for OpenCode 1, an event is a signal to re-read
// the session from the database, never a source of figures.

// serviceFile is the part of service.json the stream needs.
type serviceFile struct {
	URL      string `json:"url"`
	Password string `json:"password"`
}

// statePath is OpenCode's state directory: XDG_STATE_HOME when set, otherwise
// ~/.local/state — on every platform, as for the data directory (dataDirsFor).
func statePath(getenv func(string) string, home string) string {
	if x := getenv("XDG_STATE_HOME"); x != "" {
		return filepath.Join(x, "opencode")
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "state", "opencode")
}

// readService reads the running service's address and password, or reports
// that there is none.
func readService(path string) (serviceFile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return serviceFile{}, err
	}
	var s serviceFile
	if err := json.Unmarshal(b, &s); err != nil {
		return serviceFile{}, err
	}
	if s.URL == "" {
		return serviceFile{}, errors.New("opencode service: no url")
	}
	return s, nil
}

// ServiceStreamer follows OpenCode 2's background service.
type ServiceStreamer struct {
	file string
	log  *slog.Logger
	http *http.Client
}

// NewServiceStreamer builds a streamer for the service this user's OpenCode 2
// would connect to. It finds nothing to follow on a machine without OpenCode
// 2, which is the normal case, and keeps looking with backoff.
func NewServiceStreamer(log *slog.Logger) *ServiceStreamer {
	home, _ := os.UserHomeDir()
	dir := statePath(os.Getenv, home)
	file := ""
	if dir != "" {
		file = filepath.Join(dir, "service.json")
	}
	return &ServiceStreamer{file: file, log: log, http: &http.Client{}}
}

// v2Changed is the narrow set of OpenCode 2 events that mean a session's
// stored state moved, read off a live stream on 2.0.26: a session made or
// renamed, a model step finished (its cost is now in the database), and a run
// ending however it ended. The rest — text deltas, tool progress, catalog
// updates — would re-read a session for nothing.
func v2Changed(t string) bool {
	switch t {
	case "session.created", "session.renamed", "session.step.ended",
		"session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
		return true
	default:
		return false
	}
}

// v2Event is the envelope of an OpenCode 2 frame.
type v2Event struct {
	Type string `json:"type"`
	Data struct {
		SessionID string `json:"sessionID"`
	} `json:"data"`
}

// sessionOfV2 reads the session a frame names, when it is one to act on.
func sessionOfV2(payload []byte) string {
	var ev v2Event
	if json.Unmarshal(payload, &ev) != nil || !v2Changed(ev.Type) {
		return ""
	}
	return ev.Data.SessionID
}

// Run follows the service until ctx ends. The file is read again before every
// connection, because the service can be restarted with a new password, and
// a missing file is the normal case on a machine that does not run OpenCode 2.
func (s *ServiceStreamer) Run(ctx context.Context, onChange func(sessionID string)) {
	if s.file == "" {
		return
	}
	backoff := time.Second
	for {
		svc, err := readService(s.file)
		if err == nil {
			err = followSSE(ctx, s.http, strings.TrimRight(svc.URL, "/")+"/api/event",
				func(r *http.Request) { r.SetBasicAuth("opencode", svc.Password) },
				sessionOfV2, onChange, s.log)
		}
		if err != nil && ctx.Err() == nil {
			s.log.Debug("opencode service stream ended", "component", "opencode", "err", err)
		}
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

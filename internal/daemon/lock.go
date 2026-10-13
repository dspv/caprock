package daemon

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// One daemon per data directory. The port's bind used to be the only lock,
// and it is no lock at all for a second daemon started on another port (a
// stale config, `--port`, a launchd job and a Homebrew one disagreeing): two
// daemons on one database record every transcript line twice and fight over
// the terminal holders. So the daemon holds an exclusive advisory lock on
// <data_dir>/caprock.lock for its whole life — flock on macOS and Linux,
// LockFileEx on Windows. The OS drops it when the process exits, however it
// exits, so a crash never leaves a stale lock behind; the file itself stays.
// Go opens files close-on-exec, so the holders a daemon starts never inherit
// it.

// LockFileName is the lock's file in the data directory.
const LockFileName = "caprock.lock"

// lockWait is how long a starting daemon waits for the lock before giving
// up: long enough for a restart (the app's supervisor, a login service, an
// update) to let the old daemon finish closing, short enough that `caprock
// up` still reports a real duplicate promptly.
var lockWait = 5 * time.Second

// errLocked is another process holding the lock.
var errLocked = errors.New("locked by another process")

// AlreadyRunningError is a second daemon refusing to start.
type AlreadyRunningError struct {
	DataDir string
	PID     int // 0 when neither runtime.json nor the lock file names it
}

func (e *AlreadyRunningError) Error() string {
	who := "another Caprock daemon"
	if e.PID > 0 {
		who = fmt.Sprintf("another Caprock daemon (pid %d)", e.PID)
	}
	return fmt.Sprintf("%s is already running for this data directory (%s); `caprock status` shows it and `caprock down` stops it", who, e.DataDir)
}

// acquireDataDirLock takes the lock, waiting up to lockWait. A filesystem
// that cannot lock at all (some network shares) is logged and let through:
// refusing to start there would turn a missing safeguard into an outage.
func acquireDataDirLock(dir string, log *slog.Logger) (release func(), err error) {
	path := filepath.Join(dir, LockFileName)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		log.Warn("cannot open the data directory lock; running without it", "component", "daemon", "path", path, "err", err)
		return func() {}, nil
	}
	deadline := time.Now().Add(lockWait)
	for {
		err = tryLock(f)
		if err == nil {
			break
		}
		if !errors.Is(err, errLocked) {
			_ = f.Close()
			log.Warn("cannot lock the data directory; running without the lock", "component", "daemon", "path", path, "err", err)
			return func() {}, nil
		}
		if time.Now().After(deadline) {
			_ = f.Close()
			return nil, &AlreadyRunningError{DataDir: dir, PID: lockHolderPID(dir)}
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Our pid, for the message a second daemon prints when runtime.json is
	// missing. Best-effort: the lock is what matters.
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = unlockFile(f)
			_ = f.Close()
		})
	}, nil
}

// lockHolderPID names the daemon holding the lock: runtime.json's pid, else
// the pid the holder wrote into the lock file.
func lockHolderPID(dir string) int {
	if rt, err := config.ReadRuntime(dir); err == nil && rt.PID > 0 {
		return rt.PID
	}
	if b, err := os.ReadFile(filepath.Join(dir, LockFileName)); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

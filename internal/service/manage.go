package service

// This file is the only place that shells out to a platform tool. Everything
// above it is pure file generation, which is why the tests can cover all three
// platforms from one machine while these three functions are exercised only on
// the OS they belong to.

// Load registers the written definition with the platform supervisor and starts
// it. It is idempotent: re-loading an already-loaded service replaces the
// registration rather than duplicating it.
//
// On Windows there is nothing to load — the file in the Startup folder *is* the
// registration — so this is a no-op and the caller says so.
func (p Plan) Load(path string) error {
	switch p.os() {
	case "darwin":
		return darwinLoad(path)
	case "linux":
		return linuxLoad()
	case "windows":
		return nil
	default:
		_, err := p.Path()
		return err
	}
}

// Unload deregisters the service. It never fails because the service was not
// registered — that is the clean no-op uninstall promises.
func (p Plan) Unload() error {
	switch p.os() {
	case "darwin":
		return darwinUnload()
	case "linux":
		return linuxUnload()
	default:
		return nil
	}
}

// Registered asks the supervisor — not the filesystem — whether the service will
// start at the next login. The two can disagree: a plist deleted by hand stays
// loaded until logout, and a unit file can exist without ever being enabled.
// `service status` reports both, which is what makes a half-installed state
// visible instead of confusing.
func (p Plan) Registered() bool {
	switch p.os() {
	case "darwin":
		return darwinRegistered()
	case "linux":
		return linuxRegistered()
	case "windows":
		path, err := p.Path()
		if err != nil {
			return false
		}
		return windowsRegistered(path)
	default:
		return false
	}
}

// Supported reports whether this OS has a mechanism at all, so callers can fail
// with the actionable message instead of writing a file nothing will read.
func (p Plan) Supported() bool {
	switch p.os() {
	case "darwin", "linux", "windows":
		return true
	default:
		return false
	}
}

// Mechanism names what is used on this platform, for the status output.
func (p Plan) Mechanism() string {
	switch p.os() {
	case "darwin":
		return "launchd user agent"
	case "linux":
		return "systemd user unit"
	case "windows":
		return "Startup-folder logon script"
	default:
		return "unsupported"
	}
}

// PreflightErr returns a non-nil, actionable error when the platform mechanism
// exists in principle but cannot be used on this machine — today only the
// missing-systemd case. Checked before anything is written, so a machine
// without a systemd user session does not end up with a unit file that nothing
// will ever read.
func (p Plan) PreflightErr() error {
	if p.os() == "linux" && !haveSystemdUser() {
		return errNoSystemd
	}
	return nil
}

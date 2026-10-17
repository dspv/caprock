package daemon

import (
	"strings"

	"github.com/dspv/caprock/internal/config"
)

// adminAdapter keeps the admin key that opens private modules (ADR-076).
// The API verifies it; this only reads and stores it.
type adminAdapter struct{ d *Daemon }

func (a *adminAdapter) AdminKey() string { return a.d.config().AdminKey }

func (a *adminAdapter) SetAdminKey(key string) error {
	a.d.cfgMu.Lock()
	a.d.opt.Config.AdminKey = strings.TrimSpace(key)
	cfg := a.d.opt.Config
	a.d.cfgMu.Unlock()
	return config.Save(a.d.opt.DataDir, cfg)
}

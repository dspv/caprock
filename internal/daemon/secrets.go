package daemon

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/secret"
)

// The two credentials the daemon keeps besides the GitHub token, where that
// token is kept (ADR-024 amendment): the macOS login keychain, or a 0600 file
// in the data directory. Never config.json, the database or a log.
var (
	deepSeekSecret = secret.Item{Service: "dev.caprock.deepseek", Label: "Caprock DeepSeek API key", File: "deepseek-api-key", Noun: "key"}
	telegramSecret = secret.Item{Service: "dev.caprock.telegram", Label: "Caprock Telegram bot token", File: "telegram-bot-token", Noun: "token"}
)

// secretStores builds each item's store once.
type secretStores struct {
	mu   sync.Mutex
	home *string
	m    map[string]secret.Store
}

// secretStore is where item is kept. Options.Secrets replaces it in tests;
// otherwise it is internal/secret's choice for this OS (CAPROCK_SECRET_STORE
// =file forces the file, as every daemon test does).
func (d *Daemon) secretStore(item secret.Item) secret.Store {
	if d.opt.Secrets != nil {
		return d.opt.Secrets(item)
	}
	s := &d.secrets
	s.mu.Lock()
	defer s.mu.Unlock()
	if st, ok := s.m[item.Service]; ok {
		return st
	}
	if s.home == nil {
		h := secret.UserHome(context.Background())
		s.home = &h
	}
	if s.m == nil {
		s.m = map[string]secret.Store{}
	}
	st := secret.Default(d.opt.DataDir, item, *s.home)
	s.m[item.Service] = st
	return st
}

// loadSecrets runs once at start. A value an older release left in
// config.json is moved to the store and removed from the file (one atomic
// write); then the in-memory copies are read from the store, which is asked
// only when config.json says something was put there.
func (d *Daemon) loadSecrets(ctx context.Context) {
	d.cfgMu.Lock()
	cfg := d.opt.Config
	d.cfgMu.Unlock()
	moved := false
	migrate := func(item secret.Item, legacy string, apply func(c *config.Config, v string)) {
		v := strings.TrimSpace(legacy)
		if v == "" {
			return
		}
		if err := d.secretStore(item).Set(ctx, v); err != nil {
			// Left where it was, and still used: a start must not lose a key.
			d.log.Warn("could not move a credential out of config.json; it stays there for now", "component", "secrets", "item", item.Service, "err", err)
			return
		}
		apply(&cfg, v)
		moved = true
		d.log.Info("moved a credential from config.json to the secret store", "component", "secrets", "item", item.Service, "store", d.secretStore(item).Kind())
	}
	migrate(deepSeekSecret, cfg.LegacyDeepSeekAPIKey, func(c *config.Config, v string) {
		c.LegacyDeepSeekAPIKey, c.DeepSeekAPIKey, c.DeepSeekKeyStored = "", v, true
	})
	migrate(telegramSecret, cfg.LegacyReportBotToken, func(c *config.Config, v string) {
		c.LegacyReportBotToken, c.ReportBotToken, c.ReportBotStored = "", v, true
	})
	if moved {
		if err := config.Save(d.opt.DataDir, cfg); err != nil {
			d.log.Warn("could not rewrite config.json after moving credentials", "component", "secrets", "err", err)
		}
	}
	// Still in config.json (the move failed): used from there until it works.
	if cfg.DeepSeekAPIKey == "" && cfg.LegacyDeepSeekAPIKey != "" {
		cfg.DeepSeekAPIKey = strings.TrimSpace(cfg.LegacyDeepSeekAPIKey)
	}
	if cfg.ReportBotToken == "" && cfg.LegacyReportBotToken != "" {
		cfg.ReportBotToken = strings.TrimSpace(cfg.LegacyReportBotToken)
	}
	read := func(item secret.Item, stored bool, cur string) string {
		if !stored || cur != "" {
			return cur
		}
		v, err := d.secretStore(item).Get(ctx)
		if err != nil {
			d.log.Warn("could not read a stored credential", "component", "secrets", "item", item.Service, "err", err)
		}
		return v
	}
	cfg.DeepSeekAPIKey = read(deepSeekSecret, cfg.DeepSeekKeyStored, cfg.DeepSeekAPIKey)
	cfg.ReportBotToken = read(telegramSecret, cfg.ReportBotStored, cfg.ReportBotToken)
	d.cfgMu.Lock()
	d.opt.Config.LegacyDeepSeekAPIKey, d.opt.Config.DeepSeekAPIKey, d.opt.Config.DeepSeekKeyStored = cfg.LegacyDeepSeekAPIKey, cfg.DeepSeekAPIKey, cfg.DeepSeekKeyStored
	d.opt.Config.LegacyReportBotToken, d.opt.Config.ReportBotToken, d.opt.Config.ReportBotStored = cfg.LegacyReportBotToken, cfg.ReportBotToken, cfg.ReportBotStored
	d.cfgMu.Unlock()
}

// putSecret writes or (for "") deletes item in its store. Called before the
// in-memory copy and config.json change, so a refusal changes nothing.
func (d *Daemon) putSecret(ctx context.Context, item secret.Item, v string) error {
	st := d.secretStore(item)
	if v == "" {
		return st.Delete(ctx)
	}
	return st.Set(ctx, v)
}

// applySecret records v as item's value in c after putSecret succeeded:
// the in-memory copy, the "stored" mark, and no copy left in config.json.
func applySecret(c *config.Config, item secret.Item, v string) {
	switch item.Service {
	case deepSeekSecret.Service:
		c.DeepSeekAPIKey, c.DeepSeekKeyStored, c.LegacyDeepSeekAPIKey = v, v != "", ""
	case telegramSecret.Service:
		c.ReportBotToken, c.ReportBotStored, c.LegacyReportBotToken = v, v != "", ""
	}
}

// deepSeekKey is the DeepSeek key for a session starting now, read from the
// store (ADR-024 amendment): a key removed in Keychain Access is gone here
// too. A daemon whose config never recorded a stored key uses its in-memory
// copy (one the move out of config.json could not place, or a test's).
func (d *Daemon) deepSeekKey(ctx context.Context) (string, error) {
	cfg := d.config()
	if !cfg.DeepSeekKeyStored {
		return strings.TrimSpace(cfg.DeepSeekAPIKey), nil
	}
	v, err := d.secretStore(deepSeekSecret).Get(ctx)
	if err != nil {
		return "", errors.New("could not read the DeepSeek key from the " + d.secretStore(deepSeekSecret).Kind() + ": " + err.Error())
	}
	return strings.TrimSpace(v), nil
}

// secretWhere says where item is kept, for Settings; nil when not set.
func (d *Daemon) secretWhere(item secret.Item, set, stored bool) *secret.Where {
	if !set {
		return nil
	}
	if !stored {
		// The move out of config.json has not worked yet: say so.
		return &secret.Where{Kind: "config", Path: config.ConfigPath(d.opt.DataDir)}
	}
	w := secret.Locate(d.secretStore(item))
	return &w
}

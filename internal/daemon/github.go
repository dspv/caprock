package daemon

import (
	"context"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/github"
	"github.com/dspv/caprock/internal/userenv"
)

// Test-only overrides for the GitHub integration, read from the environment
// so a throwaway daemon can be pointed at a fake GitHub. Each is honoured
// only for a loopback address, so no setting can send the token to another
// host. A throwaway daemon also sets CAPROCK_SECRET_STORE=file
// (github.EnvSecretStore) so it never touches a keychain.
const (
	envTestGitHubAPI = "CAPROCK_TEST_GITHUB_API"
	envTestGitHubWeb = "CAPROCK_TEST_GITHUB_WEB"
	envTestGH        = "CAPROCK_TEST_GH"
)

// loopbackURL reports whether u is http(s) on a loopback address.
func loopbackURL(u string) bool {
	p, err := url.Parse(u)
	if err != nil || (p.Scheme != "http" && p.Scheme != "https") {
		return false
	}
	h := p.Hostname()
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// newGitHub builds the GitHub integration (ADR-039). It sends nothing until
// the user connects a source.
func (d *Daemon) newGitHub() *github.Service {
	gh := github.GHCLI{Env: func() []string { return userenv.Environ(d.log) }}
	s := &github.Service{Config: &githubConfig{d: d}, Bus: d.bus, Log: d.log}
	if v := os.Getenv(envTestGitHubAPI); v != "" && loopbackURL(v) {
		s.API = strings.TrimRight(v, "/")
		d.log.Warn("github: test API in use", "component", "github", "api", s.API)
		if w := os.Getenv(envTestGitHubWeb); w != "" && loopbackURL(w) {
			s.Web = strings.TrimRight(w, "/")
		}
		if b := os.Getenv(envTestGH); b != "" {
			gh.Bin = b
		}
	}
	s.GH = gh
	s.Store = github.DefaultStore(d.opt.DataDir, github.KeychainService, github.UserHome(context.Background()))
	if d.projs != nil {
		s.Projects = d.projs
	}
	return s
}

// githubConfig keeps the GitHub choices in config.json.
type githubConfig struct{ d *Daemon }

func (g *githubConfig) Source() string   { return g.d.config().GitHubSource }
func (g *githubConfig) ClientID() string { return strings.TrimSpace(g.d.config().GitHubClientID) }
func (g *githubConfig) Notify() bool     { return g.d.config().GitHubNotifyOn() }

func (g *githubConfig) SetSource(src string) error {
	return g.save(func(c *config.Config) { c.GitHubSource = src })
}

func (g *githubConfig) SetNotify(on bool) error {
	return g.save(func(c *config.Config) { c.GitHubNotify = &on })
}

func (g *githubConfig) save(change func(*config.Config)) error {
	g.d.cfgMu.Lock()
	change(&g.d.opt.Config)
	cfg := g.d.opt.Config
	g.d.cfgMu.Unlock()
	if g.d.opt.DataDir == "" {
		return nil
	}
	return config.Save(g.d.opt.DataDir, cfg)
}

// startGitHub starts following pull requests; idle until connected.
func (d *Daemon) startGitHub(ctx context.Context) {
	d.gh = d.newGitHub()
	d.gh.Start(ctx)
}

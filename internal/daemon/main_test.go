package daemon

import (
	"os"
	"testing"

	"github.com/dspv/caprock/internal/github"
)

// A daemon under test keeps any GitHub token in a file: no test touches a
// keychain.
func TestMain(m *testing.M) {
	_ = os.Setenv(github.EnvSecretStore, "file")
	os.Exit(m.Run())
}

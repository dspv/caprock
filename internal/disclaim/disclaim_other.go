//go:build !darwin

package disclaim

import "errors"

const supported = false

// execDisclaimed is never reached off macOS: Wrap leaves commands alone there,
// so nothing starts the trampoline.
func execDisclaimed(string, []string, []string) error {
	return errors.New("only macOS has a responsible process to disclaim")
}

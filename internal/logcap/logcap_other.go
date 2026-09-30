//go:build !unix

package logcap

import "os"

// Windows services log through the service manager, and a process cannot
// swap its standard handles under a writer the way dup2 does.
const supported = false

func pathOf(os.FileInfo) (string, bool) { return "", false }

func redirect(*os.File) error { return nil }

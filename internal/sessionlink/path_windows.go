//go:build windows

package sessionlink

import "strings"

// Windows paths are case-insensitive: C:\Dev\x and c:\dev\x are one folder.
func samePath(a, b string) bool { return strings.EqualFold(a, b) }

package api

import "github.com/dspv/caprock/internal/tcc"

// protectedDir reports whether reading dir would make macOS ask the user for
// access (tcc.Guarded: Desktop, Documents, Downloads, iCloud and cloud
// storage, Music, Movies, Pictures, /Volumes, and links into any of them).
// Background reads skip such a directory; a read the user asked for (opening
// the session) does not. The owner was asked for Documents and Downloads on
// opening the dashboard, because the Projects panel ran git in old Codex
// sessions' folders (2026-10-07).
func protectedDir(dir string) bool { return tcc.Guarded(dir) }

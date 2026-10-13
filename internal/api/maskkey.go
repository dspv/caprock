package api

// MaskKey is how Settings names a stored key without revealing it: its first
// three and last four characters ("sk-…1a2b"), enough to tell two keys apart
// and nowhere near enough to use one. A key too short for that to hide most
// of it is shown as "…" alone; no key is "".
func MaskKey(k string) string {
	r := []rune(k)
	switch {
	case len(r) == 0:
		return ""
	case len(r) < 16:
		return "…"
	}
	return string(r[:3]) + "…" + string(r[len(r)-4:])
}

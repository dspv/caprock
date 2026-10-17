package browser

import "strings"

// The Windows side's pure half: what a StartMenuInternet client says, turned
// into the list. Kept free of build tags so its tests run on every OS; the
// registry reads are in browser_windows.go.

// Client is one key under Clients\StartMenuInternet.
type Client struct {
	// Key is the subkey's name ("Google Chrome", "FIREFOX.EXE").
	Key string
	// Name is its display name: the key's default value or its
	// Capabilities\ApplicationName.
	Name string
	// Command is shell\open\command's default value.
	Command string
	// HTTPSProgID is Capabilities\URLAssociations' https value.
	HTTPSProgID string
}

// FromClients turns the clients into the list: one per key (the first seen,
// so HKCU before HKLM), with an executable, the one whose https ProgId is the
// user's choice marked default.
func FromClients(cs []Client, defProgID string) []Browser {
	var out []Browser
	seen := map[string]bool{}
	for _, c := range cs {
		k := strings.ToLower(c.Key)
		if c.Key == "" || seen[k] {
			continue
		}
		exe := ExeFromCommand(c.Command)
		if exe == "" {
			continue
		}
		seen[k] = true
		name := c.Name
		if name == "" || strings.HasPrefix(name, "@") {
			name = c.Key
		}
		out = append(out, Browser{
			ID: c.Key, Name: name, app: exe,
			Default: defProgID != "" && strings.EqualFold(c.HTTPSProgID, defProgID),
		})
	}
	return out
}

// ExeFromCommand is the executable of a registry command line: the quoted
// first word, or the text up to ".exe" when it is not quoted. "" when there
// is none.
func ExeFromCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if strings.HasPrefix(cmd, `"`) {
		end := strings.Index(cmd[1:], `"`)
		if end < 0 {
			return ""
		}
		return cmd[1 : 1+end]
	}
	low := strings.ToLower(cmd)
	if i := strings.Index(low, ".exe"); i >= 0 {
		return cmd[:i+4]
	}
	return ""
}

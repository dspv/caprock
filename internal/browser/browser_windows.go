//go:build windows

package browser

import (
	"os"

	"golang.org/x/sys/windows/registry"
)

// The registry's StartMenuInternet clients (the list Windows' own Default
// apps settings shows for "Web browser"), the user's own before the
// machine's, and the default from the https UserChoice.
const (
	clientsKey   = `SOFTWARE\Clients\StartMenuInternet`
	clientsKey32 = `SOFTWARE\WOW6432Node\Clients\StartMenuInternet`
	userChoice   = `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`
)

// DetectHere lists the browsers installed, the default one marked.
func DetectHere([]string) []Browser {
	var cs []Client
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, path := range []string{clientsKey, clientsKey32} {
			cs = append(cs, readClients(root, path)...)
		}
	}
	def := ""
	if k, err := registry.OpenKey(registry.CURRENT_USER, userChoice, registry.QUERY_VALUE); err == nil {
		def = str(k, "ProgId")
		k.Close()
	}
	out := FromClients(cs, def)
	// A client whose executable is gone (an uninstall that left its key).
	kept := out[:0]
	for _, b := range out {
		if st, err := os.Stat(b.app); err == nil && !st.IsDir() {
			kept = append(kept, b)
		}
	}
	return kept
}

func readClients(root registry.Key, path string) []Client {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return nil
	}
	defer k.Close()
	names, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil
	}
	var out []Client
	for _, n := range names {
		c := Client{Key: n}
		c.Name = sub(root, path+`\`+n, "")
		if c.Name == "" {
			c.Name = sub(root, path+`\`+n+`\Capabilities`, "ApplicationName")
		}
		c.Command = sub(root, path+`\`+n+`\shell\open\command`, "")
		c.HTTPSProgID = sub(root, path+`\`+n+`\Capabilities\URLAssociations`, "https")
		out = append(out, c)
	}
	return out
}

func sub(root registry.Key, path, value string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	return str(k, value)
}

// str reads a string value, expanding %VARS% in an expandable one.
func str(k registry.Key, value string) string {
	s, typ, err := k.GetStringValue(value)
	if err != nil {
		return ""
	}
	if typ == registry.EXPAND_SZ {
		if x, err := registry.ExpandString(s); err == nil {
			return x
		}
	}
	return s
}

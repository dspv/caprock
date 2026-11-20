//go:build windows

package userenv

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// readRegistryPath is the system Path followed by the user's, each expanded
// (they are usually REG_EXPAND_SZ: %SystemRoot%, %USERPROFILE%), joined the
// way Windows builds a new process's PATH. Read only.
func readRegistryPath() (string, error) {
	sys, errSys := regValue(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`)
	usr, errUsr := regValue(registry.CURRENT_USER, `Environment`)
	if errSys != nil && errUsr != nil {
		return "", errors.Join(errSys, errUsr)
	}
	var parts []string
	for _, p := range []string{sys, usr} {
		if p = strings.Trim(p, "; "); p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, ";"), nil
}

func regValue(root registry.Key, path string) (string, error) {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer k.Close()
	v, typ, err := k.GetStringValue("Path")
	if err != nil {
		return "", err
	}
	if typ == registry.EXPAND_SZ {
		if x, err := registry.ExpandString(v); err == nil {
			v = x
		}
	}
	return v, nil
}

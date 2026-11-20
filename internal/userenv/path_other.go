//go:build !windows

package userenv

import "errors"

func readRegistryPath() (string, error) { return "", errors.New("no registry here") }

package config

import "runtime"

func isWindows() bool { return runtime.GOOS == "windows" }

func shimBinaryName() string {
	if isWindows() {
		return "caprock-hook.exe"
	}
	return "caprock-hook"
}

//go:build !darwin

package tcc

// responsibleExe: only macOS has responsible processes.
func responsibleExe(int) string { return "" }

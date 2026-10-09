//go:build !darwin && !linux && !windows

package fgproc

func foreground(int) string { return "" }

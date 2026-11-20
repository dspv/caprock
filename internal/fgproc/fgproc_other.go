//go:build !darwin && !linux && !windows

package fgproc

func foreground(int) (string, int) { return "", 0 }

func inJob(int, int) bool { return false }

//go:build !darwin

package ptyhost

import "errors"

var errNotDarwin = errors.New("the Caprock Terminal helper is macOS only")

// cloneTree is macOS's; elsewhere copyTree does the work.
func cloneTree(_, _ string) error { return errNotDarwin }

// runningHolderExes is macOS's. Elsewhere no helper is staged, and the error
// keeps pruneHelpers from deleting anything.
func runningHolderExes() ([]string, error) { return nil, errNotDarwin }

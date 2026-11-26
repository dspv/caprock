package ptyhost

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Staged copies of the Caprock Terminal helper (ADR-101, amended 2026-11-26).
//
// The desktop app installs the helper at <data_dir>/bin/Caprock Terminal.app
// and replaces it there on every update. A holder started from that path
// outlives the update on purpose, and so went on running from a bundle that
// was no longer on disk: macOS could not check the signature of the program
// it holds responsible for the terminal (`codesign -v <pid>`: "No such file
// or directory"), and refused it the microphone without asking — Claude
// Code's /voice said "No audio detected from microphone" in every session
// opened before the update.
//
// So holders never run from the installed bundle. The daemon copies it,
// byte for byte (signature, bundle id and all, so macOS's Allow still
// applies), to <data_dir>/ptyhost/bin/helper-<hash>/, named by its contents,
// and starts holders from the copy. An update installs a new bundle and the
// next daemon makes a new copy beside the old one; a copy is deleted only
// when no running holder was started from it, at daemon start and shortly
// after a session ends. A terminal keeps a valid signature for as long as it
// runs.

// stagedPrefix starts the name of each staged copy's directory.
const stagedPrefix = "helper-"

// pruneDelay is how long after a session ends the staged copies are pruned:
// time for its holder, which exits right after its child, to be gone.
var pruneDelay = 10 * time.Second

// stagedDir is where the staged copies live, beside the holder copies the
// daemon makes on Windows.
func stagedDir(dataDir string) string { return filepath.Join(Dir(dataDir), "bin") }

// StageHelper returns where the daemon starts holders from, given exe, the
// holder ptyhost.Binary picked: exe itself unless it is the Caprock Terminal
// helper, and then the helper's executable in a staged copy of its bundle
// under dataDir, made now if there is none. Copies no running holder was
// started from are deleted on the way. Any failure returns exe: a terminal
// that loses the microphone at the next update beats no terminal.
func StageHelper(exe, dataDir string) string {
	if !IsHelper(exe) || dataDir == "" {
		return exe
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	dir, err := stageBundle(bundle, stagedDir(dataDir))
	if err != nil {
		return exe
	}
	pruneHelpers(stagedDir(dataDir), filepath.Base(dir))
	return HelperExe(dir)
}

// StagedHelperDirs lists the directories the executables of every staged
// helper copy under dataDir sit in: this install's, as much as the bundle
// they were copied from (internal/daemon's installDirs).
func StagedHelperDirs(dataDir string) []string {
	if dataDir == "" {
		return nil
	}
	entries, err := os.ReadDir(stagedDir(dataDir))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), stagedPrefix) {
			out = append(out, filepath.Dir(HelperExe(filepath.Join(stagedDir(dataDir), e.Name()))))
		}
	}
	return out
}

// stageBundle copies the helper bundle into bin/helper-<hash>/ and returns
// that directory; a copy already there is used as it is. The copy is made
// beside and renamed in, so a half-made one is never started.
func stageBundle(bundle, bin string) (string, error) {
	sum, err := treeHash(bundle)
	if err != nil {
		return "", err
	}
	name := stagedPrefix + sum
	dir := filepath.Join(bin, name)
	if executable(HelperExe(dir)) {
		return dir, nil
	}
	if err := os.MkdirAll(bin, 0o700); err != nil {
		return "", err
	}
	tmp := filepath.Join(bin, "."+name+".tmp")
	_ = os.RemoveAll(tmp)
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return "", err
	}
	if err := cloneTree(bundle, filepath.Join(tmp, HelperBundle)); err != nil {
		_ = os.RemoveAll(filepath.Join(tmp, HelperBundle))
		if err := copyTree(bundle, filepath.Join(tmp, HelperBundle)); err != nil {
			_ = os.RemoveAll(tmp)
			return "", err
		}
	}
	// A directory of that name without a runnable helper in it is a copy
	// that went wrong; nothing can be running from it.
	_ = os.RemoveAll(dir)
	if err := os.Rename(tmp, dir); err != nil {
		_ = os.RemoveAll(tmp)
		return "", err
	}
	if !executable(HelperExe(dir)) {
		return "", errors.New("the staged helper is not executable")
	}
	return dir, nil
}

// pruneHelpers deletes the staged copies in bin other than keep that no
// running holder was started from, and the leftovers of copies that stopped
// halfway. When the running holders cannot be listed, nothing is deleted.
func pruneHelpers(bin, keep string) {
	exes, err := runningHolderExes()
	if err != nil {
		return
	}
	pruneStaged(bin, keep, exes)
}

// pruneStaged is pruneHelpers with the running holders' executables given.
func pruneStaged(bin, keep string, running []string) {
	entries, err := os.ReadDir(bin)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		switch {
		case !e.IsDir() || n == keep:
		case strings.HasPrefix(n, "."+stagedPrefix) && strings.HasSuffix(n, ".tmp"):
			_ = os.RemoveAll(filepath.Join(bin, n))
		case strings.HasPrefix(n, stagedPrefix) && !runsFrom(running, filepath.Join(bin, n)):
			_ = os.RemoveAll(filepath.Join(bin, n))
		}
	}
}

// runsFrom reports whether any of exes is inside dir.
func runsFrom(exes []string, dir string) bool {
	dir = filepath.Clean(dir) + string(filepath.Separator)
	for _, e := range exes {
		if strings.HasPrefix(strings.ToLower(filepath.Clean(e)), strings.ToLower(dir)) {
			return true
		}
	}
	return false
}

// treeHash names a directory tree by its contents: every entry's path, kind,
// permission bits and bytes (a link's target), in a fixed order. 16 hex
// digits, as the Windows holder copies are named.
func treeHash(root string) (string, error) {
	h := sha256.New()
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		_, _ = io.WriteString(h, filepath.ToSlash(rel)+"\x00"+info.Mode().String()+"\x00")
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			t, err := os.Readlink(p)
			if err != nil {
				return err
			}
			_, _ = io.WriteString(h, t)
		case d.Type().IsRegular():
			f, err := os.Open(p) //nolint:gosec // the helper bundle this install ships
			if err != nil {
				return err
			}
			_, err = io.Copy(h, f)
			_ = f.Close()
			if err != nil {
				return err
			}
		}
		_, _ = io.WriteString(h, "\x00")
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

// copyTree copies the tree src to dst, which must not exist: directories,
// files with their permission bits, and symbolic links as links, so a signed
// bundle's seal still matches (the app installs the bundle the same way).
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.Mkdir(to, info.Mode().Perm()|0o700)
		case d.Type()&fs.ModeSymlink != 0:
			t, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(t, to)
		case d.Type().IsRegular():
			return copyFile(p, to, info.Mode().Perm())
		}
		return nil
	})
}

func copyFile(from, to string, perm fs.FileMode) error {
	in, err := os.Open(from) //nolint:gosec // the helper bundle this install ships
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm) //nolint:gosec // under the data dir
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// The umask may have taken bits the bundle has.
	return os.Chmod(to, perm)
}

// HolderExited tells the manager a session's holder has ended: the staged
// helper copies are pruned a moment later, once it is gone, so the copy it
// ran from goes when it was the last of an older version. Calls in quick
// succession prune once. Nothing happens unless holders start from a staged
// copy.
func (m *Manager) HolderExited() {
	if !m.staged() {
		return
	}
	m.pruneMu.Lock()
	defer m.pruneMu.Unlock()
	if m.pruneTimer != nil {
		m.pruneTimer.Reset(pruneDelay)
		return
	}
	keep := filepath.Base(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(m.Exe)))))
	bin := stagedDir(m.DataDir)
	m.pruneTimer = time.AfterFunc(pruneDelay, func() {
		m.pruneMu.Lock()
		m.pruneTimer = nil
		m.pruneMu.Unlock()
		pruneHelpers(bin, keep)
	})
}

// staged reports whether this manager starts holders from a staged helper
// copy under its data directory.
func (m *Manager) staged() bool {
	if m.DataDir == "" || !IsHelper(m.Exe) {
		return false
	}
	dir := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(m.Exe))))
	return filepath.Dir(dir) == stagedDir(m.DataDir) && strings.HasPrefix(filepath.Base(dir), stagedPrefix)
}

// pruneState is the Manager's part in HolderExited.
type pruneState struct {
	pruneMu    sync.Mutex
	pruneTimer *time.Timer
}

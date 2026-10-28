//go:build windows

package trash

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SHFileOperationW with FOF_ALLOWUNDO sends an item to the Recycle Bin. Two
// cases would make it delete instead, silently under FOF_NOCONFIRMATION: a
// drive with no Recycle Bin (removable, network) and an item larger than
// the bin holds. Both are refused before the call.

var (
	shell32          = windows.NewLazySystemDLL("shell32.dll")
	procSHFileOpW    = shell32.NewProc("SHFileOperationW")
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procGetDriveType = kernel32.NewProc("GetDriveTypeW")
)

const (
	foDelete           = 0x0003
	fofSilent          = 0x0004
	fofNoConfirmation  = 0x0010
	fofAllowUndo       = 0x0040
	fofNoConfirmMkdir  = 0x0200
	fofNoErrorUI       = 0x0400
	driveFixed         = 3
	recycleBinSizeNote = "1 GB"
)

// shFileOpStruct is SHFILEOPSTRUCTW with its 64-bit layout.
type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

// treeSize is the bytes under path, stopping once past limit; a symlink
// counts as itself.
func treeSize(path string, limit int64) int64 {
	var n int64
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // an unreadable entry adds nothing
		}
		if d.Type().IsRegular() {
			if fi, err := d.Info(); err == nil {
				n += fi.Size()
			}
		}
		if n > limit {
			return filepath.SkipAll
		}
		return nil
	})
	return n
}

func supported() (bool, string) {
	if err := procSHFileOpW.Find(); err != nil {
		return false, "the Recycle Bin is out of reach on this Windows"
	}
	return true, ""
}

func move(path string) error {
	if ok, why := supported(); !ok {
		return refuse(why)
	}
	vol := filepath.VolumeName(path)
	if len(vol) != 2 || vol[1] != ':' {
		return refuse("only items on a local drive go to the Recycle Bin; delete this one in Explorer")
	}
	root, err := windows.UTF16PtrFromString(vol + `\`)
	if err != nil {
		return err
	}
	if t, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(root))); t != driveFixed {
		return refuse("this drive has no Recycle Bin, so the item would be deleted for good; delete it in Explorer if you mean to")
	}
	if treeSize(path, MaxBytes) > MaxBytes {
		return refuse("over " + recycleBinSizeNote + ": the Recycle Bin may not keep it, so it is not sent; delete it in Explorer if you mean to")
	}
	// pFrom is a list of paths, each NUL-terminated, ending in another NUL.
	from, err := windows.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0)
	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI | fofNoConfirmMkdir,
	}
	r, _, _ := procSHFileOpW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return refuse(fmt.Sprintf("the Recycle Bin refused it (code 0x%x)", r))
	}
	if op.fAnyOperationsAborted != 0 {
		return refuse("the move to the Recycle Bin was cancelled")
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		return refuse("the item is still there after the move to the Recycle Bin")
	}
	return nil
}

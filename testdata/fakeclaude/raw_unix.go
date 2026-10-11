//go:build darwin || linux

package main

import "golang.org/x/sys/unix"

// makeRaw puts the terminal on fd into raw mode, as cfmakeraw does, and
// returns a function that puts it back.
func makeRaw(fd int) (func(), error) {
	t, err := unix.IoctlGetTermios(fd, ioctlGet)
	if err != nil {
		return nil, err
	}
	old := *t
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 1
	t.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(fd, ioctlSet, t); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, ioctlSet, &old) }, nil
}

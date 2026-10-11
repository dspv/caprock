package main

import "golang.org/x/sys/windows"

// makeRaw switches the console input on fd to raw keys with VT sequences
// (Shift+Tab arrives as ESC [ Z), and returns a function that puts it back.
func makeRaw(fd int) (func(), error) {
	h := windows.Handle(fd)
	var st uint32
	if err := windows.GetConsoleMode(h, &st); err != nil {
		return nil, err
	}
	raw := st &^ (windows.ENABLE_ECHO_INPUT | windows.ENABLE_PROCESSED_INPUT | windows.ENABLE_LINE_INPUT)
	raw |= windows.ENABLE_VIRTUAL_TERMINAL_INPUT
	if err := windows.SetConsoleMode(h, raw); err != nil {
		return nil, err
	}
	return func() { _ = windows.SetConsoleMode(h, st) }, nil
}

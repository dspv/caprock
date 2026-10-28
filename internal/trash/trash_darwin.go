//go:build darwin

package trash

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// NSFileManager -trashItemAtURL:resultingItemURL:error: (macOS 10.8 and
// later): the Finder's own move to the Trash, with Put Back, on any
// volume. No Apple Events, so no automation prompt.

var (
	loadOnce sync.Once
	loaded   bool
)

func load() bool {
	loadOnce.Do(func() {
		if _, err := purego.Dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", purego.RTLD_LAZY|purego.RTLD_GLOBAL); err != nil {
			return
		}
		loaded = objc.GetClass("NSFileManager") != 0 && objc.GetClass("NSURL") != 0 && objc.GetClass("NSString") != 0
	})
	return loaded
}

func supported() (bool, string) {
	if !load() {
		return false, "Foundation could not be loaded, so the Trash is out of reach"
	}
	return true, ""
}

func cstr(s string) *byte {
	b := append([]byte(s), 0)
	return &b[0]
}

// goString copies a NUL-terminated C string.
func goString(p *byte) string {
	if p == nil {
		return ""
	}
	var b []byte
	for i := 0; i < 4096; i++ {
		c := *(*byte)(unsafe.Add(unsafe.Pointer(p), i)) //nolint:gosec // a C string Foundation returned
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func move(path string) error {
	if !load() {
		return refuse("Foundation could not be loaded, so the Trash is out of reach")
	}
	// Autoreleased objects go into a pool drained on this same thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(objc.RegisterName("alloc")).Send(objc.RegisterName("init"))
	defer pool.Send(objc.RegisterName("drain"))

	p := cstr(path)
	str := objc.ID(objc.GetClass("NSString")).Send(objc.RegisterName("stringWithUTF8String:"), p)
	runtime.KeepAlive(p)
	if str == 0 {
		return refuse("the path could not be handed to the Trash")
	}
	url := objc.ID(objc.GetClass("NSURL")).Send(objc.RegisterName("fileURLWithPath:"), str)
	fm := objc.ID(objc.GetClass("NSFileManager")).Send(objc.RegisterName("defaultManager"))
	var nsErr objc.ID
	ok := objc.Send[bool](fm, objc.RegisterName("trashItemAtURL:resultingItemURL:error:"), url, uintptr(0), unsafe.Pointer(&nsErr))
	if ok {
		return nil
	}
	msg := "the Trash refused it"
	if nsErr != 0 {
		desc := nsErr.Send(objc.RegisterName("localizedDescription"))
		if s := goString(objc.Send[*byte](desc, objc.RegisterName("UTF8String"))); s != "" {
			msg = s
		}
	}
	return refuse(msg)
}

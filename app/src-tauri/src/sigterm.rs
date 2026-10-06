//! SIGTERM quits the app the way Cmd+Q does: through Tauri's own exit, so the
//! window's size and place are saved and the daemon is left running.
//! `make app-local` stops a running copy this way before it replaces the
//! bundle; without it the signal's default action ends the process on the
//! spot. A handler may only do async-signal-safe work, so it writes one byte
//! to a pipe and a thread blocked on the other end asks the app to exit.

use std::sync::atomic::{AtomicI32, Ordering};
use tauri::{AppHandle, Runtime};

static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_term(_: libc::c_int) {
    let fd = WAKE.load(Ordering::Relaxed);
    if fd >= 0 {
        // SAFETY: write(2) is async-signal-safe; the buffer is static.
        unsafe { libc::write(fd, b"x".as_ptr().cast(), 1) };
    }
}

pub fn install<R: Runtime>(app: AppHandle<R>) {
    let mut fds = [-1; 2];
    // SAFETY: plain libc calls on descriptors this function owns.
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    WAKE.store(fds[1], Ordering::Relaxed);
    // SAFETY: the handler only loads an atomic and calls write(2).
    let installed = unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_term as *const () as libc::sighandler_t;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut sa.sa_mask);
        libc::sigaction(libc::SIGTERM, &sa, std::ptr::null_mut()) == 0
    };
    if !installed {
        return;
    }
    let read = fds[0];
    std::thread::spawn(move || loop {
        let mut b = 0u8;
        // SAFETY: reads one byte into a local.
        let n = unsafe { libc::read(read, (&mut b as *mut u8).cast(), 1) };
        if n == 1 {
            app.exit(0);
            return;
        }
        if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return;
    });
}

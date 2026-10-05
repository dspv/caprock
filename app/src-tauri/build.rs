fn main() {
    // App commands are declared so the capabilities can grant them per origin
    // (`allow-<command>`); a command not granted is refused by the ACL.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_status",
            "start_daemon",
            "update_daemon",
            "set_background",
            "open_external",
            "set_tray",
            "set_badge",
            "hotkey_status",
            "register_hotkey",
        ]),
    ))
    .expect("tauri build");
}

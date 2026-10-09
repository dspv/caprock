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
            "notify",
            "withdraw_notifications",
            "tray_open",
            "tray_hide",
            "tray_fit",
            "app_update_status",
            "app_update_check",
            "app_update_install",
            "app_update_asked",
            "clipboard_image",
            "capture_webview",
            "read_dropped_image",
        ]),
    ))
    .expect("tauri build");
}

fn main() {
    // `whisper`: the offline voice engine (src/dictate_whisper.rs, ADR-104)
    // is built — on Windows and Linux, and on a Mac with the offline-voice
    // feature, for checking only.
    println!("cargo::rustc-check-cfg=cfg(whisper)");
    let mac = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    if !mac || std::env::var_os("CARGO_FEATURE_OFFLINE_VOICE").is_some() {
        println!("cargo:rustc-cfg=whisper");
    }
    // App commands are declared so the capabilities can grant them per origin
    // (`allow-<command>`); a command not granted is refused by the ACL.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_status",
            "start_daemon",
            "update_daemon",
            "set_background",
            "open_external",
            "pick_folder",
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
            "app_update_download",
            "app_update_install",
            "app_update_asked",
            "clipboard_image",
            "capture_webview",
            "read_dropped_image",
            "read_dropped_text",
            "read_dropped_file",
            "set_zoom",
            "open_mail_app",
            "open_mail_window",
            "browser_tab",
            "app_log",
            "dictation_status",
            "dictation_start",
            "dictation_stop",
            "voice_model_status",
            "voice_model_download",
            "voice_model_cancel",
            "voice_model_remove",
            "voice_model_reveal",
        ]),
    ))
    .expect("tauri build");
}

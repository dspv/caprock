fn main() {
    // App commands must be declared to be grantable to a remote origin (the
    // daemon's loopback URL) in capabilities/default.json.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["bench_report"])),
    )
    .expect("tauri build");
}

//! Caprock desktop app: a thin Tauri v2 shell around the daemon's own
//! dashboard (ADR-038, .ai/21-app.md). The shell owns the window, finding or
//! starting the daemon, and what a browser tab cannot do; every feature lives
//! in the Go daemon and the React UI it serves.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod commands;
mod discovery;
mod hotkey;
mod shell;
#[cfg(all(feature = "snapshot", target_os = "macos"))]
mod snapshot;
mod supervisor;
mod tray;

use std::path::PathBuf;
use supervisor::{State, Supervisor};
use tauri::WebviewUrl;
use tauri_plugin_window_state::StateFlags;

/// Every command, for the handler and the ACL test.
macro_rules! handler {
    () => {
        tauri::generate_handler![
            commands::daemon_status,
            commands::start_daemon,
            commands::update_daemon,
            commands::set_background,
            commands::open_external,
            commands::set_tray,
            commands::set_badge,
            commands::hotkey_status,
            commands::register_hotkey
        ]
    };
}

fn configure<R: tauri::Runtime>(b: tauri::Builder<R>, sup: commands::Sup) -> tauri::Builder<R> {
    b.plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(hotkey::Hotkey::new(&sup.data_dir))
        .manage(sup)
        .manage(shell::Downloads::default())
        .manage(tray::Tray::default())
        .manage(badge::Badge::default())
        .invoke_handler(handler!())
}

fn main() {
    let data_dir = discovery::data_dir().unwrap_or_else(|| PathBuf::from("caprock"));
    let sup = Supervisor::new(data_dir);
    // The first look is synchronous so a running daemon's dashboard is the
    // first page the window loads: no fallback flash on the common path.
    let first = sup.observe(discovery::find(&sup.data_dir), std::time::Duration::ZERO);
    let start = match first {
        State::Connected { port, .. } => WebviewUrl::External(shell::dashboard_url(port)),
        _ => WebviewUrl::App("index.html".into()),
    };
    let monitored = sup.clone();
    // For automated checks on a machine someone is using: launch without
    // taking focus. Not a user setting.
    let quiet = std::env::var_os("CAPROCK_APP_BACKGROUND").is_some();
    let b = configure(tauri::Builder::default(), sup);
    #[cfg(target_os = "macos")]
    let b = b.activate_ignoring_other_apps(!quiet);
    b.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    hotkey::toggle(app);
                }
            })
            .build(),
    )
    .plugin(
        // Size and position are remembered; visibility is the shell's call
        // (shown when the first page has loaded).
        tauri_plugin_window_state::Builder::new()
            .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
            .build(),
    )
    .setup(move |app| {
        shell::build(app.handle(), monitored.clone(), start, !quiet)?;
        tray::install(app.handle())?;
        hotkey::load(app.handle());
        #[cfg(target_os = "macos")]
        menu::install(app.handle(), &monitored)?;
        shell::monitor(app.handle().clone(), monitored);
        #[cfg(all(feature = "snapshot", target_os = "macos"))]
        snapshot::watch(app.handle().clone());
        Ok(())
    })
    .build(tauri::generate_context!())
    .expect("build the Caprock app")
    .run(|_app, _event| {
        // macOS: closing the window keeps the app in the menu bar; a click
        // on the Dock icon brings the window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            hotkey::show(_app);
        }
    });
}

/// The macOS app menu gains the background switch (decision 7): the same
/// choice the first-run screen offers, kept visible afterwards.
#[cfg(target_os = "macos")]
mod menu {
    use super::*;
    use tauri::menu::{CheckMenuItem, Menu, MenuItemKind, PredefinedMenuItem};

    const BACKGROUND: &str = "background";

    pub fn install(app: &tauri::AppHandle, sup: &commands::Sup) -> tauri::Result<()> {
        let menu = Menu::default(app)?;
        let on = sup.settings().is_none_or(|s| s.background);
        let item = CheckMenuItem::with_id(
            app,
            BACKGROUND,
            "Keep Caprock Running in the Background",
            true,
            on,
            None::<&str>,
        )?;
        if let Some(MenuItemKind::Submenu(first)) = menu.items()?.first() {
            first.insert(&PredefinedMenuItem::separator(app)?, 1)?;
            first.insert(&item, 2)?;
        }
        app.set_menu(menu)?;
        let sup = sup.clone();
        app.on_menu_event(move |_, event| {
            if event.id() != BACKGROUND {
                return;
            }
            let (item, sup) = (item.clone(), sup.clone());
            std::thread::spawn(move || {
                let want = item.is_checked().unwrap_or(true);
                if sup.set_background(want).is_err() {
                    let _ = item.set_checked(!want);
                }
            });
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    fn invoke(
        url: &str,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let dir = std::env::temp_dir().join(format!("caprock-acl-{}", std::process::id()));
        let app = configure(mock_builder(), Supervisor::new(dir))
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let page: tauri::Url = url.parse().unwrap();
        let w = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(page.clone()))
            .build()
            .unwrap();
        get_ipc_response(
            &w,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: page,
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
    }

    const DAEMON: &str = "http://127.0.0.1:4391/?app=1#/app";

    #[test]
    fn the_daemon_page_may_read_the_status() {
        let state = invoke(DAEMON, "daemon_status", serde_json::json!({})).expect("allowed");
        assert_eq!(state["state"], "searching");
    }

    #[test]
    fn the_daemon_page_may_not_start_update_or_reconfigure_the_daemon() {
        for (cmd, body) in [
            ("start_daemon", serde_json::json!({"background": true})),
            ("update_daemon", serde_json::json!({})),
            ("set_background", serde_json::json!({"on": false})),
        ] {
            let err = invoke(DAEMON, cmd, body).expect_err(cmd);
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }

    #[test]
    fn the_daemon_page_may_fill_the_tray_and_badge_and_read_the_hotkey() {
        let view =
            serde_json::json!({"view": {"title": "42%", "lines": ["Today $1.00"], "waiting": []}});
        invoke(DAEMON, "set_tray", view).expect("set_tray");
        invoke(DAEMON, "set_badge", serde_json::json!({"count": 2})).expect("set_badge");
        let st = invoke(DAEMON, "hotkey_status", serde_json::json!({})).expect("hotkey_status");
        assert_eq!(st["default"], hotkey::DEFAULT);
    }

    #[test]
    fn only_the_daemon_page_may_touch_the_tray_badge_or_hotkey() {
        // The bundled page is not granted these either (capabilities/fallback.json);
        // the mock context loads no app manifest, so only remote origins are checked.
        for url in ["https://example.com/", "http://localhost:4391/"] {
            for (cmd, body) in [
                ("set_tray", serde_json::json!({"view": {}})),
                ("set_badge", serde_json::json!({"count": 1})),
                ("register_hotkey", serde_json::json!({"accelerator": null})),
                ("hotkey_status", serde_json::json!({})),
            ] {
                let err = invoke(url, cmd, body).expect_err(&format!("{url} {cmd}"));
                assert!(
                    err.to_string().contains("not allowed"),
                    "{url} {cmd}: {err}"
                );
            }
        }
    }

    #[test]
    fn another_origin_gets_nothing() {
        for url in [
            "https://example.com/",
            "http://localhost:4391/",
            "http://192.168.1.5:4391/",
        ] {
            let err = invoke(url, "daemon_status", serde_json::json!({})).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
    }

    #[test]
    fn the_fallback_page_may_ask_for_a_start() {
        let local = if cfg!(windows) {
            "http://tauri.localhost/index.html"
        } else {
            "tauri://localhost/index.html"
        };
        invoke(local, "daemon_status", serde_json::json!({}))
            .expect("status from the fallback page");
        let err = invoke(
            local,
            "open_external",
            serde_json::json!({"url": "file:///etc/passwd"}),
        )
        .expect_err("file URL");
        assert!(err.to_string().contains("refused"), "{err}");
    }
}

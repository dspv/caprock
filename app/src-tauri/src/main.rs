//! Caprock desktop app: a thin Tauri v2 shell around the daemon's own
//! dashboard (ADR-038, .ai/21-app.md). The shell owns the window, finding or
//! starting the daemon, and what a browser tab cannot do; every feature lives
//! in the Go daemon and the React UI it serves.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod discovery;
mod shell;
mod supervisor;

use std::path::PathBuf;
use supervisor::{State, Supervisor};
use tauri::WebviewUrl;

/// Every command, for the handler and the ACL test.
macro_rules! handler {
    () => {
        tauri::generate_handler![
            commands::daemon_status,
            commands::start_daemon,
            commands::update_daemon,
            commands::set_background,
            commands::open_external
        ]
    };
}

fn configure<R: tauri::Runtime>(b: tauri::Builder<R>, sup: commands::Sup) -> tauri::Builder<R> {
    b.plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sup)
        .manage(shell::Downloads::default())
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
    configure(tauri::Builder::default(), sup)
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(move |app| {
            shell::build(app.handle(), start)?;
            #[cfg(target_os = "macos")]
            menu::install(app.handle(), &monitored)?;
            shell::monitor(app.handle().clone(), monitored);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run the Caprock app");
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

//! Caprock desktop app: a thin Tauri v2 shell around the daemon's own
//! dashboard (ADR-038, .ai/21-app.md). The shell owns the window, finding or
//! starting the daemon, and what a browser tab cannot do; every feature lives
//! in the Go daemon and the React UI it serves.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod applog;
mod badge;
mod browser;
mod capture;
mod commands;
mod discovery;
// The Dock icon is macOS's; the decision is tested on every OS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod dock_icon;
mod hotkey;
// Looking for the Caprock Mail preview is macOS's; the lookup is tested on every OS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod mail;
// Actionable notifications and the popover are macOS's (notify_macos, the
// menu bar); elsewhere most of both modules is unused, not dead.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod notify;
// The mapping is tested on every OS; only Linux shows through it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod notify_linux;
#[cfg(target_os = "macos")]
mod notify_macos;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod popover;
mod recover;
mod shell;
#[cfg(unix)]
mod sigterm;
#[cfg(all(feature = "snapshot", target_os = "macos"))]
mod snapshot;
mod supervisor;
mod tray;
mod updater;

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
            commands::pick_folder,
            commands::set_tray,
            commands::set_badge,
            commands::set_zoom,
            commands::hotkey_status,
            commands::register_hotkey,
            mail::open_mail_app,
            mail::open_mail_window,
            notify::notify,
            notify::withdraw_notifications,
            popover::tray_open,
            popover::tray_hide,
            popover::tray_fit,
            commands::app_update_status,
            commands::app_update_check,
            commands::app_update_download,
            commands::app_update_install,
            commands::app_update_asked,
            capture::clipboard_image,
            capture::capture_webview,
            capture::read_dropped_image,
            capture::read_dropped_text,
            browser::browser_tab,
            commands::app_log
        ]
    };
}

fn configure<R: tauri::Runtime>(b: tauri::Builder<R>, sup: commands::Sup) -> tauri::Builder<R> {
    b.plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(hotkey::Hotkey::new(&sup.data_dir))
        // Its JavaScript commands are granted to no page: the page calls
        // ours (commands::app_update_*), which keep the rules in one place.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Updates::new(&sup.data_dir))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(capture::Dropped::default())
        .manage(recover::Crashes::default())
        .manage(recover::LogDir(sup.data_dir.clone()))
        .manage(sup)
        .manage(shell::Downloads::default())
        .manage(browser::Pages::default())
        .manage(tray::Tray::default())
        .manage(popover::Popover::default())
        .manage(badge::Badge::default())
        .invoke_handler(handler!())
}

fn main() {
    let data_dir = discovery::data_dir().unwrap_or_else(|| PathBuf::from("caprock"));
    let sup = Supervisor::new(data_dir);
    // The first look is synchronous so a running daemon's dashboard is the
    // first page the window loads: no fallback flash on the common path.
    let first = sup.observe(discovery::find(&sup.data_dir), std::time::Duration::ZERO);
    // Whether that daemon is replaced by the app's own (ADR-040) is
    // decided here, before any page loads. Decided after, the window loaded
    // the old daemon's UI and kept it once the new daemon came up (0.78.2:
    // the strip read 0.78.1 for the rest of the run).
    let replacing = matches!(first, State::Connected { .. } | State::TooOld { .. })
        && sup.should_adopt(|| sup.bundled_version());
    if replacing {
        sup.spawn_adopt();
    }
    let start = match shell::first_page(&first, replacing) {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };
    let monitored = sup.clone();
    // For automated checks on a machine someone is using: launch without
    // taking focus. Not a user setting.
    let quiet = std::env::var_os("CAPROCK_APP_BACKGROUND").is_some();
    let b = configure(tauri::Builder::default(), sup);
    #[cfg(target_os = "macos")]
    let b = b.activate_ignoring_other_apps(!quiet);
    // macOS ends a WebView's content process under memory pressure, and
    // Tauri leaves the view blank (white) until it is reloaded: reload it,
    // and say so in the app's log (recover.rs).
    #[cfg(target_os = "macos")]
    let b = b.on_web_content_process_terminate(recover::on_terminated);
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
        // The Dock tile from the bundle's own icon, and once per version a
        // LaunchServices refresh, so an in-app update shows its new icon.
        #[cfg(target_os = "macos")]
        dock_icon::install(&monitored.data_dir, &app.package_info().version.to_string());
        // `--features snapshot` only: an automated check on a machine
        // someone is using (bench/update.mjs) puts no icon in the menu bar or
        // the Dock; its window is placed off screen.
        let unseen = cfg!(feature = "snapshot") && std::env::var_os("CAPROCK_APP_UNSEEN").is_some();
        #[cfg(target_os = "macos")]
        if unseen {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
        if !unseen {
            tray::install(app.handle())?;
        }
        hotkey::load(app.handle());
        #[cfg(target_os = "macos")]
        menu::install(app.handle(), &monitored)?;
        #[cfg(target_os = "macos")]
        notify_macos::install(app.handle());
        shell::monitor(app.handle().clone(), monitored);
        #[cfg(unix)]
        sigterm::install(app.handle().clone());
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
        // Linux: no one answers a notification's buttons once the app is
        // gone, so none is left on screen to be pressed for nothing.
        #[cfg(target_os = "linux")]
        if let tauri::RunEvent::Exit = _event {
            notify_linux::withdraw_all();
        }
    });
}

/// The macOS app menu gains the background switch (decision 7): the same
/// choice the first-run screen offers, kept visible afterwards.
#[cfg(target_os = "macos")]
mod menu {
    use super::*;
    use tauri::menu::{
        CheckMenuItem, IconMenuItem, Menu, MenuItem, MenuItemKind, NativeIcon, PredefinedMenuItem,
    };
    use tauri::Manager;

    const BACKGROUND: &str = "background";
    const RELOAD: &str = "reload";
    const CHECK_UPDATES: &str = "check-updates";
    const CLOSE_TAB: &str = "close-tab";
    const CLOSE_WINDOW: &str = "close-window";
    const NEW_BROWSER_TAB: &str = "new-browser-tab";

    /// What the page does on File -> New Browser Tab: an empty browser tab
    /// with its address box focused, or, while the in-app browser is off, a
    /// line saying where to turn it on (`OPEN_BROWSER_EVENT`,
    /// ui/src/lib/browsertab.ts; ADR-075).
    const NEW_BROWSER_TAB_JS: &str =
        "window.dispatchEvent(new CustomEvent('caprock:open-browser', { detail: {} }))";

    /// What the page does on File -> Close Tab: the same as ⌘W pressed in it
    /// (`CLOSE_TAB_EVENT`, ui/src/lib/shell.ts).
    const CLOSE_TAB_JS: &str = "window.dispatchEvent(new Event('caprock:close-tab'))";

    /// What ⌘W does in the window in front.
    #[derive(Debug, PartialEq, Eq)]
    pub enum CloseTarget {
        /// The main window: its tab in front, as the tab's × does (the page decides).
        Tab,
        /// Any other window (Mail, the popover): the window, as ⌘W always did.
        Window(String),
        /// No window of ours in front.
        Nothing,
    }

    /// ⌘W closes the tab in front, never the main window (owner, 2026-10-16,
    /// translated: "Cmd+W must close tabs"). A browser tab's page has the
    /// keyboard only while its tab is in front, so there it is that tab.
    pub fn close_target(focused: Option<&str>) -> CloseTarget {
        match focused {
            Some(shell::MAIN) => CloseTarget::Tab,
            Some(label) if label.starts_with(crate::browser::PREFIX) => CloseTarget::Tab,
            Some(label) => CloseTarget::Window(label.to_string()),
            None => CloseTarget::Nothing,
        }
    }

    fn focused_label(app: &tauri::AppHandle) -> Option<String> {
        app.webview_windows()
            .into_iter()
            .find(|(_, w)| w.is_focused().unwrap_or(false))
            .map(|(label, _)| label)
    }

    fn close_window(app: &tauri::AppHandle, label: &str) {
        if let Some(w) = app.get_webview_window(label) {
            // The main window's own CloseRequested hides it (shell::build).
            let _ = w.close();
        }
    }

    /// Tauri's default menu, rearranged: View -> Reload, and ⌘W on Close Tab.
    pub fn arrange<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        menu: &Menu<R>,
    ) -> tauri::Result<()> {
        // View -> Reload: the page again from the daemon, as a browser's Cmd+R.
        let reload = MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?;
        // Tauri's default menu puts Close Window on ⌘W twice (File and
        // Window), and a menu's key equivalent is taken before the page sees
        // the key, so ⌘W hid the window instead of closing the tab. File ->
        // Close Tab holds ⌘W now; Window -> Close Window stays, with no key.
        let close_tab = MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?;
        let close_win = MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, None::<&str>)?;
        // File -> New Browser Tab, a globe beside it so it reads as a
        // browser, not an agent (ADR-075). No key: ⌘T is New shell.
        let browser = IconMenuItem::with_id_and_native_icon(
            app,
            NEW_BROWSER_TAB,
            "New Browser Tab",
            true,
            Some(NativeIcon::Network),
            None::<&str>,
        )?;
        for kind in menu.items()? {
            if let MenuItemKind::Submenu(sub) = kind {
                let text = sub.text()?;
                if text == "View" {
                    sub.insert(&reload, 0)?;
                    sub.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                }
                if text == "File" {
                    sub.insert(&browser, 0)?;
                    sub.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                }
                if text == "File" || text == "Window" {
                    for (i, item) in sub.items()?.iter().enumerate() {
                        let MenuItemKind::Predefined(p) = item else {
                            continue;
                        };
                        // The title, or before the menu is built the default with its &mnemonic.
                        if p.text()?.replace('&', "") != "Close Window" {
                            continue;
                        }
                        sub.remove(p)?;
                        if text == "File" {
                            sub.insert(&close_tab, i)?;
                        } else {
                            sub.insert(&close_win, i)?;
                        }
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn install(app: &tauri::AppHandle, sup: &commands::Sup) -> tauri::Result<()> {
        let menu = Menu::default(app)?;
        arrange(app, &menu)?;
        let on = sup.settings().is_none_or(|s| s.background);
        let item = CheckMenuItem::with_id(
            app,
            BACKGROUND,
            "Keep Caprock Running in the Background",
            true,
            on,
            None::<&str>,
        )?;
        // "Check for Updates…" under About, as macOS apps put it (F20).
        let check =
            MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
        if let Some(MenuItemKind::Submenu(first)) = menu.items()?.first() {
            first.insert(&check, 1)?;
            first.insert(&PredefinedMenuItem::separator(app)?, 2)?;
            first.insert(&item, 3)?;
        }
        app.set_menu(menu)?;
        let sup = sup.clone();
        app.on_menu_event(move |app, event| {
            if event.id() == RELOAD {
                shell::reload_main(app);
                return;
            }
            if event.id() == CHECK_UPDATES {
                crate::updater::check_from_menu(app);
                return;
            }
            if event.id() == CLOSE_TAB {
                match close_target(focused_label(app).as_deref()) {
                    CloseTarget::Tab => {
                        if let Some(w) = app.get_webview_window(shell::MAIN) {
                            let _ = w.eval(CLOSE_TAB_JS);
                        }
                    }
                    CloseTarget::Window(label) => close_window(app, &label),
                    CloseTarget::Nothing => {}
                }
                return;
            }
            if event.id() == NEW_BROWSER_TAB {
                if let Some(w) = app.get_webview_window(shell::MAIN) {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.eval(NEW_BROWSER_TAB_JS);
                }
                return;
            }
            if event.id() == CLOSE_WINDOW {
                if let Some(label) = focused_label(app) {
                    close_window(app, &label);
                }
                return;
            }
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
    use tauri::{Manager, WebviewWindowBuilder};

    fn invoke(
        url: &str,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        invoke_in("main", url, cmd, body)
    }

    fn invoke_in(
        label: &str,
        url: &str,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let dir = std::env::temp_dir().join(format!("caprock-acl-{}", std::process::id()));
        let app = configure(mock_builder(), Supervisor::new(dir))
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let page: tauri::Url = url.parse().unwrap();
        let w = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(page.clone()))
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
    fn a_browser_tabs_page_gets_no_command_even_on_the_daemons_own_address() {
        // Its window is `browser-…`, which no capability names (ADR-075):
        // being on 127.0.0.1, even the daemon's own port, earns it nothing.
        for url in [DAEMON, "http://127.0.0.1:5173/", "https://example.com/"] {
            for (cmd, body) in [
                ("daemon_status", serde_json::json!({})),
                ("open_external", serde_json::json!({"url": "https://a.b/"})),
                ("notify", serde_json::json!({"title": "x", "body": ""})),
                ("set_badge", serde_json::json!({"count": 1})),
                ("pick_folder", serde_json::json!({"start": null})),
                ("app_update_install", serde_json::json!({})),
                (
                    "read_dropped_text",
                    serde_json::json!({"path": "/etc/hosts"}),
                ),
                (
                    "browser_tab",
                    serde_json::json!({"id": "t1", "act": {"do": "hide"}}),
                ),
                ("plugin:updater|check", serde_json::json!({})),
            ] {
                let err =
                    invoke_in("browser-t1", url, cmd, body).expect_err(&format!("{url} {cmd}"));
                assert!(
                    err.to_string().contains("not allowed"),
                    "{url} {cmd}: {err}"
                );
            }
        }
    }

    #[test]
    fn only_the_dashboard_drives_its_browser_tabs() {
        // A page that is not there (closed, or never opened) is no error.
        invoke(
            DAEMON,
            "browser_tab",
            serde_json::json!({"id": "t1", "act": {"do": "hide"}}),
        )
        .expect("allowed");
        let err = invoke(
            DAEMON,
            "browser_tab",
            serde_json::json!({"id": "../main", "act": {"do": "close"}}),
        )
        .expect_err("bad id");
        assert!(err.to_string().contains("not a page id"), "{err}");
        let page = serde_json::json!({"id": "t1", "act": {"do": "hide"}});
        let err = invoke_in("tray", POPOVER, "browser_tab", page.clone()).expect_err("popover");
        assert!(err.to_string().contains("not allowed"), "{err}");
        let err = invoke_in("mail", DAEMON, "browser_tab", page.clone()).expect_err("mail");
        assert!(err.to_string().contains("not allowed"), "{err}");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            let err = invoke(url, "browser_tab", page.clone()).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
    }

    #[test]
    fn the_daemon_page_may_read_the_status() {
        let state = invoke(DAEMON, "daemon_status", serde_json::json!({})).expect("allowed");
        assert_eq!(state["state"], "searching");
    }

    #[test]
    fn only_the_dashboard_may_write_to_the_apps_log() {
        let line = serde_json::json!({"message": "crash screen: TypeError: x"});
        invoke(DAEMON, "app_log", line.clone()).expect("allowed");
        let err = invoke_in("tray", POPOVER, "app_log", line.clone()).expect_err("popover");
        assert!(err.to_string().contains("not allowed"), "{err}");
        let err = invoke_in("mail", DAEMON, "app_log", line.clone()).expect_err("mail");
        assert!(err.to_string().contains("not allowed"), "{err}");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            let err = invoke(url, "app_log", line.clone()).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
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
    fn no_other_origin_may_open_the_folder_chooser() {
        // Not called from the daemon's page here: it would open a real
        // dialog. The capability grants it there (capabilities/daemon.json).
        for url in ["https://example.com/", "http://localhost:4391/"] {
            let err =
                invoke(url, "pick_folder", serde_json::json!({"start": null})).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
    }

    #[test]
    fn the_daemon_page_may_notify_and_another_origin_may_not() {
        // A blank title is refused by the command itself, so nothing is shown.
        let blank = serde_json::json!({"title": " ", "body": ""});
        let err = invoke(DAEMON, "notify", blank.clone()).expect_err("blank title");
        assert!(err.to_string().contains("needs a title"), "{err}");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            let err = invoke(url, "notify", blank.clone()).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
    }

    #[test]
    fn only_the_daemon_page_may_withdraw_notifications() {
        let none = serde_json::json!({"ids": []});
        invoke(DAEMON, "withdraw_notifications", none.clone()).expect("allowed");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            let err = invoke(url, "withdraw_notifications", none.clone()).expect_err(url);
            assert!(err.to_string().contains("not allowed"), "{url}: {err}");
        }
    }

    #[test]
    fn only_the_daemon_page_may_read_a_dropped_image_and_only_a_dropped_one() {
        // Allowed to call, but a path the shell did not just hand over is refused.
        let path = serde_json::json!({"path": "/etc/hosts.png"});
        let err = invoke(DAEMON, "read_dropped_image", path.clone()).expect_err("not dropped");
        assert!(err.to_string().contains("not a dropped file"), "{err}");
        let brief = serde_json::json!({"path": "/etc/hosts.md"});
        let err = invoke(DAEMON, "read_dropped_text", brief).expect_err("not dropped");
        assert!(err.to_string().contains("not a dropped file"), "{err}");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            for cmd in [
                "read_dropped_image",
                "read_dropped_text",
                "capture_webview",
                "clipboard_image",
            ] {
                let err = invoke(url, cmd, path.clone()).expect_err(&format!("{url} {cmd}"));
                assert!(
                    err.to_string().contains("not allowed"),
                    "{url} {cmd}: {err}"
                );
            }
        }
    }

    #[test]
    fn the_daemon_page_may_open_the_mail_window_and_no_other_page_may() {
        // No daemon is running in the mock: nothing to load, so no window
        // is made and the page is told to fall back to its tab.
        let got = invoke(DAEMON, "open_mail_window", serde_json::json!({})).expect("allowed");
        assert_eq!(got, serde_json::json!(false));
        // open_mail_app is not called from the daemon's page here: on a Mac
        // with the preview installed it would launch it.
        for url in ["https://example.com/", "http://localhost:4391/"] {
            for cmd in ["open_mail_app", "open_mail_window"] {
                let err = invoke(url, cmd, serde_json::json!({})).expect_err(url);
                assert!(
                    err.to_string().contains("not allowed"),
                    "{url} {cmd}: {err}"
                );
            }
        }
    }

    #[test]
    fn the_mail_window_may_open_links_and_nothing_else() {
        const MAIL: &str = "http://127.0.0.1:4391/?mail=1";
        let err = invoke_in(
            "mail",
            MAIL,
            "open_external",
            serde_json::json!({"url": "file:///etc/hosts"}),
        )
        .expect_err("a file URL");
        assert!(err.to_string().contains("refused"), "{err}");
        for (cmd, body) in [
            ("open_mail_app", serde_json::json!({})),
            ("open_mail_window", serde_json::json!({})),
            ("set_badge", serde_json::json!({"count": 1})),
            ("daemon_status", serde_json::json!({})),
        ] {
            let err = invoke_in("mail", MAIL, cmd, body).expect_err(cmd);
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }

    #[test]
    fn the_daemon_page_may_read_the_updater_and_no_other_page_may() {
        let st = invoke(DAEMON, "app_update_status", serde_json::json!({})).expect("allowed");
        assert_eq!(st["phase"], "idle");
        // `cargo test` is a development build: it says so and never updates.
        assert_eq!(st["supported"], false);
        assert!(st["blocked"].as_str().unwrap().contains("development"));
        // Refused for a development build without touching the network.
        let st = invoke(DAEMON, "app_update_install", serde_json::json!({})).expect("allowed");
        assert_eq!(st["phase"], "idle");
        // The background download refuses a development build the same way.
        let st = invoke(DAEMON, "app_update_download", serde_json::json!({})).expect("allowed");
        assert_eq!(st["phase"], "idle");
        for url in ["https://example.com/", "http://localhost:4391/"] {
            for cmd in [
                "app_update_status",
                "app_update_check",
                "app_update_download",
                "app_update_install",
                "app_update_asked",
            ] {
                let err = invoke(url, cmd, serde_json::json!({})).expect_err(cmd);
                assert!(
                    err.to_string().contains("not allowed"),
                    "{url} {cmd}: {err}"
                );
            }
        }
        for cmd in ["app_update_install", "app_update_download"] {
            let err = invoke_in("tray", POPOVER, cmd, serde_json::json!({})).expect_err("popover");
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }

    #[test]
    fn no_page_may_drive_the_updater_plugin_directly() {
        // Only our commands, which refuse unsupported installs and say why;
        // the plugin's own JavaScript commands are granted to nobody.
        for cmd in [
            "plugin:updater|check",
            "plugin:updater|download_and_install",
        ] {
            let err = invoke(DAEMON, cmd, serde_json::json!({})).expect_err(cmd);
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }

    const POPOVER: &str = "http://127.0.0.1:4391/?app=1#/tray";

    #[test]
    fn the_popover_may_hide_size_and_open_and_read_the_hotkey() {
        invoke_in("tray", POPOVER, "tray_hide", serde_json::json!({})).expect("tray_hide");
        invoke_in(
            "tray",
            POPOVER,
            "tray_fit",
            serde_json::json!({"height": 300.0}),
        )
        .expect("tray_fit");
        invoke_in(
            "tray",
            POPOVER,
            "tray_open",
            serde_json::json!({"session": null}),
        )
        .expect("tray_open");
        invoke_in("tray", POPOVER, "hotkey_status", serde_json::json!({})).expect("hotkey");
    }

    #[test]
    fn the_popover_may_not_do_what_the_main_page_does() {
        // daemon_status above all: a page polling it owns the "daemon
        // stopped" banner, and the popover is not that page.
        for (cmd, body) in [
            ("daemon_status", serde_json::json!({})),
            ("set_tray", serde_json::json!({"view": {}})),
            ("set_badge", serde_json::json!({"count": 1})),
            ("register_hotkey", serde_json::json!({"accelerator": null})),
            ("notify", serde_json::json!({"title": "x", "body": ""})),
            (
                "open_external",
                serde_json::json!({"url": "https://example.com/"}),
            ),
        ] {
            let err = invoke_in("tray", POPOVER, cmd, body).expect_err(cmd);
            assert!(err.to_string().contains("not allowed"), "{cmd}: {err}");
        }
    }

    #[test]
    fn only_the_popover_may_call_the_popover_commands() {
        for (label, url) in [
            ("main", DAEMON),
            ("tray", "https://example.com/"),
            ("tray", "http://localhost:4391/"),
        ] {
            let err = invoke_in(label, url, "tray_hide", serde_json::json!({}))
                .expect_err(&format!("{label} {url}"));
            assert!(
                err.to_string().contains("not allowed"),
                "{label} {url}: {err}"
            );
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

    // The 0.123.0 drop bug: the dashboard became a child webview of the
    // window, its drops arrived as WebviewEvent::DragDrop, and the window
    // listener the app had heard nothing. Since the Page tab was withdrawn
    // the dashboard is the window's content again and drops come as
    // WindowEvent::DragDrop; the app hears both, through one handler.
    // Tauri's mock runtime keeps no listeners (MockWebviewDispatcher drops
    // the closure), so a test cannot emit an event through it. The closest
    // it can do: build the main window and register the listeners as the
    // app does, hand the handler the event Tauri would, and check in the
    // source that both registrations reach it.
    #[test]
    fn a_drop_on_the_main_window_reaches_the_drop_handler() {
        let dir = std::env::temp_dir().join(format!("caprock-drop-{}", std::process::id()));
        let app = configure(mock_builder(), Supervisor::new(dir))
            .build(tauri::generate_context!(test = true))
            .expect("mock app");
        let page: tauri::Url = DAEMON.parse().unwrap();
        let w = WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(page))
            .build()
            .unwrap();
        shell::listen_for_drops(&w);
        let p = PathBuf::from("/tmp/caprock e2e/notes.txt");
        let drop = tauri::DragDropEvent::Drop {
            paths: vec![p.clone()],
            position: tauri::PhysicalPosition::new(10.0, 20.0),
        };
        shell::on_drop(&w, &drop);
        assert!(
            app.state::<capture::Dropped>().contains(&p),
            "the drop's path was not recorded"
        );
        // A drag that leaves is not a drop: the last drop's paths stay.
        shell::on_drop(&w, &tauri::DragDropEvent::Leave);
        assert!(app.state::<capture::Dropped>().contains(&p));
    }

    #[test]
    fn a_drop_is_heard_on_the_window_and_the_webview_by_one_handler() {
        // A Windows checkout may carry CRLF line ends.
        let src = include_str!("shell.rs").replace("\r\n", "\n");
        let code = |s: &str| -> String {
            s.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let body = |head: &str| -> String {
            let rest = src.split(head).nth(1).unwrap_or_else(|| panic!("{head}"));
            code(rest.split("\n}\n").next().unwrap_or(rest))
        };
        let listen = body("pub fn listen_for_drops");
        for (listener, event) in [
            (".on_window_event(", "tauri::WindowEvent::DragDrop("),
            (".on_webview_event(", "tauri::WebviewEvent::DragDrop("),
        ] {
            assert!(listen.contains(listener), "no {listener}: {listen}");
            assert!(listen.contains(event), "no {event}: {listen}");
        }
        assert_eq!(
            listen.matches("on_drop(").count(),
            2,
            "each listener hands its drop to the one on_drop: {listen}"
        );
        assert!(
            body("pub fn build(").contains("listen_for_drops(&w)"),
            "the main window is built without its drop listeners"
        );
        assert_eq!(
            code(&src).matches("DragDrop(").count(),
            2,
            "a drop is handled somewhere other than listen_for_drops"
        );
    }

    /// ⌘W closes the tab in front of the main window and any other window
    /// whole (owner, 2026-10-16); the menu holds the key, so the page would
    /// never see it otherwise.
    #[cfg(target_os = "macos")]
    #[test]
    fn cmd_w_closes_the_tab_not_the_main_window() {
        use menu::{close_target, CloseTarget};
        assert_eq!(close_target(Some(shell::MAIN)), CloseTarget::Tab);
        assert_eq!(
            close_target(Some(mail::MAIL)),
            CloseTarget::Window(mail::MAIL.into())
        );
        assert_eq!(
            close_target(Some(popover::POPOVER)),
            CloseTarget::Window(popover::POPOVER.into())
        );
        assert_eq!(close_target(None), CloseTarget::Nothing);
        // A browser tab's page has the keyboard: ⌘W closes its tab.
        assert_eq!(close_target(Some("browser-lx2a-1")), CloseTarget::Tab);
        // The menu itself cannot be built here (muda makes its items on the
        // main thread only), so what `arrange` puts in it is read from source.
        let src = include_str!("main.rs");
        let menu = src.split("mod menu {").nth(1).expect("mod menu");
        let menu = menu.split("#[cfg(test)]").next().unwrap_or(menu);
        assert!(
            menu.contains(r#""Close Tab", true, Some("CmdOrCtrl+W")"#),
            "File -> Close Tab no longer holds ⌘W"
        );
        assert!(
            menu.contains(r#""Close Window", true, None::<&str>"#),
            "Window -> Close Window took a key back"
        );
        assert!(
            menu.contains(r#"p.text()?.replace('&', "") != "Close Window""#),
            "the default Close Window is no longer looked for"
        );
        assert!(
            menu.contains("arrange(app, &menu)?"),
            "install no longer rearranges the menu"
        );
        assert!(
            menu.contains("caprock:close-tab"),
            "Close Tab no longer tells the page"
        );
        assert!(
            menu.contains(r#""New Browser Tab""#) && menu.contains("NativeIcon::Network"),
            "File -> New Browser Tab is gone or no longer marked as a browser"
        );
        assert!(
            menu.contains("caprock:open-browser"),
            "New Browser Tab no longer tells the page"
        );
    }
}

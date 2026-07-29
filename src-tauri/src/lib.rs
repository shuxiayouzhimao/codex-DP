mod server;
mod state_machine;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{
        CheckMenuItemBuilder, ContextMenu, IsMenuItem, Menu, MenuBuilder, MenuItem,
        SubmenuBuilder,
    },
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};

use state_machine::EventRouter;
use tauri_plugin_autostart::ManagerExt;

/// “全部会话”菜单项 id 前缀；具体会话项为 "sess:source:sessionId"
const SESS_PREFIX: &str = "sess:";
const SESS_ALL: &str = "sess:__all__";
/// 换肤菜单项 id 前缀（"skin:green" / "skin:red"）
const SKIN_PREFIX: &str = "skin:";

/// 持久化的窗口位置
#[derive(Serialize, Deserialize, Default, Clone, Copy)]
struct WindowState {
    x: i32,
    y: i32,
}

/// 共享设置（配置面板/右键菜单修改，广播 settings-changed 给所有窗口）。
/// 字段为 camelCase，与前端 Settings 接口一致。
#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Settings {
    /// 皮肤："green" | "red"
    pub skin: String,
    /// true=终态保持到点击确认；false=终态 ~5s 自动回闲置
    pub click_to_dismiss: bool,
    /// 终态兜底时长（clickToDismiss=true 时生效）
    pub terminal_hold_ms: u64,
    /// 工作态无事件的安全网衰减
    pub work_decay_ms: u64,
    /// 开机自启（同步到系统注册表 Run 键）
    pub autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            skin: "green".into(),
            click_to_dismiss: true,
            terminal_hold_ms: 30 * 60_000,
            work_decay_ms: 5 * 60_000,
            autostart: true,
        }
    }
}

/// 运行期状态：待落盘的位置 + 最近一次移动时间（防抖）+ 事件路由 + 托盘句柄（用于刷新菜单）+ 共享设置
pub(crate) struct AppState {
    pending: Mutex<Option<(i32, i32)>>,
    last_change: Mutex<Instant>,
    pub(crate) router: EventRouter,
    pub(crate) tray: Mutex<Option<TrayIcon>>,
    pub(crate) settings: Mutex<Settings>,
}

fn state_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .expect("app_config_dir unavailable");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("window-state.json")
}

fn settings_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .expect("app_config_dir unavailable");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn load_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let data = std::fs::read_to_string(state_path(app)).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_state(app: &tauri::AppHandle, state: WindowState) {
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(state_path(app), json);
    }
}

fn load_settings(app: &tauri::AppHandle) -> Option<Settings> {
    let data = std::fs::read_to_string(settings_path(app)).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_settings(app: &tauri::AppHandle, settings: &Settings) {
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(settings_path(app), json);
    }
}

/// 构建菜单（托盘右键 & 宠物右键共用）：显示 / 隐藏 / [换肤 子菜单] / [监听会话 子菜单] / 设置… / 退出。
/// 换肤为单选勾选（据当前 settings.skin）；会话子菜单含“全部会话”+ 各活跃会话。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show_i = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", "隐藏", true, None::<&str>)?;
    let config_i = MenuItem::with_id(app, "open-config", "设置…", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let state = app.state::<AppState>();
    let filter = state.router.get_filter();
    let sessions = state.router.list_sessions();
    let skin = state.settings.lock().unwrap().skin.clone();
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let autostart_i = CheckMenuItemBuilder::with_id("autostart", "开机自启")
        .enabled(true)
        .checked(autostart_on)
        .build(app)?;
    let green_i = CheckMenuItemBuilder::with_id(format!("{SKIN_PREFIX}green"), "绿毛衣")
        .enabled(true)
        .checked(skin == "green")
        .build(app)?;
    let red_i = CheckMenuItemBuilder::with_id(format!("{SKIN_PREFIX}red"), "红装")
        .enabled(true)
        .checked(skin == "red")
        .build(app)?;
    let skin_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&green_i, &red_i];
    let skin_sub = SubmenuBuilder::new(app, "换肤")
        .enabled(true)
        .items(&skin_refs)
        .build()?;

    let all_i = CheckMenuItemBuilder::with_id(SESS_ALL, "全部会话")
        .enabled(true)
        .checked(filter.is_none())
        .build(app)?;

    let mut sub_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&all_i];
    let mut sess_items = Vec::new();
    for s in &sessions {
        let id = format!("{SESS_PREFIX}{}", s.key);
        let checked = filter.as_deref() == Some(s.key.as_str());
        sess_items.push(
            CheckMenuItemBuilder::with_id(id, &s.label)
                .enabled(true)
                .checked(checked)
                .build(app)?,
        );
    }
    for it in &sess_items {
        sub_refs.push(it);
    }

    let sub = SubmenuBuilder::new(app, "监听会话")
        .enabled(true)
        .items(&sub_refs)
        .build()?;

    let menu_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![
        &show_i,
        &hide_i,
        &skin_sub,
        &sub,
        &autostart_i,
        &config_i,
        &quit_i,
    ];
    MenuBuilder::new(app).items(&menu_refs).build()
}

/// 刷新托盘菜单（在主线程执行）。会话列表变化或过滤选择变化后调用。
pub(crate) fn refresh_menu(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        let tray = state.tray.lock().unwrap();
        if let Some(tray) = tray.as_ref() {
            if let Ok(menu) = build_menu(&handle) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
}

/// 应用 autostart 设置到系统（注册表 Run 键），并把 Settings 落盘 + 广播 + 刷新菜单。
fn apply_autostart(app: &AppHandle, enabled: bool) {
    let mgr = app.autolaunch();
    let r = if enabled { mgr.enable() } else { mgr.disable() };
    if let Err(e) = r {
        eprintln!("[pet-settings] autostart {} 失败: {e}", enabled);
    }
    let state = app.state::<AppState>();
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.autostart = enabled;
        s.clone()
    };
    save_settings(app, &snapshot);
    let _ = app.emit("settings-changed", &snapshot);
    refresh_menu(app);
}

/// 菜单点击（应用级：托盘菜单与宠物右键菜单共用同一分发）：显示/隐藏/退出 + 换肤 + 自启 + 打开设置 + 会话过滤
fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id.as_ref();
    match id {
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "quit" => {
            app.exit(0);
        }
        "autostart" => {
            let on = !app.autolaunch().is_enabled().unwrap_or(false);
            apply_autostart(app, on);
        }
        "open-config" => {
            println!("[pet-menu] open-config clicked");
            match app.get_webview_window("config") {
                Some(w) => {
                    let _ = w.unminimize();
                    let r = w.show();
                    println!("[pet-menu] config show -> {:?}", r);
                    let _ = w.set_focus();
                }
                None => println!("[pet-menu] config window MISSING（被销毁？）"),
            }
        }
        _ => {
            if let Some(skin) = id.strip_prefix(SKIN_PREFIX) {
                // 换肤：更新设置 → 落盘 → 广播 → 刷新菜单勾选
                let state = app.state::<AppState>();
                let snapshot = {
                    let mut s = state.settings.lock().unwrap();
                    s.skin = skin.to_string();
                    s.clone()
                };
                save_settings(app, &snapshot);
                let _ = app.emit("settings-changed", &snapshot);
                refresh_menu(app);
            } else if let Some(rest) = id.strip_prefix(SESS_PREFIX) {
                // "__all__" → 监听全部；否则锁定到该 "source:sessionId"
                let filter = if rest == "__all__" {
                    None
                } else {
                    Some(rest.to_string())
                };
                let state = app.state::<AppState>();
                state.router.set_filter(filter.clone());
                // 通知前端应用过滤（None 序列化为 null）
                let _ = app.emit("session-filter", filter);
                refresh_menu(app);
            }
        }
    }
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    app.state::<AppState>().settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) {
    // 同步自启到注册表（配置面板/外部改动统一在此生效）
    let autostart = settings.autostart;
    *app.state::<AppState>().settings.lock().unwrap() = settings.clone();
    let mgr = app.autolaunch();
    let r = if autostart { mgr.enable() } else { mgr.disable() };
    if let Err(e) = r {
        eprintln!("[pet-settings] autostart {autostart} 失败: {e}");
    }
    save_settings(&app, &settings);
    let _ = app.emit("settings-changed", &settings);
    refresh_menu(&app);
}

/// 宠物右键：在光标处弹出与托盘一致的原生菜单（主线程执行，Windows 弹菜单要求）。
#[tauri::command]
fn show_pet_menu(window: tauri::Window) {
    let app = window.app_handle().clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(menu) = build_menu(&handle) {
            let _ = menu.popup(window);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(AppState {
            pending: Mutex::new(None),
            last_change: Mutex::new(Instant::now()),
            router: EventRouter::default(),
            tray: Mutex::new(None),
            settings: Mutex::new(Settings::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            show_pet_menu
        ])
        // 应用级菜单事件：托盘菜单与宠物右键菜单（id 一致）共用此分发
        .on_menu_event(on_menu_event)
        .on_window_event(|window, event| {
            // 仅主宠物窗口：移动时记录位置，防抖落盘交给后台线程
            if window.label() == "main" {
                if let WindowEvent::Moved(pos) = event {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    *state.pending.lock().unwrap() = Some((pos.x, pos.y));
                    *state.last_change.lock().unwrap() = Instant::now();
                }
            }
            // 配置窗口点 X 时改为隐藏而非销毁——窗口保留，下次「设置…」可再打开
            if window.label() == "config" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // 载入持久化设置（换肤勾选/广播以此为初值）
            if let Some(s) = load_settings(&handle) {
                *handle.state::<AppState>().settings.lock().unwrap() = s;
            }
            // 应用自启设置到注册表（默认 true：首装即自启；用户关闭过则保持关闭）
            {
                let on = handle.state::<AppState>().settings.lock().unwrap().autostart;
                let mgr = handle.autolaunch();
                let r = if on { mgr.enable() } else { mgr.disable() };
                if let Err(e) = r {
                    eprintln!("[pet-settings] 启动应用 autostart={on} 失败: {e}");
                }
            }

            // 恢复窗口位置；首次启动默认置于主屏右下
            let window = handle
                .get_webview_window("main")
                .expect("main window missing");
            match load_state(&handle) {
                Some(ws) => {
                    let _ = window.set_position(PhysicalPosition::new(ws.x, ws.y));
                }
                None => {
                    if let Ok(Some(mon)) = window.primary_monitor() {
                        let s = mon.size();
                        let p = mon.position();
                        let x = p.x + s.width as i32 - 200 - 40;
                        let y = p.y + s.height as i32 - 200 - 90;
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                }
            }
            let _ = window.show();
            let _ = window.set_focus();

            // 系统托盘：显示 / 隐藏 / 监听会话 / 退出；左键单击切换显隐
            let menu = build_menu(&handle)?;
            let icon = handle
                .default_window_icon()
                .cloned()
                .expect("default window icon missing");
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Codex Pet")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(&handle)?;
            // 存托盘句柄，供后续刷新菜单（并保持托盘存活）
            *handle.state::<AppState>().tray.lock().unwrap() = Some(tray);

            // Phase 3：本地事件推送 server（HTTP POST /event）
            server::start(handle.clone(), 4271);

            // 位置防抖落盘：拖动结束 ~400ms 后写一次 window-state.json
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(300));
                let state = handle.state::<AppState>();
                let pos = *state.pending.lock().unwrap();
                let Some((x, y)) = pos else { continue };
                let elapsed = state.last_change.lock().unwrap().elapsed();
                if elapsed >= Duration::from_millis(400) {
                    *state.pending.lock().unwrap() = None;
                    save_state(&handle, WindowState { x, y });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

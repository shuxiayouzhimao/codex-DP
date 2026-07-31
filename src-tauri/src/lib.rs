mod server;
mod state_machine;
mod hooks_cmd;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{
        CheckMenuItemBuilder, ContextMenu, IsMenuItem, Menu, MenuBuilder, MenuItem,
        SubmenuBuilder,
    },
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, UserAttentionType, WindowEvent,
};

use state_machine::EventRouter;
use tauri_plugin_autostart::ManagerExt;

/// “全部会话”菜单项 id 前缀；具体会话项为 "sess:source:sessionId"
const SESS_PREFIX: &str = "sess:";
const SESS_ALL: &str = "sess:__all__";
/// 换肤菜单项 id 前缀（"skin:green" / "skin:red"）
const SKIN_PREFIX: &str = "skin:";

/// 皮肤清单（与前端 src/assets/skins.json 同源，编译期嵌入）
#[derive(Deserialize)]
struct SkinCatalogEntry {
    key: String,
    name: String,
}

fn skin_catalog() -> Vec<SkinCatalogEntry> {
    serde_json::from_str(include_str!("../../src/assets/skins.json")).unwrap_or_default()
}

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
    /// 皮肤：见 src/assets/skins.json（菜单与前端同源）
    pub skin: String,
    /// true=终态保持到点击确认；false=终态 ~5s 自动回闲置
    pub click_to_dismiss: bool,
    /// 终态兜底时长（clickToDismiss=true 时生效）
    pub terminal_hold_ms: u64,
    /// 工作态无事件的安全网衰减
    pub work_decay_ms: u64,
    /// 开机自启（同步到系统注册表 Run 键）
    pub autostart: bool,
    /// 智能文案总开关（默认关；关时气泡回退 detail/label）
    pub copy_enabled: bool,
    /// 文案 Provider："off" | "rules" | "openai"
    pub copy_provider: String,
    /// OpenAI 兼容 API Base URL（如 https://api.deepseek.com/v1）
    pub copy_base_url: String,
    /// API Key（存 settings.json；不写日志）
    pub copy_api_key: String,
    /// Chat Completions model；空则用 deepseek-chat
    pub copy_model: String,
    /// 首次引导是否已完成（气泡三句提示）
    pub onboarding_done: bool,
    /// 宠物缩放：0.75 / 1.0 / 1.4（逻辑边长 = round(200 * scale)）
    pub pet_scale: f64,
    /// 进入完成/出错时请求用户注意（任务栏闪烁等）
    pub terminal_notify: bool,
    /// openai 模式下仅终态走 API；工作态用规则模板
    pub copy_ai_terminal_only: bool,
    /// 连接提示：久无事件 / hooks 需补装（默认开）
    pub connection_hints: bool,
    /// 无事件多久后提示「好像没接到 Agent」（ms）
    pub silence_hint_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            skin: "green-anim".into(),
            click_to_dismiss: true,
            terminal_hold_ms: 30 * 60_000,
            work_decay_ms: 5 * 60_000,
            autostart: true,
            copy_enabled: false,
            copy_provider: "rules".into(),
            copy_base_url: String::new(),
            copy_api_key: String::new(),
            copy_model: String::new(),
            onboarding_done: false,
            pet_scale: 1.0,
            terminal_notify: true,
            copy_ai_terminal_only: false,
            connection_hints: true,
            silence_hint_ms: 30 * 60_000,
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
    /// 托盘菜单指纹（会话列表/过滤/皮肤/自启）；未变则跳过重建
    pub(crate) menu_fp: Mutex<String>,
    /// 菜单刷新已排队（防抖合并）
    pub(crate) menu_refresh_pending: Mutex<bool>,
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
    let reset_pos_i = MenuItem::with_id(app, "reset-position", "重置位置", true, None::<&str>)?;
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
    let catalog = skin_catalog();
    let mut skin_items = Vec::new();
    for entry in &catalog {
        let item = CheckMenuItemBuilder::with_id(format!("{SKIN_PREFIX}{}", entry.key), &entry.name)
            .enabled(true)
            .checked(skin == entry.key)
            .build(app)?;
        skin_items.push(item);
    }
    let skin_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = skin_items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
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
        &reset_pos_i,
        &config_i,
        &quit_i,
    ];
    MenuBuilder::new(app).items(&menu_refs).build()
}

/// 角色画布边长之上/下留白（与前端 settings.ts PET_CHROME_* 对齐）
const PET_CHROME_TOP: u32 = 44;
const PET_CHROME_BOTTOM: u32 = 24;

/// 逻辑边长（px）：基准 200 × pet_scale，钳制到常见三档附近（仅角色区）
pub(crate) fn pet_logical_size(scale: f64) -> u32 {
    let s = if (scale - 0.75).abs() < 0.05 {
        0.75
    } else if (scale - 1.4).abs() < 0.05 {
        1.4
    } else {
        1.0
    };
    (200.0_f64 * s).round() as u32
}

fn pet_window_logical(scale: f64) -> (u32, u32) {
    let side = pet_logical_size(scale);
    (side, side + PET_CHROME_TOP + PET_CHROME_BOTTOM)
}

fn apply_pet_window_size(app: &AppHandle) {
    let scale = app.state::<AppState>().settings.lock().unwrap().pet_scale;
    let (w, h) = pet_window_logical(scale);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_size(LogicalSize::new(w as f64, h as f64));
    }
}

/// 主屏工作区内右下（避开任务栏）；逻辑尺寸按 DPI 换成物理像素
fn place_pet_default(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main 窗口不存在".to_string())?;
    apply_pet_window_size(app);
    let scale = app.state::<AppState>().settings.lock().unwrap().pet_scale;
    let (lw, lh) = pet_window_logical(scale);
    if let Ok(Some(mon)) = window.primary_monitor() {
        let sf = mon.scale_factor();
        let wa = mon.work_area();
        let w_phys = (lw as f64 * sf).round() as i32;
        let h_phys = (lh as f64 * sf).round() as i32;
        let margin = (16.0 * sf).round() as i32;
        let x = wa.position.x + wa.size.width as i32 - w_phys - margin;
        let y = wa.position.y + wa.size.height as i32 - h_phys - margin;
        let (x, y) = clamp_to_work_area(&window, x, y, w_phys, h_phys);
        let _ = window.set_position(PhysicalPosition::new(x, y));
        save_state(app, WindowState { x, y });
    }
    let _ = window.show();
    Ok(())
}

/// 把窗口左上角钳进主屏工作区，避免任务栏/屏幕外遮挡
fn clamp_to_work_area(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    w_phys: i32,
    h_phys: i32,
) -> (i32, i32) {
    let Ok(Some(mon)) = window.primary_monitor() else {
        return (x, y);
    };
    let sf = mon.scale_factor();
    let wa = mon.work_area();
    let margin = (8.0 * sf).round() as i32;
    let min_x = wa.position.x + margin;
    let min_y = wa.position.y + margin;
    let max_x = wa.position.x + wa.size.width as i32 - w_phys - margin;
    let max_y = wa.position.y + wa.size.height as i32 - h_phys - margin;
    (
        x.clamp(min_x, max_x.max(min_x)),
        y.clamp(min_y, max_y.max(min_y)),
    )
}

/// 托盘菜单内容指纹：会话键/标签 + 过滤 + 皮肤 + 自启。同态工具切换不会改指纹。
fn menu_fingerprint(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let filter = state.router.get_filter().unwrap_or_default();
    let sessions = state.router.list_sessions();
    let skin = state.settings.lock().unwrap().skin.clone();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let sess: String = sessions
        .iter()
        .map(|s| format!("{}={}", s.key, s.label))
        .collect::<Vec<_>>()
        .join("|");
    format!("{filter}|{sess}|{skin}|{autostart}")
}

/// 刷新托盘菜单（主线程）。会话指纹未变则跳过；有变则 ≥400ms 合并重建。
pub(crate) fn refresh_menu(app: &AppHandle) {
    let fp = menu_fingerprint(app);
    let state = app.state::<AppState>();
    {
        let last = state.menu_fp.lock().unwrap();
        if *last == fp {
            return;
        }
    }
    {
        let mut pending = state.menu_refresh_pending.lock().unwrap();
        if *pending {
            return;
        }
        *pending = true;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let state = main.state::<AppState>();
            *state.menu_refresh_pending.lock().unwrap() = false;
            let fp = menu_fingerprint(&main);
            {
                let mut last = state.menu_fp.lock().unwrap();
                if *last == fp {
                    return;
                }
                *last = fp;
            }
            let tray = state.tray.lock().unwrap();
            if let Some(tray) = tray.as_ref() {
                if let Ok(menu) = build_menu(&main) {
                    let _ = tray.set_menu(Some(menu));
                }
            }
        });
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
            open_config_window(app);
        }
        "reset-position" => {
            if let Err(e) = place_pet_default(app) {
                eprintln!("[pet-menu] reset-position 失败: {e}");
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

fn open_config_window(app: &AppHandle) {
    println!("[pet-menu] open-config");
    match app.get_webview_window("config") {
        Some(w) => {
            // 启动时若 Vite 尚未就绪，config 可能卡在 ERR_EMPTY_RESPONSE；
            // 打开时 reload 一次，避免一直显示错误页。
            let _ = w.reload();
            let _ = w.unminimize();
            let r = w.show();
            println!("[pet-menu] config show -> {:?}", r);
            let _ = w.set_focus();
        }
        None => println!("[pet-menu] config window MISSING（被销毁？）"),
    }
}

#[tauri::command]
fn open_config(app: AppHandle) {
    open_config_window(&app);
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
    apply_pet_window_size(&app);
    let _ = app.emit("settings-changed", &settings);
    refresh_menu(&app);
}

/// OpenAI 兼容 Chat Completions；Base URL / Key / model 从 Settings 读取。
/// 超时约 4s；错误返回 Err 字符串；**绝不把 Key 写入日志**。
#[tauri::command]
async fn chat_complete(
    app: AppHandle,
    system: String,
    user: String,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    let (base, key, model) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (
            s.copy_base_url.trim().trim_end_matches('/').to_string(),
            s.copy_api_key.clone(),
            if s.copy_model.trim().is_empty() {
                "deepseek-chat".into()
            } else {
                s.copy_model.trim().to_string()
            },
        )
    };
    if base.is_empty() {
        return Err("未配置 Base URL".into());
    }
    if key.trim().is_empty() {
        return Err("未配置 API Key".into());
    }
    let url = format!("{base}/chat/completions");
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "max_tokens": max_tokens.unwrap_or(48),
        "temperature": 0.7,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "请求超时".into()
            } else {
                format!("网络错误: {e}")
            }
        })?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("读响应失败: {e}"))?;
    if !status.is_success() {
        // 不回显可能含敏感信息的完整 body，只给状态码 + 截断提示
        let hint: String = text.chars().take(120).collect();
        return Err(format!("API {status}: {hint}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "API 返回空文案".to_string())?;
    Ok(content)
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

#[tauri::command]
fn hooks_status(app: AppHandle) -> hooks_cmd::HooksStatus {
    hooks_cmd::hooks_status(&app)
}

#[tauri::command]
fn install_hooks(app: AppHandle, source: String) -> Result<String, String> {
    hooks_cmd::run_install_hooks(&app, &source, false)
}

#[tauri::command]
fn uninstall_hooks(app: AppHandle, source: String) -> Result<String, String> {
    hooks_cmd::run_install_hooks(&app, &source, true)
}

#[tauri::command]
fn probe_event_channel() -> Result<String, String> {
    hooks_cmd::probe_event_channel()
}

#[tauri::command]
fn reset_pet_position(app: AppHandle) -> Result<(), String> {
    place_pet_default(&app)
}

#[tauri::command]
fn list_sessions(app: AppHandle) -> Vec<state_machine::SessionEntry> {
    app.state::<AppState>().router.list_sessions()
}

#[tauri::command]
fn set_session_filter(app: AppHandle, key: Option<String>) {
    app.state::<AppState>().router.set_filter(key.clone());
    let _ = app.emit("session-filter", key);
    refresh_menu(&app);
}

#[tauri::command]
fn get_session_filter(app: AppHandle) -> Option<String> {
    app.state::<AppState>().router.get_filter()
}

/// 终态提醒：请求用户注意（任务栏闪烁）；失败静默
#[tauri::command]
fn notify_terminal(app: AppHandle, kind: String) {
    let enabled = app.state::<AppState>().settings.lock().unwrap().terminal_notify;
    if !enabled {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        let _ = w.show();
    }
    eprintln!("[pet-notify] terminal {kind}");
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
            menu_fp: Mutex::new(String::new()),
            menu_refresh_pending: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            open_config,
            chat_complete,
            show_pet_menu,
            hooks_status,
            install_hooks,
            uninstall_hooks,
            probe_event_channel,
            reset_pet_position,
            list_sessions,
            set_session_filter,
            get_session_filter,
            notify_terminal
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

            // 恢复窗口位置与尺寸；首次启动默认置于主屏工作区右下；已存位置钳进工作区防任务栏遮挡
            apply_pet_window_size(&handle);
            let window = handle
                .get_webview_window("main")
                .expect("main window missing");
            let scale = handle.state::<AppState>().settings.lock().unwrap().pet_scale;
            let (lw, lh) = pet_window_logical(scale);
            match load_state(&handle) {
                Some(ws) => {
                    let sf = window
                        .primary_monitor()
                        .ok()
                        .flatten()
                        .map(|m| m.scale_factor())
                        .unwrap_or(1.0);
                    let w_phys = (lw as f64 * sf).round() as i32;
                    let h_phys = (lh as f64 * sf).round() as i32;
                    let (x, y) = clamp_to_work_area(&window, ws.x, ws.y, w_phys, h_phys);
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                    if x != ws.x || y != ws.y {
                        save_state(&handle, WindowState { x, y });
                    }
                }
                None => {
                    if let Err(e) = place_pet_default(&handle) {
                        eprintln!("[pet] 默认落位失败: {e}");
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

#[cfg(test)]
mod settings_tests {
    use super::{pet_logical_size, pet_window_logical, skin_catalog, Settings, PET_CHROME_BOTTOM, PET_CHROME_TOP};

    #[test]
    fn settings_default_copy_disabled() {
        let s = Settings::default();
        assert!(!s.copy_enabled);
        assert_eq!(s.copy_provider, "rules");
        assert!(s.copy_api_key.is_empty());
        assert_eq!(s.skin, "green-anim");
        assert!(!s.onboarding_done);
        assert!((s.pet_scale - 1.0).abs() < f64::EPSILON);
        assert!(s.terminal_notify);
        assert!(!s.copy_ai_terminal_only);
        assert!(s.connection_hints);
        assert_eq!(s.silence_hint_ms, 30 * 60_000);
    }

    #[test]
    fn pet_logical_size_presets() {
        assert_eq!(pet_logical_size(0.75), 150);
        assert_eq!(pet_logical_size(1.0), 200);
        assert_eq!(pet_logical_size(1.4), 280);
        assert_eq!(pet_logical_size(0.9), 200); // 非三档 → 中
        let (w, h) = pet_window_logical(1.0);
        assert_eq!(w, 200);
        assert_eq!(h, 200 + PET_CHROME_TOP + PET_CHROME_BOTTOM);
    }

    #[test]
    fn skin_catalog_matches_json() {
        let cat = skin_catalog();
        assert!(cat.iter().any(|s| s.key == "green-anim"));
        assert!(cat.iter().any(|s| s.key == "green"));
        assert!(cat.iter().any(|s| s.key == "red"));
    }

    #[test]
    fn settings_old_json_missing_copy_fields() {
        // 旧版 settings.json 无智能文案字段 → serde default 填齐
        let s: Settings = serde_json::from_str(
            r#"{"skin":"green","clickToDismiss":true,"terminalHoldMs":1000,"workDecayMs":2000,"autostart":false}"#,
        )
        .unwrap();
        assert!(!s.copy_enabled);
        assert_eq!(s.copy_provider, "rules");
        assert!(!s.autostart);
        assert_eq!(s.work_decay_ms, 2000);
        assert!((s.pet_scale - 1.0).abs() < f64::EPSILON);
        assert!(s.terminal_notify);
        assert!(!s.copy_ai_terminal_only);
        assert!(s.connection_hints);
        assert_eq!(s.silence_hint_ms, 30 * 60_000);
    }
}

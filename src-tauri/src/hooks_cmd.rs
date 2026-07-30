//! 应用内 Hooks 安装 / 状态探测（调用 adapters/*/install-hooks.mjs，不复制事件列表）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceHookStatus {
    pub source: String,
    pub label: String,
    pub installed: bool,
    pub config_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    pub node_ok: bool,
    pub node_version: Option<String>,
    pub adapters_ok: bool,
    pub adapters_path: Option<String>,
    pub sources: Vec<SourceHookStatus>,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 开发态：仓库 `adapters/`；安装版：`$RESOURCE/adapters`。
pub fn adapters_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        let packaged = res.join("adapters");
        if packaged
            .join("claude-code")
            .join("install-hooks.mjs")
            .is_file()
        {
            return Ok(packaged);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("adapters");
    let dev = std::fs::canonicalize(&dev).unwrap_or(dev);
    if dev
        .join("claude-code")
        .join("install-hooks.mjs")
        .is_file()
    {
        return Ok(dev);
    }
    Err("找不到 adapters（开发请在仓库根运行；安装版需打入 bundle.resources）".into())
}

fn install_script(adapters: &Path, source: &str) -> Result<PathBuf, String> {
    let dir = match source {
        "claude-code" => adapters.join("claude-code"),
        "codex" => adapters.join("codex"),
        "cursor" => adapters.join("cursor"),
        _ => return Err(format!("未知 source: {source}（claude-code|codex|cursor）")),
    };
    let script = dir.join("install-hooks.mjs");
    if !script.is_file() {
        return Err(format!("安装脚本不存在: {}", script.display()));
    }
    Ok(script)
}

fn find_node() -> Result<PathBuf, String> {
    // PATH 上的 node
    if let Ok(out) = Command::new("node").arg("-v").output() {
        if out.status.success() {
            return Ok(PathBuf::from("node"));
        }
    }
    // Windows 常见安装路径
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("未找到 Node.js。请安装 Node 并确保 `node` 在 PATH 中。".into())
}

fn node_version() -> Option<String> {
    let node = find_node().ok()?;
    let out = Command::new(node).arg("-v").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn file_contains_pet_bridge(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.contains("pet-bridge.mjs"))
        .unwrap_or(false)
}

pub fn hooks_status(app: &AppHandle) -> HooksStatus {
    let home = home_dir();
    let node_version = node_version();
    let node_ok = node_version.is_some();

    let (adapters_ok, adapters_path) = match adapters_dir(app) {
        Ok(p) => (true, Some(p.display().to_string())),
        Err(_) => (false, None),
    };

    let sources = vec![
        SourceHookStatus {
            source: "claude-code".into(),
            label: "Claude Code".into(),
            config_path: home.join(".claude").join("settings.json").display().to_string(),
            installed: file_contains_pet_bridge(&home.join(".claude").join("settings.json")),
        },
        SourceHookStatus {
            source: "codex".into(),
            label: "Codex CLI".into(),
            config_path: home.join(".codex").join("hooks.json").display().to_string(),
            installed: file_contains_pet_bridge(&home.join(".codex").join("hooks.json")),
        },
        SourceHookStatus {
            source: "cursor".into(),
            label: "Cursor".into(),
            config_path: home.join(".cursor").join("hooks.json").display().to_string(),
            installed: file_contains_pet_bridge(&home.join(".cursor").join("hooks.json")),
        },
    ];

    HooksStatus {
        node_ok,
        node_version,
        adapters_ok,
        adapters_path,
        sources,
    }
}

pub fn run_install_hooks(app: &AppHandle, source: &str, uninstall: bool) -> Result<String, String> {
    let adapters = adapters_dir(app)?;
    let script = install_script(&adapters, source)?;
    let node = find_node()?;
    let mut cmd = Command::new(&node);
    cmd.arg(&script);
    if uninstall {
        cmd.arg("--uninstall");
    }
    // 保证相对路径（如 codex → ../claude-code/pet-bridge）以脚本目录为基准
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("启动 node 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("install-hooks 退出码 {:?}", out.status.code())
        });
    }
    Ok(if stdout.is_empty() {
        if uninstall {
            "已卸载".into()
        } else {
            "已安装".into()
        }
    } else {
        stdout
    })
}

/// POST 本机事件通道；确认 4271 可写（桌宠自己在跑时必通）。
pub fn probe_event_channel() -> Result<String, String> {
    let body = serde_json::json!({
        "source": "mock",
        "sessionId": "probe",
        "event": "state-change",
        "state": "thinking",
        "detail": "链路探测",
        "project": "probe",
        "timestamp": unix_timestamp_millis(),
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;
    let res = client
        .post("http://127.0.0.1:4271/event")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| {
            if e.is_connect() {
                "连不上 4271（桌宠事件通道未就绪，或端口被占用）".into()
            } else if e.is_timeout() {
                "探测超时".into()
            } else {
                format!("网络错误: {e}")
            }
        })?;
    let status = res.status();
    let text = res.text().unwrap_or_default();
    if status.as_u16() == 200 {
        Ok(format!("OK ({text})"))
    } else {
        Err(format!("HTTP {status}: {text}"))
    }
}

fn unix_timestamp_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

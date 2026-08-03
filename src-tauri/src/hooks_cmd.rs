//! 应用内 Hooks 安装 / 状态探测（调用 adapters/*/install-hooks.mjs，不复制事件列表）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// `node -v` 结果缓存，避免每次打开设置都 spawn 进程卡 UI
static NODE_VER_CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
const NODE_VER_TTL: Duration = Duration::from_secs(300);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceHookStatus {
    pub source: String,
    pub label: String,
    pub installed: bool,
    /// 已装 pet-bridge 但缺关键事件（如 Cursor 的 beforeShellExecution）
    pub needs_update: bool,
    /// 缺项说明；无缺项时为 null
    pub missing_hint: Option<String>,
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

/// Windows `canonicalize` 会带 `\\?\` 前缀；Node 解析入口脚本时会 EISDIR `lstat 'D:'`。
fn for_node_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    p
}

/// 开发态：仓库 `adapters/`；安装版：`$RESOURCE/adapters`。
pub fn adapters_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        let packaged = for_node_path(res.join("adapters"));
        if packaged
            .join("claude-code")
            .join("install-hooks.mjs")
            .is_file()
        {
            return Ok(packaged);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("adapters");
    let dev = for_node_path(std::fs::canonicalize(&dev).unwrap_or(dev));
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
    if let Ok(guard) = NODE_VER_CACHE.lock() {
        if let Some((at, ver)) = guard.as_ref() {
            if at.elapsed() < NODE_VER_TTL {
                return ver.clone();
            }
        }
    }
    let ver = (|| {
        let node = find_node().ok()?;
        let out = Command::new(node).arg("-v").output().ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })();
    if let Ok(mut guard) = NODE_VER_CACHE.lock() {
        *guard = Some((Instant::now(), ver.clone()));
    }
    ver
}

/// 从 hooks 配置文本提取 pet-bridge.mjs 的绝对路径（引号内）。
fn extract_bridge_paths(text: &str) -> Vec<String> {
    const NEEDLE: &str = "pet-bridge.mjs";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find(NEEDLE) {
        let abs = from + rel;
        let before = &text[..abs];
        if let Some(q) = before.rfind('"') {
            let path = format!("{}{}", &text[q + 1..abs], NEEDLE);
            if !path.is_empty() && !out.iter().any(|p| p == &path) {
                out.push(path);
            }
        }
        from = abs + NEEDLE.len();
    }
    out
}

/// 已登记的 bridge 路径是否仍存在（仓库搬迁 / 卸载旧版后常见失效）。
fn bridge_paths_missing(text: &str) -> Option<String> {
    let paths = extract_bridge_paths(text);
    if paths.is_empty() {
        return None;
    }
    let missing: Vec<_> = paths
        .iter()
        .filter(|p| !Path::new(p).is_file())
        .cloned()
        .collect();
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "pet-bridge 路径已失效（文件不存在）。请再点「安装」写回本机路径。示例：{}",
        missing[0]
    ))
}

/// 已装 bridge 时检查：路径失效、或缺关键事件（升级后用户常只装过旧列表）
fn source_hook_freshness(source: &str, path: &Path) -> (bool, bool, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (false, false, None);
    };
    let installed = text.contains("pet-bridge.mjs");
    if !installed {
        return (false, false, None);
    }
    if let Some(hint) = bridge_paths_missing(&text) {
        return (true, true, Some(hint));
    }
    let (ok, hint) = match source {
        "cursor" => {
            let has = text.contains("beforeShellExecution");
            (
                has,
                (!has).then_some(
                    "缺少 beforeShellExecution：点 Run 时桌宠不会进入「等待审批」。请再点一次「安装」补齐。"
                        .into(),
                ),
            )
        }
        "codex" => {
            let has = text.contains("PermissionRequest") && text.contains("SubagentStart");
            (
                has,
                (!has).then_some(
                    "hooks 事件偏旧（缺 PermissionRequest / Subagent）。请再点一次「安装」补齐。".into(),
                ),
            )
        }
        "claude-code" => {
            let has = text.contains("PermissionRequest") && text.contains("Elicitation");
            (
                has,
                (!has).then_some(
                    "hooks 事件偏旧（缺审批/提问事件）。请再点一次「安装」补齐。".into(),
                ),
            )
        }
        _ => (true, None),
    };
    (true, !ok, hint)
}

pub fn hooks_status(app: &AppHandle) -> HooksStatus {
    let home = home_dir();
    let node_version = node_version();
    let node_ok = node_version.is_some();

    let (adapters_ok, adapters_path) = match adapters_dir(app) {
        Ok(p) => (true, Some(p.display().to_string())),
        Err(_) => (false, None),
    };

    let mk = |source: &str, label: &str, rel: PathBuf| {
        let config_path = rel.display().to_string();
        let (installed, needs_update, missing_hint) = source_hook_freshness(source, &rel);
        SourceHookStatus {
            source: source.into(),
            label: label.into(),
            installed,
            needs_update,
            missing_hint,
            config_path,
        }
    };

    let sources = vec![
        mk(
            "claude-code",
            "Claude Code",
            home.join(".claude").join("settings.json"),
        ),
        mk("codex", "Codex CLI", home.join(".codex").join("hooks.json")),
        mk("cursor", "Cursor", home.join(".cursor").join("hooks.json")),
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

#[cfg(test)]
mod tests {
    use super::{extract_bridge_paths, for_node_path};
    use std::path::PathBuf;

    #[test]
    fn strips_windows_verbatim_prefix() {
        let raw = PathBuf::from(r"\\?\D:\projects\codex-DP\adapters");
        assert_eq!(
            for_node_path(raw),
            PathBuf::from(r"D:\projects\codex-DP\adapters")
        );
    }

    #[test]
    fn strips_verbatim_unc() {
        let raw = PathBuf::from(r"\\?\UNC\server\share\adapters");
        assert_eq!(
            for_node_path(raw),
            PathBuf::from(r"\\server\share\adapters")
        );
    }

    #[test]
    fn leaves_normal_path() {
        let raw = PathBuf::from(r"D:\projects\codex-DP\adapters");
        assert_eq!(for_node_path(raw.clone()), raw);
    }

    #[test]
    fn extracts_quoted_bridge_paths() {
        let text =
            r#"node "D:/projects/codex-DP/adapters/claude-code/pet-bridge.mjs" --source cursor"#;
        let paths = extract_bridge_paths(text);
        assert_eq!(
            paths,
            vec!["D:/projects/codex-DP/adapters/claude-code/pet-bridge.mjs".to_string()]
        );
    }
}

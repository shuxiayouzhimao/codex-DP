use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 会话活跃窗口：超过该时间无事件则视为结束，从会话列表移除
const SESSION_TTL: Duration = Duration::from_secs(180);

/// 适配器推送的统一事件（与前端 AgentEventPayload 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub source: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(default)]
    pub event: String,
    pub state: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    /// 项目文件夹名（适配器从 cwd 提取），用于在会话列表里区分"哪个对话"
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

/// 去重未变化时仍通知前端刷新 TTL（不改动画）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAlive {
    pub source: String,
    pub session_id: String,
    pub project: Option<String>,
}

/// 路由结果：转发显示事件 / 仅保活 / 丢弃
pub enum RouteOutcome {
    Forward(AgentEvent),
    Alive(SessionAlive),
    Drop,
}

/// 一个活跃会话的跟踪信息
struct SessionInfo {
    project: Option<String>,
    last_seen: Instant,
}

/// 提供给托盘菜单 / 配置面板的会话条目
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    /// 过滤键："source:sessionId"
    pub key: String,
    /// 展示文案："Cursor·codex-DP" / "Cursor·codex-DP_1"（按最近活跃编号）
    pub label: String,
    /// sessionId 前缀，便于同项目多对话辨认
    pub short_id: String,
    /// 该会话最近状态（供列表状态点）
    pub state: String,
    pub project: Option<String>,
}

/// 事件路由：按 source+sessionId 去重（state+tool+detail 指纹未变则不转发），
/// 同时跟踪活跃会话（供"监听会话"菜单）并持有当前的会话过滤选择。
#[derive(Default)]
pub struct EventRouter {
    /// session key → 去重指纹
    last: Mutex<HashMap<String, String>>,
    sessions: Mutex<HashMap<String, SessionInfo>>,
    /// None = 监听全部会话；Some(key) = 只看该会话
    filter: Mutex<Option<String>>,
    /// 锁定时快照的项目名（会话过期后仍能显示失联标签）
    filter_project: Mutex<Option<String>>,
}

fn route_fingerprint(ev: &AgentEvent) -> String {
    format!(
        "{}|{}|{}",
        ev.state,
        ev.tool.as_deref().unwrap_or(""),
        ev.detail.as_deref().unwrap_or("")
    )
}

fn source_label(source: &str) -> &str {
    match source {
        "claude-code" => "Claude",
        "cursor" => "Cursor",
        "codex" => "Codex",
        other => other,
    }
}

fn short_session_id(key: &str) -> String {
    let sid = key.splitn(2, ':').nth(1).unwrap_or("");
    sid.chars().take(6).collect()
}

/// 基础展示名：来源标签 · 项目名（无项目则「会话」）
fn session_base_label(key: &str, project: Option<&str>) -> String {
    let source = key.split(':').next().unwrap_or("");
    let src = source_label(source);
    let proj = project
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("会话");
    format!("{src}·{proj}")
}

/// 同「来源·项目」多会话：按传入顺序（应为最近活跃在前）编号；
/// 最新无后缀，其次 `_1` `_2`…
fn assign_session_labels(items: &[(String, Option<String>)]) -> HashMap<String, String> {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for (key, project) in items {
        let base = session_base_label(key, project.as_deref());
        groups.entry(base).or_default().push(key.clone());
    }
    let mut out = HashMap::new();
    for (base, keys) in groups {
        // keys 保持 items 中的相对顺序（最近活跃优先）
        if keys.len() == 1 {
            out.insert(keys[0].clone(), base);
            continue;
        }
        for (i, k) in keys.into_iter().enumerate() {
            let label = if i == 0 {
                base.clone()
            } else {
                format!("{base}_{i}")
            };
            out.insert(k, label);
        }
    }
    out
}

impl EventRouter {
    /// 记录会话活跃并进行指纹去重
    pub fn route(&self, ev: AgentEvent) -> RouteOutcome {
        if ev.source.is_empty() || ev.state.is_empty() {
            return RouteOutcome::Drop;
        }
        let key = format!("{}:{}", ev.source, ev.session_id);
        let fp = route_fingerprint(&ev);

        // 无论是否去重，都刷新会话活跃时间与项目名（让菜单列表保持新鲜）
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                key.clone(),
                SessionInfo {
                    project: ev.project.clone(),
                    last_seen: Instant::now(),
                },
            );
        }
        // 锁定目标仍在推事件时，刷新失联标签用的项目名
        let is_filter_target = self.filter.lock().unwrap().as_deref() == Some(key.as_str());
        if is_filter_target {
            *self.filter_project.lock().unwrap() = ev.project.clone();
        }

        let mut last = self.last.lock().unwrap();
        if last.get(&key).map(String::as_str) == Some(fp.as_str()) {
            return RouteOutcome::Alive(SessionAlive {
                source: ev.source,
                session_id: ev.session_id,
                project: ev.project,
            });
        }
        last.insert(key, fp);
        RouteOutcome::Forward(ev)
    }

    /// 列出当前活跃会话（剔除过期），最近活跃在前；同步清掉过期会话的去重缓存
    pub fn list_sessions(&self) -> Vec<SessionEntry> {
        let mut sessions = self.sessions.lock().unwrap();
        let now = Instant::now();
        sessions.retain(|_, v| now.duration_since(v.last_seen) <= SESSION_TTL);

        let mut last = self.last.lock().unwrap();
        last.retain(|k, _| sessions.contains_key(k));

        let mut v: Vec<(String, Option<String>, Instant)> = sessions
            .iter()
            .map(|(k, info)| (k.clone(), info.project.clone(), info.last_seen))
            .collect();
        v.sort_by(|a, b| b.2.cmp(&a.2));

        let label_items: Vec<(String, Option<String>)> = v
            .iter()
            .map(|(k, p, _)| (k.clone(), p.clone()))
            .collect();
        let labels = assign_session_labels(&label_items);

        v.into_iter()
            .map(|(key, project, _)| {
                let label = labels
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| session_base_label(&key, project.as_deref()));
                let state = last
                    .get(&key)
                    .map(|fp| fp.split('|').next().unwrap_or("idle").to_string())
                    .unwrap_or_else(|| "idle".into());
                let short_id = short_session_id(&key);
                SessionEntry {
                    key,
                    label,
                    short_id,
                    state,
                    project,
                }
            })
            .collect()
    }

    /// 为失联锁定生成展示文案（不依赖活跃列表）
    pub fn filter_lost_label(&self) -> Option<String> {
        let filter = self.get_filter()?;
        if self.list_sessions().iter().any(|s| s.key == filter) {
            return None;
        }
        let project = self.filter_project.lock().unwrap().clone();
        let base = session_base_label(&filter, project.as_deref());
        let short = short_session_id(&filter);
        if short.is_empty() {
            Some(format!("{base} · 已失联"))
        } else {
            Some(format!("{base} · {short} · 已失联"))
        }
    }

    pub fn set_filter(&self, f: Option<String>) {
        if let Some(ref key) = f {
            let project = self
                .sessions
                .lock()
                .unwrap()
                .get(key)
                .and_then(|i| i.project.clone());
            *self.filter_project.lock().unwrap() = project;
        } else {
            *self.filter_project.lock().unwrap() = None;
        }
        *self.filter.lock().unwrap() = f;
    }
    pub fn get_filter(&self) -> Option<String> {
        self.filter.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(source: &str, session: &str, state: &str) -> AgentEvent {
        AgentEvent {
            source: source.into(),
            session_id: session.into(),
            event: "state-change".into(),
            state: state.into(),
            tool: None,
            detail: None,
            project: Some("codex-DP".into()),
            timestamp: None,
        }
    }

    fn ev_full(
        source: &str,
        session: &str,
        state: &str,
        tool: Option<&str>,
        detail: Option<&str>,
    ) -> AgentEvent {
        AgentEvent {
            source: source.into(),
            session_id: session.into(),
            event: "state-change".into(),
            state: state.into(),
            tool: tool.map(str::to_string),
            detail: detail.map(str::to_string),
            project: Some("codex-DP".into()),
            timestamp: None,
        }
    }

    fn is_fwd(o: RouteOutcome) -> bool {
        matches!(o, RouteOutcome::Forward(_))
    }
    fn is_alive(o: RouteOutcome) -> bool {
        matches!(o, RouteOutcome::Alive(_))
    }
    fn is_drop(o: RouteOutcome) -> bool {
        matches!(o, RouteOutcome::Drop)
    }

    #[test]
    fn route_rejects_empty_source_or_state() {
        let r = EventRouter::default();
        assert!(is_drop(r.route(ev("", "s", "thinking"))));
        let mut bad = ev("mock", "s", "");
        bad.state.clear();
        assert!(is_drop(r.route(bad)));
    }

    #[test]
    fn route_dedups_same_state_per_session() {
        let r = EventRouter::default();
        assert!(is_fwd(r.route(ev("mock", "s1", "thinking"))));
        assert!(is_alive(r.route(ev("mock", "s1", "thinking"))));
        assert!(is_fwd(r.route(ev("mock", "s1", "tool-use"))));
        // other session not deduped against s1
        assert!(is_fwd(r.route(ev("mock", "s2", "thinking"))));
    }

    #[test]
    fn route_forwards_same_state_when_tool_or_detail_changes() {
        let r = EventRouter::default();
        assert!(is_fwd(r.route(ev_full(
            "mock",
            "s1",
            "tool-use",
            Some("Bash"),
            Some("执行 Bash")
        ))));
        // 同态换工具 → 应转发（气泡/文案需要）
        assert!(is_fwd(r.route(ev_full(
            "mock",
            "s1",
            "tool-use",
            Some("Grep"),
            Some("执行 Grep")
        ))));
        // 完全相同 → 去重（Alive）
        assert!(is_alive(r.route(ev_full(
            "mock",
            "s1",
            "tool-use",
            Some("Grep"),
            Some("执行 Grep")
        ))));
        // 同态同工具换 detail → 转发
        assert!(is_fwd(r.route(ev_full(
            "mock",
            "s1",
            "permission-prompt",
            Some("Shell"),
            Some("等待确认：npm test"),
        ))));
        assert!(is_fwd(r.route(ev_full(
            "mock",
            "s1",
            "permission-prompt",
            Some("Shell"),
            Some("等待确认：cargo check"),
        ))));
    }

    #[test]
    fn list_sessions_labels_source_and_project() {
        let r = EventRouter::default();
        r.route(ev("claude-code", "dbaf7eabcdef", "thinking"));
        let list = r.list_sessions();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "claude-code:dbaf7eabcdef");
        assert_eq!(list[0].label, "Claude·codex-DP");
        assert_eq!(list[0].short_id, "dbaf7e");
    }

    #[test]
    fn list_sessions_suffixes_by_recency() {
        let r = EventRouter::default();
        r.route(ev("cursor", "aaa111", "thinking"));
        r.route(ev("cursor", "bbb222", "tool-use"));
        let list = r.list_sessions();
        assert_eq!(list.len(), 2);
        // 最近活跃在前：bbb → 无后缀；aaa → _1
        assert_eq!(list[0].key, "cursor:bbb222");
        assert_eq!(list[0].label, "Cursor·codex-DP");
        assert_eq!(list[1].key, "cursor:aaa111");
        assert_eq!(list[1].label, "Cursor·codex-DP_1");
    }

    #[test]
    fn filter_get_set() {
        let r = EventRouter::default();
        assert!(r.get_filter().is_none());
        r.set_filter(Some("mock:s1".into()));
        assert_eq!(r.get_filter().as_deref(), Some("mock:s1"));
        r.set_filter(None);
        assert!(r.get_filter().is_none());
    }

    #[test]
    fn session_base_label_fallback() {
        assert_eq!(session_base_label("codex:abcdef12", None), "Codex·会话");
        assert_eq!(session_base_label("codex:x", Some("proj")), "Codex·proj");
        assert_eq!(
            session_base_label("claude-code:x", Some("codex-DP")),
            "Claude·codex-DP"
        );
    }

    #[test]
    fn assign_session_labels_recency_order() {
        // 传入顺序：最近在前
        let items = vec![
            ("cursor:b".into(), Some("p".into())),
            ("cursor:a".into(), Some("p".into())),
            ("codex:z".into(), Some("p".into())),
        ];
        let m = assign_session_labels(&items);
        assert_eq!(m.get("cursor:b").map(String::as_str), Some("Cursor·p"));
        assert_eq!(m.get("cursor:a").map(String::as_str), Some("Cursor·p_1"));
        assert_eq!(m.get("codex:z").map(String::as_str), Some("Codex·p"));
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 会话活跃窗口：超过该时间无事件则视为结束，从会话列表移除
const SESSION_TTL: Duration = Duration::from_secs(90);

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
    /// 展示文案："codex-DP·dbaf7e"
    pub label: String,
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
}

fn route_fingerprint(ev: &AgentEvent) -> String {
    format!(
        "{}|{}|{}",
        ev.state,
        ev.tool.as_deref().unwrap_or(""),
        ev.detail.as_deref().unwrap_or("")
    )
}

/// 由 "source:sessionId" + project 生成会话展示文案
fn session_label(key: &str, project: Option<&str>) -> String {
    let mut it = key.splitn(2, ':');
    let source = it.next().unwrap_or("");
    let sid = it.next().unwrap_or("");
    let short: String = sid.chars().take(6).collect();
    let head = project.filter(|p| !p.is_empty()).unwrap_or(source);
    if short.is_empty() {
        head.to_string()
    } else {
        format!("{head}·{short}")
    }
}

impl EventRouter {
    /// 记录会话活跃并进行指纹去重；有变化时返回 Some(ev) 以供转发
    pub fn route(&self, ev: AgentEvent) -> Option<AgentEvent> {
        if ev.source.is_empty() || ev.state.is_empty() {
            return None;
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

        let mut last = self.last.lock().unwrap();
        if last.get(&key).map(String::as_str) == Some(fp.as_str()) {
            return None; // 指纹未变化，去重
        }
        last.insert(key, fp);
        Some(ev)
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

        v.into_iter()
            .map(|(key, project, _)| {
                let label = session_label(&key, project.as_deref());
                let state = last
                    .get(&key)
                    .map(|fp| fp.split('|').next().unwrap_or("idle").to_string())
                    .unwrap_or_else(|| "idle".into());
                SessionEntry {
                    key,
                    label,
                    state,
                    project,
                }
            })
            .collect()
    }

    pub fn set_filter(&self, f: Option<String>) {
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

    #[test]
    fn route_rejects_empty_source_or_state() {
        let r = EventRouter::default();
        assert!(r.route(ev("", "s", "thinking")).is_none());
        let mut bad = ev("mock", "s", "");
        bad.state.clear();
        assert!(r.route(bad).is_none());
    }

    #[test]
    fn route_dedups_same_state_per_session() {
        let r = EventRouter::default();
        assert!(r.route(ev("mock", "s1", "thinking")).is_some());
        assert!(r.route(ev("mock", "s1", "thinking")).is_none());
        assert!(r.route(ev("mock", "s1", "tool-use")).is_some());
        // other session not deduped against s1
        assert!(r.route(ev("mock", "s2", "thinking")).is_some());
    }

    #[test]
    fn route_forwards_same_state_when_tool_or_detail_changes() {
        let r = EventRouter::default();
        assert!(r
            .route(ev_full("mock", "s1", "tool-use", Some("Bash"), Some("执行 Bash")))
            .is_some());
        // 同态换工具 → 应转发（气泡/文案需要）
        assert!(r
            .route(ev_full("mock", "s1", "tool-use", Some("Grep"), Some("执行 Grep")))
            .is_some());
        // 完全相同 → 去重
        assert!(r
            .route(ev_full("mock", "s1", "tool-use", Some("Grep"), Some("执行 Grep")))
            .is_none());
        // 同态同工具换 detail → 转发
        assert!(r
            .route(ev_full(
                "mock",
                "s1",
                "permission-prompt",
                Some("Shell"),
                Some("等待确认：npm test"),
            ))
            .is_some());
        assert!(r
            .route(ev_full(
                "mock",
                "s1",
                "permission-prompt",
                Some("Shell"),
                Some("等待确认：cargo check"),
            ))
            .is_some());
    }

    #[test]
    fn list_sessions_labels_with_project_and_short_id() {
        let r = EventRouter::default();
        r.route(ev("claude-code", "dbaf7eabcdef", "thinking"));
        let list = r.list_sessions();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "claude-code:dbaf7eabcdef");
        assert_eq!(list[0].label, "codex-DP·dbaf7e");
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
    fn session_label_falls_back_to_source() {
        assert_eq!(session_label("codex:abcdef12", None), "codex·abcdef");
        assert_eq!(session_label("codex:", Some("proj")), "proj");
    }
}

use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Method, Response, Server, StatusCode};

use crate::state_machine::{AgentEvent, RouteOutcome};
use crate::{refresh_menu, AppState};

/// Phase 3：本地事件推送通道。
/// 监听 http://127.0.0.1:{port}/event，适配器 POST 统一事件 JSON，
/// 经过去重后 emit 到前端（"agent-event"）。
///
/// 选择 HTTP POST 而非 WebSocket：Claude Code Hooks 每次事件都新建进程，
/// 单向 fire-and-forget 推送用无状态 POST 更简单、更健壮（无需重连），
/// 适配器可零依赖（curl 一行 / Node 内置 fetch）。
pub fn start(app: AppHandle, port: u16) {
    std::thread::spawn(move || {
        let server = match Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[pet-server] 端口 {port} 绑定失败：{e}（事件通道不可用，窗口仍正常）");
                return;
            }
        };
        // 共享事件路由（与托盘菜单同一份会话跟踪/过滤状态）
        let router = &app.state::<AppState>().router;
        println!("[pet-server] 事件通道就绪 http://127.0.0.1:{port}/event");

        for mut req in server.incoming_requests() {
            let is_event =
                req.method() == &Method::Post && req.url().split('?').next() == Some("/event");
            if !is_event {
                let _ = req.respond(
                    Response::from_string("not found").with_status_code(StatusCode(404)),
                );
                continue;
            }

            let mut body = String::new();
            if req.as_reader().read_to_string(&mut body).is_err() {
                let _ = req.respond(
                    Response::from_string("bad body").with_status_code(StatusCode(400)),
                );
                continue;
            }

            let resp = match serde_json::from_str::<AgentEvent>(&body) {
                Ok(ev) => {
                    let desc = format!(
                        "{}:{} -> {} ({})",
                        ev.source,
                        ev.session_id,
                        ev.state,
                        ev.detail.clone().unwrap_or_default()
                    );
                    match router.route(ev) {
                        RouteOutcome::Forward(ev) => {
                            println!("[pet-event] FWD {desc}");
                            let _ = app.emit("agent-event", &ev);
                            // 会话列表可能有新条目/过期，刷新托盘"监听会话"菜单
                            refresh_menu(&app);
                            Response::from_string("ok").with_status_code(StatusCode(200))
                        }
                        RouteOutcome::Alive(alive) => {
                            println!("[pet-event] dup {desc}");
                            // 不改动画，只刷新前端会话 TTL
                            let _ = app.emit("session-alive", &alive);
                            Response::from_string("dup").with_status_code(StatusCode(200))
                        }
                        RouteOutcome::Drop => {
                            Response::from_string("drop").with_status_code(StatusCode(200))
                        }
                    }
                }
                Err(e) => {
                    let snip: String = body.chars().take(200).collect();
                    println!("[pet-event] bad json: {e} | body: {snip}");
                    Response::from_string(format!("bad json: {e}"))
                        .with_status_code(StatusCode(400))
                }
            };
            let _ = req.respond(resp);
        }
    });
}

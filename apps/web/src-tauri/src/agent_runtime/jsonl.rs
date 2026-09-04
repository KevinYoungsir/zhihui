use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRunEvent {
  pub run_id: String,
  pub kind: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub text: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub phase: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tool: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub call_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub ok: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code: Option<String>,
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
  let mut current = value;
  for segment in path {
    current = current.get(*segment)?;
  }
  current.as_str().map(str::to_owned).filter(|value| !value.is_empty())
}

pub fn parse_codex_jsonl(run_id: &str, line: &str) -> Option<CodexRunEvent> {
  let value: Value = serde_json::from_str(line).ok()?;
  let event_type = value.get("type")?.as_str()?.trim();
  let item = value.get("item");
  match event_type {
    "item.completed" | "item.started" | "item.updated" => {
      let item_type = item.and_then(|row| row.get("type")).and_then(Value::as_str).unwrap_or("");
      if item_type == "agent_message" {
        return Some(CodexRunEvent {
          run_id: run_id.to_string(),
          kind: "text.delta".to_string(),
          text: string_at(&value, &["item", "text"]),
          phase: None,
          tool: None,
          call_id: None,
          ok: None,
          code: None,
        });
      }
      if item_type == "mcp_tool_call" {
        let status = string_at(&value, &["item", "status"]);
        return Some(CodexRunEvent {
          run_id: run_id.to_string(),
          kind: if event_type == "item.completed" { "tool.result" } else { "tool.call" }.to_string(),
          text: None,
          phase: status.clone(),
          tool: string_at(&value, &["item", "tool"])
            .or_else(|| string_at(&value, &["item", "name"])),
          call_id: string_at(&value, &["item", "id"]),
          ok: status.map(|value| value != "failed"),
          code: None,
        });
      }
      Some(CodexRunEvent {
        run_id: run_id.to_string(),
        kind: "progress".to_string(),
        text: None,
        phase: Some(item_type.to_string()),
        tool: None,
        call_id: None,
        ok: None,
        code: None,
      })
    }
    "turn.completed" => Some(CodexRunEvent {
      run_id: run_id.to_string(),
      kind: "run.completed".to_string(),
      text: None,
      phase: None,
      tool: None,
      call_id: None,
      ok: Some(true),
      code: None,
    }),
    "turn.failed" => Some(CodexRunEvent {
      run_id: run_id.to_string(),
      kind: "run.error".to_string(),
      text: string_at(&value, &["error", "message"])
        .or_else(|| string_at(&value, &["message"])),
      phase: None,
      tool: None,
      call_id: None,
      ok: Some(false),
      code: Some("codex_turn_failed".to_string()),
    }),
    // Codex emits top-level error records while its sampler reconnects. The
    // turn remains alive until a later turn.completed or turn.failed record.
    "error" => Some(CodexRunEvent {
      run_id: run_id.to_string(),
      kind: "progress".to_string(),
      text: string_at(&value, &["message"]),
      phase: Some("reconnecting".to_string()),
      tool: None,
      call_id: None,
      ok: None,
      code: None,
    }),
    other => Some(CodexRunEvent {
      run_id: run_id.to_string(),
      kind: "progress".to_string(),
      text: None,
      phase: Some(other.to_string()),
      tool: None,
      call_id: None,
      ok: None,
      code: None,
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_agent_message() {
    let event = parse_codex_jsonl(
      "run-1",
      r#"{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}"#,
    )
    .unwrap();
    assert_eq!(event.kind, "text.delta");
    assert_eq!(event.text.as_deref(), Some("Done"));
  }

  #[test]
  fn parses_mcp_tool_result() {
    let event = parse_codex_jsonl(
      "run-1",
      r#"{"type":"item.completed","item":{"type":"mcp_tool_call","id":"call-1","tool":"create_text","status":"completed"}}"#,
    )
    .unwrap();
    assert_eq!(event.kind, "tool.result");
    assert_eq!(event.tool.as_deref(), Some("create_text"));
    assert_eq!(event.ok, Some(true));
  }

  #[test]
  fn parses_mcp_tool_start() {
    let event = parse_codex_jsonl(
      "run-1",
      r#"{"type":"item.started","item":{"type":"mcp_tool_call","id":"call-1","tool":"get_scene_summary","status":"in_progress"}}"#,
    )
    .unwrap();
    assert_eq!(event.kind, "tool.call");
    assert_eq!(event.tool.as_deref(), Some("get_scene_summary"));
    assert_eq!(event.call_id.as_deref(), Some("call-1"));
  }

  #[test]
  fn ignores_non_json_lines() {
    assert!(parse_codex_jsonl("run-1", "not json").is_none());
  }

  #[test]
  fn treats_reconnect_errors_as_non_terminal_progress() {
    let event = parse_codex_jsonl(
      "run-1",
      r#"{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}"#,
    )
    .unwrap();
    assert_eq!(event.kind, "progress");
    assert_eq!(event.phase.as_deref(), Some("reconnecting"));
  }
}

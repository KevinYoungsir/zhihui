mod jsonl;
mod process_tree;

use self::jsonl::{parse_codex_jsonl, CodexRunEvent};
use self::process_tree::{configure_process_group, ProcessTreeTerminator};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_NAME: &str = "agent-cli-run-event";
const MAX_PROMPT_BYTES: usize = 200_000;
const MAX_RUN_DURATION: Duration = Duration::from_secs(600);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProbe {
  available: bool,
  authenticated: bool,
  version: Option<String>,
  reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCodexRunRequest {
  run_id: String,
  project_id: String,
  prompt: String,
  api_origin: String,
  grant_token: String,
}

struct ManagedRun {
  terminator: Arc<ProcessTreeTerminator>,
  terminated: Arc<AtomicBool>,
  termination_reason: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
pub struct AgentProcessState {
  runs: Arc<Mutex<HashMap<String, ManagedRun>>>,
}

impl AgentProcessState {
  pub fn terminate_all(&self) {
    let runs = self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for run in runs.values() {
      run.terminated.store(true, Ordering::SeqCst);
      *run.termination_reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some("app_exit".into());
      let _ = run.terminator.terminate();
    }
  }
}

fn is_safe_id(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 128
    && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn allowed_api_origin(value: &str) -> Result<String, String> {
  let provided = value.trim().trim_end_matches('/');
  let expected = env!("RECOMBYN_DESKTOP_API_ORIGIN").trim().trim_end_matches('/');
  if provided != expected {
    return Err("The MCP API origin is not the origin bound into this desktop build".to_string());
  }
  if !(provided.starts_with("https://")
    || provided == "http://127.0.0.1:8000"
    || provided == "http://localhost:8000")
  {
    return Err("The MCP API origin must use HTTPS or the approved development loopback".to_string());
  }
  Ok(provided.to_string())
}

fn executable_names(name: &str) -> Vec<String> {
  #[cfg(windows)]
  { vec![format!("{name}.exe")] }
  #[cfg(not(windows))]
  { vec![name.to_string()] }
}

fn resolve_allowlisted_executable(name: &str) -> Option<PathBuf> {
  if name != "codex" && name != "node" { return None; }
  let path = std::env::var_os("PATH")?;
  for directory in std::env::split_paths(&path) {
    for filename in executable_names(name) {
      let candidate = directory.join(filename);
      if candidate.is_file() { return Some(candidate); }
    }
  }
  None
}

fn fixed_probe(executable: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
  let mut command = Command::new(executable);
  command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  configure_process_group(&mut command);
  let mut child = command.spawn().ok()?;
  let started = std::time::Instant::now();
  loop {
    if let Ok(Some(status)) = child.try_wait() {
      let mut text = String::new();
      if let Some(mut stdout) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
      }
      if text.len() > 256 { text.truncate(256); }
      return Some((status.success(), text.trim().to_string()));
    }
    if started.elapsed() >= timeout {
      let _ = child.kill();
      let _ = child.wait();
      return None;
    }
    thread::sleep(Duration::from_millis(25));
  }
}

#[tauri::command]
pub fn discover_codex() -> CodexProbe {
  let Some(executable) = resolve_allowlisted_executable("codex") else {
    return CodexProbe { available: false, authenticated: false, version: None, reason: Some("not_installed".into()) };
  };
  let version = fixed_probe(&executable, &["--version"], Duration::from_secs(2))
    .and_then(|(ok, text)| if ok { Some(text) } else { None });
  let authenticated = fixed_probe(&executable, &["login", "status"], Duration::from_secs(3))
    .map(|(ok, _)| ok)
    .unwrap_or(false);
  CodexProbe {
    available: version.is_some(),
    authenticated,
    version,
    reason: if authenticated { None } else { Some("login_required".into()) },
  }
}

fn resolve_mcp_script(app: &AppHandle) -> Result<PathBuf, String> {
  if let Ok(resource_dir) = app.path().resource_dir() {
    let bundled = resource_dir.join("scripts").join("mcp").join("recombyn_canvas_stdio.mjs");
    if bundled.is_file() { return Ok(bundled); }
  }
  #[cfg(debug_assertions)]
  {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("..")
      .join("..")
      .join("scripts")
      .join("mcp")
      .join("recombyn_canvas_stdio.mjs");
    if source.is_file() { return source.canonicalize().map_err(|error| error.to_string()); }
  }
  Err("Bundled Recombyn Canvas MCP bridge is missing".to_string())
}

fn create_temp_run_dir(run_id: &str, project_id: &str, api_origin: &str, script: &Path) -> Result<PathBuf, String> {
  let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
  let root = std::env::temp_dir().join("recombyn-agent-runs");
  fs::create_dir_all(&root).map_err(|error| error.to_string())?;
  let directory = root.join(format!("{run_id}-{nonce}"));
  fs::create_dir(&directory).map_err(|error| error.to_string())?;
  let redacted = serde_json::json!({
    "runId": run_id,
    "projectId": project_id,
    "apiOrigin": api_origin,
    "mcpScript": script,
    "grantEnvironmentVariable": "RECOMBYN_MCP_GRANT"
  });
  fs::write(directory.join("mcp-run.json"), serde_json::to_vec_pretty(&redacted).unwrap())
    .map_err(|error| error.to_string())?;
  Ok(directory)
}

fn toml_string(value: &str) -> String {
  serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn emit(app: &AppHandle, event: CodexRunEvent) {
  let _ = app.emit(EVENT_NAME, event);
}

#[tauri::command]
pub fn start_codex_run(
  app: AppHandle,
  state: State<'_, AgentProcessState>,
  request: StartCodexRunRequest,
) -> Result<(), String> {
  if !is_safe_id(&request.run_id) || !is_safe_id(&request.project_id) {
    return Err("Invalid run or project id".to_string());
  }
  if request.prompt.trim().is_empty() || request.prompt.len() > MAX_PROMPT_BYTES {
    return Err("Prompt is empty or exceeds the desktop limit".to_string());
  }
  if request.grant_token.trim().is_empty() || request.grant_token.len() > 1024 {
    return Err("Invalid MCP run grant".to_string());
  }
  let api_origin = allowed_api_origin(&request.api_origin)?;
  let codex = resolve_allowlisted_executable("codex").ok_or("Codex CLI is not installed")?;
  let node = resolve_allowlisted_executable("node").ok_or("Node.js is required for the Canvas MCP bridge")?;
  let mcp_script = resolve_mcp_script(&app)?;
  let temp_dir = create_temp_run_dir(&request.run_id, &request.project_id, &api_origin, &mcp_script)?;

  {
    let runs = state.runs.lock().map_err(|_| "Agent process state is unavailable")?;
    if runs.contains_key(&request.run_id) { return Err("Agent run already exists".to_string()); }
  }

  let command_override = format!("mcp_servers.recombyn.command={}", toml_string(&node.to_string_lossy()));
  let args_override = format!("mcp_servers.recombyn.args=[{}]", toml_string(&mcp_script.to_string_lossy()));
  let env_override = "mcp_servers.recombyn.env_vars=[\"RECOMBYN_API_URL\",\"RECOMBYN_MCP_GRANT\",\"RECOMBYN_PROJECT_ID\",\"RECOMBYN_RUN_ID\"]";
  let mut command = Command::new(codex);
  command
    .args(["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"])
    .arg("-c").arg(command_override)
    .arg("-c").arg(args_override)
    .arg("-c").arg(env_override)
    .arg("-")
    .current_dir(&temp_dir)
    .env("RECOMBYN_API_URL", &api_origin)
    .env("RECOMBYN_MCP_GRANT", request.grant_token.trim())
    .env("RECOMBYN_PROJECT_ID", &request.project_id)
    .env("RECOMBYN_RUN_ID", &request.run_id)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  configure_process_group(&mut command);
  let mut child = command.spawn().map_err(|error| format!("Failed to start Codex CLI: {error}"))?;
  let terminator = Arc::new(ProcessTreeTerminator::attach(&child).map_err(|error| {
    let _ = child.kill();
    format!("Failed to secure Codex process tree: {error}")
  })?);
  let terminated = Arc::new(AtomicBool::new(false));
  let termination_reason = Arc::new(Mutex::new(None));
  state.runs.lock().map_err(|_| "Agent process state is unavailable")?.insert(
    request.run_id.clone(),
    ManagedRun {
      terminator: terminator.clone(),
      terminated: terminated.clone(),
      termination_reason: termination_reason.clone(),
    },
  );

  let mut stdin = child.stdin.take().ok_or("Codex stdin is unavailable")?;
  stdin.write_all(request.prompt.as_bytes()).map_err(|error| error.to_string())?;
  stdin.flush().map_err(|error| error.to_string())?;
  drop(stdin);

  let run_id = request.run_id.clone();
  let stdout_thread = if let Some(stdout) = child.stdout.take() {
    let app_for_stdout = app.clone();
    let stdout_run_id = run_id.clone();
    Some(thread::spawn(move || {
      for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(event) = parse_codex_jsonl(&stdout_run_id, &line) {
          emit(&app_for_stdout, event);
        }
      }
    }))
  } else {
    None
  };
  // Drain stderr so a noisy child cannot deadlock on a full pipe. Count a
  // bounded amount for diagnostics, but never persist or emit raw stderr.
  let stderr_thread = child.stderr.take().map(|stderr| {
    thread::spawn(move || {
      let mut captured_bytes = 0usize;
      for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        captured_bytes = captured_bytes.saturating_add(line.len()).min(16 * 1024);
      }
      captured_bytes
    })
  });

  let runs = state.runs.clone();
  let watchdog_runs = runs.clone();
  let watchdog_run_id = run_id.clone();
  let watchdog_terminator = terminator.clone();
  let watchdog_terminated = terminated.clone();
  let watchdog_reason = termination_reason.clone();
  thread::spawn(move || {
    thread::sleep(MAX_RUN_DURATION);
    if watchdog_runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains_key(&watchdog_run_id) {
      watchdog_terminated.store(true, Ordering::SeqCst);
      *watchdog_reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some("process_timeout".into());
      let _ = watchdog_terminator.terminate();
    }
  });
  thread::spawn(move || {
    let status = child.wait();
    if let Some(stdout_thread) = stdout_thread {
      let _ = stdout_thread.join();
    }
    if let Some(stderr_thread) = stderr_thread {
      let _captured_stderr_bytes = stderr_thread.join().unwrap_or(0);
    }
    let termination = termination_reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    if termination.as_deref() == Some("process_timeout") {
      emit(&app, CodexRunEvent {
        run_id: run_id.clone(), kind: "run.error".into(), text: None, phase: None,
        tool: None, call_id: None, ok: Some(false), code: Some("process_timeout".into()),
      });
    } else if terminated.load(Ordering::SeqCst) {
      emit(&app, CodexRunEvent {
        run_id: run_id.clone(), kind: "run.cancelled".into(), text: None, phase: None,
        tool: None, call_id: None, ok: Some(false), code: termination.or(Some("cancelled".into())),
      });
    } else if !status.map(|value| value.success()).unwrap_or(false) {
      emit(&app, CodexRunEvent {
        run_id: run_id.clone(), kind: "run.error".into(), text: None, phase: None,
        tool: None, call_id: None, ok: Some(false), code: Some("codex_process_failed".into()),
      });
    }
    runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&run_id);
    let _ = fs::remove_dir_all(&temp_dir);
  });
  Ok(())
}

#[tauri::command]
pub fn cancel_codex_run(state: State<'_, AgentProcessState>, run_id: String) -> Result<(), String> {
  if !is_safe_id(&run_id) { return Err("Invalid run id".to_string()); }
  let runs = state.runs.lock().map_err(|_| "Agent process state is unavailable")?;
  if let Some(run) = runs.get(&run_id) {
    run.terminated.store(true, Ordering::SeqCst);
    *run.termination_reason.lock().map_err(|_| "Agent process state is unavailable")? = Some("cancelled".into());
    run.terminator.terminate().map_err(|error| format!("Failed to terminate Codex process tree: {error}"))?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_unsafe_ids() {
    assert!(is_safe_id("run-123"));
    assert!(!is_safe_id("../run"));
    assert!(!is_safe_id("run id"));
  }

  #[test]
  fn rejects_unbound_api_origins() {
    assert!(allowed_api_origin("http://127.0.0.1:9999").is_err());
  }
}

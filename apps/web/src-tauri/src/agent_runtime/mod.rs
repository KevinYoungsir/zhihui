mod jsonl;
mod process_tree;

use self::jsonl::{parse_codex_jsonl, CodexRunEvent};
use self::process_tree::{configure_process_group, ProcessTreeTerminator};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
// Compatibility default used by zhihui Desktop Runtime. The runtime ignores
// user Codex configuration so an incompatible account-specific model cannot
// prevent a local run from starting. This is not model discovery or a picker.
const CODEX_RUNTIME_DEFAULT_MODEL: &str = "gpt-5.5";
const PHASE_ONE_CANVAS_TOOLS: [&str; 8] = [
  "get_scene_summary",
  "list_nodes",
  "list_frames",
  "apply_tool_ops",
  "create_frame",
  "create_shape",
  "create_text",
  "update_node",
];

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
  cancelled: Arc<Mutex<HashSet<String>>>,
}

impl AgentProcessState {
  fn is_cancelled(&self, run_id: &str) -> bool {
    self.cancelled.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(run_id)
  }

  fn register_run(&self, run_id: &str, run: ManagedRun) -> Result<(), (String, ManagedRun)> {
    // Cancellation and registration intentionally use the same lock order.
    // This closes the spawn/register window where a cancellation could be
    // observed before the process was inserted into the active-run map.
    let cancelled = self.cancelled.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if cancelled.contains(run_id) {
      return Err(("Agent run was cancelled before start".to_string(), run));
    }
    let mut runs = self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if runs.contains_key(run_id) {
      return Err(("Agent run already exists".to_string(), run));
    }
    runs.insert(run_id.to_string(), run);
    Ok(())
  }

  fn mark_cancelled(&self, run_id: &str) -> Result<(), String> {
    // Keep the tombstone even when no active process exists. A concurrent
    // starter will see it while registering and clean up the just-spawned
    // process instead of creating a ghost run.
    let mut cancelled = self.cancelled.lock().map_err(|_| "Agent process state is unavailable".to_string())?;
    cancelled.insert(run_id.to_string());
    let runs = self.runs.lock().map_err(|_| "Agent process state is unavailable".to_string())?;
    if let Some(run) = runs.get(run_id) {
      run.terminated.store(true, Ordering::SeqCst);
      *run.termination_reason.lock().map_err(|_| "Agent process state is unavailable".to_string())? = Some("cancelled".into());
      run.terminator.terminate().map_err(|error| format!("Failed to terminate Codex process tree: {error}"))?;
    }
    Ok(())
  }

  fn remove_run(&self, run_id: &str) {
    self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(run_id);
  }

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
    if bundled.is_file() { return Ok(node_compatible_path(bundled)); }
  }
  #[cfg(debug_assertions)]
  {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
      .join("..")
      .join("..")
      .join("..")
      .join("scripts")
      .join("mcp")
      .join("recombyn_canvas_stdio.mjs");
    if source.is_file() {
      return source
        .canonicalize()
        .map(node_compatible_path)
        .map_err(|error| error.to_string());
    }
  }
  Err("Bundled Recombyn Canvas MCP bridge is missing".to_string())
}

fn node_compatible_path(path: PathBuf) -> PathBuf {
  #[cfg(windows)]
  {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
      return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
      return PathBuf::from(rest);
    }
  }
  path
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

fn mcp_config_overrides(node: &Path, script: &Path) -> Vec<String> {
  let mut overrides = vec![
    format!("mcp_servers.recombyn.command={}", toml_string(&node.to_string_lossy())),
    format!("mcp_servers.recombyn.args=[{}]", toml_string(&script.to_string_lossy())),
    "mcp_servers.recombyn.env_vars=[\"RECOMBYN_API_URL\",\"RECOMBYN_MCP_GRANT\",\"RECOMBYN_PROJECT_ID\",\"RECOMBYN_RUN_ID\"]".to_string(),
    format!(
      "mcp_servers.recombyn.enabled_tools=[{}]",
      PHASE_ONE_CANVAS_TOOLS
        .iter()
        .map(|tool| toml_string(tool))
        .collect::<Vec<_>>()
        .join(",")
    ),
  ];
  overrides.extend(PHASE_ONE_CANVAS_TOOLS.iter().map(|tool| {
    format!("mcp_servers.recombyn.tools.{tool}.approval_mode=\"approve\"")
  }));
  overrides
}

fn codex_exec_args() -> [&'static str; 9] {
  [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--model",
    CODEX_RUNTIME_DEFAULT_MODEL,
  ]
}

#[cfg(any(test, debug_assertions))]
fn parse_test_run_timeout(value: Option<&str>) -> Option<Duration> {
  value
    .and_then(|raw| raw.trim().parse::<u64>().ok())
    .filter(|millis| *millis > 0)
    .map(Duration::from_millis)
}

fn configured_run_duration() -> Duration {
  #[cfg(any(test, debug_assertions))]
  {
    if let Ok(value) = std::env::var("RECOMBYN_TEST_RUN_TIMEOUT_MS") {
      if let Some(timeout) = parse_test_run_timeout(Some(&value)) {
        return timeout;
      }
    }
  }
  MAX_RUN_DURATION
}

#[cfg(debug_assertions)]
fn debug_delay_from_env(name: &str) {
  let Some(value) = std::env::var_os(name) else { return; };
  let Ok(millis) = value.to_string_lossy().trim().parse::<u64>() else { return; };
  if millis == 0 { return; }
  thread::sleep(Duration::from_millis(millis.min(120_000)));
}

#[cfg(debug_assertions)]
fn debug_fail_after_spawn() -> bool {
  matches!(
    std::env::var("RECOMBYN_TEST_FAIL_AFTER_SPAWN").ok().as_deref(),
    Some("1") | Some("true") | Some("TRUE")
  )
}

#[cfg(not(debug_assertions))]
fn debug_fail_after_spawn() -> bool { false }

fn emit(app: &AppHandle, event: CodexRunEvent) {
  let _ = app.emit(EVENT_NAME, event);
}

fn cleanup_started_child(
  state: &AgentProcessState,
  run_id: &str,
  mut child: std::process::Child,
  terminator: &ProcessTreeTerminator,
  terminated: &AtomicBool,
  termination_reason: &Mutex<Option<String>>,
  temp_dir: &Path,
) {
  terminated.store(true, Ordering::SeqCst);
  if let Ok(mut reason) = termination_reason.lock() {
    *reason = Some("startup_failed".into());
  }
  state.remove_run(run_id);
  let _ = terminator.terminate();
  let _ = child.wait();
  let _ = fs::remove_dir_all(temp_dir);
}

fn cleanup_unregistered_child(mut child: std::process::Child, terminator: Option<&ProcessTreeTerminator>, temp_dir: &Path) {
  if let Some(terminator) = terminator {
    let _ = terminator.terminate();
  } else {
    let _ = child.kill();
  }
  let _ = child.wait();
  let _ = fs::remove_dir_all(temp_dir);
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
  if state.is_cancelled(&request.run_id) {
    return Err("Agent run was cancelled before start".to_string());
  }
  let api_origin = allowed_api_origin(&request.api_origin)?;
  let codex = resolve_allowlisted_executable("codex").ok_or("Codex CLI is not installed")?;
  let node = resolve_allowlisted_executable("node").ok_or("Node.js is required for the Canvas MCP bridge")?;
  let mcp_script = resolve_mcp_script(&app)?;
  // Reject duplicates before allocating a temporary run directory. Run IDs
  // are single-use and a rejected duplicate must not leave filesystem state.
  {
    let runs = state.runs.lock().map_err(|_| "Agent process state is unavailable")?;
    if runs.contains_key(&request.run_id) { return Err("Agent run already exists".to_string()); }
  }
  let temp_dir = create_temp_run_dir(&request.run_id, &request.project_id, &api_origin, &mcp_script)?;

  // Debug-only deterministic lifecycle gates for the desktop E2E suite. These
  // are intentionally compiled out of release builds and are never surfaced
  // through the regular UI.
  #[cfg(debug_assertions)]
  debug_delay_from_env("RECOMBYN_TEST_DELAY_BEFORE_SPAWN_MS");
  if state.is_cancelled(&request.run_id) {
    let _ = fs::remove_dir_all(&temp_dir);
    return Err("Agent run was cancelled before start".to_string());
  }

  let mut command = Command::new(codex);
  command.args(codex_exec_args());
  for config_override in mcp_config_overrides(&node, &mcp_script) {
    command.arg("-c").arg(config_override);
  }
  command
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
  let mut child = match command.spawn() {
    Ok(child) => child,
    Err(error) => {
      let _ = fs::remove_dir_all(&temp_dir);
      return Err(format!("Failed to start Codex CLI: {error}"));
    }
  };
  let terminator = match ProcessTreeTerminator::attach(&child) {
    Ok(terminator) => Arc::new(terminator),
    Err(error) => {
      cleanup_unregistered_child(child, None, &temp_dir);
      return Err(format!("Failed to secure Codex process tree: {error}"));
    }
  };

  #[cfg(debug_assertions)]
  debug_delay_from_env("RECOMBYN_TEST_DELAY_AFTER_SPAWN_MS");
  if debug_fail_after_spawn() {
    cleanup_unregistered_child(child, Some(&terminator), &temp_dir);
    return Err("Controlled debug failure after Codex spawn".to_string());
  }
  let terminated = Arc::new(AtomicBool::new(false));
  let termination_reason = Arc::new(Mutex::new(None));
  let managed_run = ManagedRun {
    terminator: terminator.clone(),
    terminated: terminated.clone(),
    termination_reason: termination_reason.clone(),
  };
  if let Err((reason, _run)) = state.register_run(&request.run_id, managed_run) {
    cleanup_unregistered_child(child, Some(&terminator), &temp_dir);
    return Err(reason);
  }

  let mut stdin = match child.stdin.take() {
    Some(stdin) => stdin,
    None => {
      cleanup_started_child(&state, &request.run_id, child, &terminator, &terminated, &termination_reason, &temp_dir);
      return Err("Codex stdin is unavailable".to_string());
    }
  };
  if let Err(error) = stdin.write_all(request.prompt.as_bytes()) {
    cleanup_started_child(&state, &request.run_id, child, &terminator, &terminated, &termination_reason, &temp_dir);
    return Err(error.to_string());
  }
  if let Err(error) = stdin.flush() {
    cleanup_started_child(&state, &request.run_id, child, &terminator, &terminated, &termination_reason, &temp_dir);
    return Err(error.to_string());
  }
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
    thread::sleep(configured_run_duration());
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
  state.mark_cancelled(&run_id)
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

  #[test]
  fn scopes_mcp_approvals_to_phase_one_canvas_tools() {
    let overrides = mcp_config_overrides(Path::new("node"), Path::new("canvas.mjs"));
    assert_eq!(overrides.len(), 4 + PHASE_ONE_CANVAS_TOOLS.len());
    assert!(overrides.iter().any(|value| value ==
      "mcp_servers.recombyn.enabled_tools=[\"get_scene_summary\",\"list_nodes\",\"list_frames\",\"apply_tool_ops\",\"create_frame\",\"create_shape\",\"create_text\",\"update_node\"]"));
    for tool in PHASE_ONE_CANVAS_TOOLS {
      assert!(overrides.iter().any(|value| value ==
        &format!("mcp_servers.recombyn.tools.{tool}.approval_mode=\"approve\"")));
    }
    assert!(!overrides.iter().any(|value| value.contains("default_tools_approval_mode")));
  }

  #[cfg(any(test, debug_assertions))]
  #[test]
  fn parses_test_run_timeout_without_changing_production_default() {
    assert_eq!(parse_test_run_timeout(Some("1500")), Some(Duration::from_millis(1500)));
    assert_eq!(parse_test_run_timeout(Some(" 2000 ")), Some(Duration::from_millis(2000)));
    assert_eq!(parse_test_run_timeout(Some("0")), None);
    assert_eq!(parse_test_run_timeout(Some("bad")), None);
    assert_eq!(MAX_RUN_DURATION, Duration::from_secs(600));
  }

  #[test]
  fn uses_one_compatibility_model_argument() {
    let args = codex_exec_args();
    let model_positions: Vec<usize> = args
      .iter()
      .enumerate()
      .filter_map(|(index, value)| (*value == "--model").then_some(index))
      .collect();

    assert_eq!(model_positions, vec![7]);
    assert_eq!(args[model_positions[0] + 1], CODEX_RUNTIME_DEFAULT_MODEL);
  }

  #[test]
  fn cancellation_records_tombstone_without_active_run() {
    let state = AgentProcessState::default();

    state.mark_cancelled("run-before-start").expect("cancellation should be recorded");

    assert!(state.is_cancelled("run-before-start"));
    assert!(!state.runs.lock().expect("run state should be available").contains_key("run-before-start"));
  }

  #[test]
  fn registration_rejects_cancelled_run_before_inserting_it() {
    let state = AgentProcessState::default();
    state.mark_cancelled("run-race").expect("cancellation should be recorded");
    let child = spawn_test_child();
    let terminator = Arc::new(ProcessTreeTerminator::attach(&child).expect("terminator should attach"));

    // The registration helper must inspect the tombstone while holding the
    // same lock order used by cancellation. A real ManagedRun is unnecessary
    // here because rejection happens before the value is stored.
    let result = state.register_run(
      "run-race",
      ManagedRun {
        terminator: terminator.clone(),
        terminated: Arc::new(AtomicBool::new(false)),
        termination_reason: Arc::new(Mutex::new(None)),
      },
    );

    let (reason, run) = result.expect_err("cancelled run must not register");
    assert_eq!(reason, "Agent run was cancelled before start");
    drop(run);
    cleanup_unregistered_child(child, Some(&terminator), Path::new(""));
    assert!(!state.runs.lock().expect("run state should be available").contains_key("run-race"));
  }

  fn spawn_test_child() -> std::process::Child {
    #[cfg(windows)]
    {
      let mut command = Command::new("cmd.exe");
      command.args(["/C", "ping.exe -n 30 127.0.0.1 > NUL"]);
      configure_process_group(&mut command);
      return command.spawn().expect("cmd.exe should be available on Windows");
    }
    #[cfg(not(windows))]
    {
      let mut command = Command::new("sh");
      command.args(["-c", "sleep 30"]);
      configure_process_group(&mut command);
      return command.spawn().expect("sh should be available on Unix");
    }
  }
}

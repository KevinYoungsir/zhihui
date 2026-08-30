mod agent_runtime;

use agent_runtime::AgentProcessState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AgentProcessState::default())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      agent_runtime::discover_codex,
      agent_runtime::start_codex_run,
      agent_runtime::cancel_codex_run,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        if let Some(state) = app_handle.try_state::<AgentProcessState>() {
          state.terminate_all();
        }
      }
    });
}

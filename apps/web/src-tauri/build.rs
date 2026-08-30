fn main() {
  let api_origin = std::env::var("VITE_API_BASE_URL")
    .unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());
  println!(
    "cargo:rustc-env=RECOMBYN_DESKTOP_API_ORIGIN={}",
    api_origin.trim_end_matches('/')
  );
  tauri_build::build()
}

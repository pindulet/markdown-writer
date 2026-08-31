#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct WatcherState(Mutex<Option<notify::RecommendedWatcher>>);

// Filer åbnet fra Finder, inden frontenden er klar til at modtage events.
struct OpenState {
    pending: Mutex<Vec<String>>,
    ready: AtomicBool,
}

#[derive(Serialize, Clone)]
struct FileEntry {
    name: String,
    path: String,
    rel_dir: String,
    modified_ms: u64,
}

fn collect_md(dir: &Path, root: &Path, out: &mut Vec<FileEntry>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_md(&path, root, out);
        } else if path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            let modified_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let rel_dir = path
                .parent()
                .and_then(|p| p.strip_prefix(root).ok())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or(file_name);
            out.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                rel_dir,
                modified_ms,
            });
        }
    }
}

#[tauri::command]
fn list_folder(path: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Mappen findes ikke".into());
    }
    let mut out = Vec::new();
    collect_md(&root, &root, &mut out);
    Ok(out)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// Atomic write: the file on disk is always either the old or the new
// version, so a concurrent reader (Claude) never sees a half-written file.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let file_name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("Ugyldig sti")?;
    let tmp = target.with_file_name(format!(".{}.writing", file_name));
    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(dir: String, name: String) -> Result<String, String> {
    let base = PathBuf::from(&dir);
    let mut candidate = base.join(format!("{}.md", name));
    let mut i = 2;
    while candidate.exists() {
        candidate = base.join(format!("{} {}.md", name, i));
        i += 1;
    }
    fs::write(&candidate, "").map_err(|e| e.to_string())?;
    Ok(candidate.to_string_lossy().to_string())
}

#[tauri::command]
fn rename_file(path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&path);
    let parent = old.parent().ok_or("Ugyldig sti")?;
    let new_path = parent.join(format!("{}.md", new_name));
    if new_path.exists() {
        return Err("Der findes allerede en note med det navn".into());
    }
    fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn frontend_ready(state: State<OpenState>) -> Vec<String> {
    state.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *state.pending.lock().unwrap())
}

#[tauri::command]
fn watch_folder(app: AppHandle, path: String, state: State<WatcherState>) -> Result<(), String> {
    use notify::Watcher;
    let mut guard = state.0.lock().map_err(|_| "watcher lock")?;
    *guard = None; // drop any previous watcher before replacing it
    let handle = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| p.ends_with(".md"))
                    .collect();
                if paths.is_empty() {
                    return;
                }
                let _ = handle.emit("fs-change", paths);
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *guard = Some(watcher);
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(WatcherState(Mutex::new(None)))
        .manage(OpenState {
            pending: Mutex::new(Vec::new()),
            ready: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            list_folder,
            read_file,
            write_file,
            create_file,
            rename_file,
            delete_file,
            watch_folder,
            frontend_ready
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            let state = app_handle.state::<OpenState>();
            if state.ready.load(Ordering::SeqCst) {
                let _ = app_handle.emit("open-file", paths);
            } else {
                state.pending.lock().unwrap().extend(paths);
            }
        }
    });
}

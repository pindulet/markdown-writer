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

#[derive(Serialize)]
struct FolderListing {
    files: Vec<FileEntry>,
    dirs: Vec<String>,
}

fn collect_md(dir: &Path, root: &Path, out: &mut Vec<FileEntry>, dirs: &mut Vec<String>) {
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
            if let Ok(rel) = path.strip_prefix(root) {
                dirs.push(rel.to_string_lossy().to_string());
            }
            collect_md(&path, root, out, dirs);
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
fn list_folder(path: String) -> Result<FolderListing, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Mappen findes ikke".into());
    }
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    collect_md(&root, &root, &mut files, &mut dirs);
    Ok(FolderListing { files, dirs })
}

#[tauri::command]
fn save_image(dir: String, name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| e.to_string())?;
    let base = PathBuf::from(&dir);
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), e.to_string()),
        None => (name.clone(), "png".to_string()),
    };
    let mut candidate = base.join(format!("{}.{}", stem, ext));
    let mut i = 2;
    while candidate.exists() {
        candidate = base.join(format!("{} {}.{}", stem, i, ext));
        i += 1;
    }
    fs::write(&candidate, bytes).map_err(|e| e.to_string())?;
    Ok(candidate.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(dir: String, name: String) -> Result<String, String> {
    let base = PathBuf::from(&dir);
    let mut candidate = base.join(&name);
    let mut i = 2;
    while candidate.exists() {
        candidate = base.join(format!("{} {}", name, i));
        i += 1;
    }
    fs::create_dir_all(&candidate).map_err(|e| e.to_string())?;
    Ok(candidate.to_string_lossy().to_string())
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

// ---------- Git-synk ----------
// Vaulten kan være et git-repo (GitHub ejer noterne). Appen synker ved at
// skygge det, obsidian-git gjorde: stage → commit → pull --rebase → push.
// Alt kører via systemets git, så eksisterende SSH-opsætning genbruges.

#[derive(Serialize)]
struct GitSyncResult {
    status: String, // "ok" | "offline" | "conflict" | "error"
    committed: usize,
    detail: String,
}

fn git(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // hæng aldrig på en prompt — fejl i stedet, så UI'et kan vise det
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .output()
        .map_err(|e| format!("git kunne ikke startes: {}", e))
}

fn git_text(out: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn looks_offline(text: &str) -> bool {
    [
        "Could not resolve host",
        "unable to access",
        "Could not read from remote",
        "Connection refused",
        "Connection timed out",
        "Operation timed out",
        "Network is unreachable",
        "ssh: connect to host",
    ]
    .iter()
    .any(|m| text.contains(m))
}

#[tauri::command]
async fn git_info(path: String) -> Result<bool, String> {
    let out = git(&path, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true")
}

#[tauri::command]
async fn git_sync(path: String) -> Result<GitSyncResult, String> {
    let fail = |detail: String| GitSyncResult {
        status: "error".into(),
        committed: 0,
        detail,
    };

    // stage alt — undtagen editorens midlertidige skrivefiler og
    // obsidian-git's credentials-fil, som aldrig må ende på GitHub
    let add = git(
        &path,
        &[
            "add",
            "-A",
            "--",
            ".",
            ":(exclude,glob)**/.*.writing",
            ":(exclude,glob)**/.git_credentials_input",
        ],
    )?;
    if !add.status.success() {
        return Ok(fail(git_text(&add)));
    }

    let staged = git(&path, &["diff", "--cached", "--name-only"])?;
    let files: Vec<String> = String::from_utf8_lossy(&staged.stdout)
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let committed = files.len();

    if committed > 0 {
        let mut names: Vec<String> = files
            .iter()
            .take(3)
            .map(|f| {
                let base = f.rsplit('/').next().unwrap_or(f);
                base.strip_suffix(".md").unwrap_or(base).to_string()
            })
            .collect();
        if committed > 3 {
            names.push(format!("(+{} flere)", committed - 3));
        }
        let msg = format!("Noter: {}", names.join(", "));
        let commit = git(&path, &["commit", "-m", &msg])?;
        if !commit.status.success() {
            return Ok(fail(git_text(&commit)));
        }
    }

    let pull = git(&path, &["pull", "--rebase"])?;
    if !pull.status.success() {
        let text = git_text(&pull);
        if looks_offline(&text) {
            return Ok(GitSyncResult {
                status: "offline".into(),
                committed,
                detail: text,
            });
        }
        // efterlad aldrig repoet midt i en rebase
        let _ = git(&path, &["rebase", "--abort"]);
        let status = if text.contains("CONFLICT") || text.contains("could not apply") {
            "conflict"
        } else {
            "error"
        };
        return Ok(GitSyncResult {
            status: status.into(),
            committed,
            detail: text,
        });
    }

    let push = git(&path, &["push"])?;
    if !push.status.success() {
        let text = git_text(&push);
        let status = if looks_offline(&text) { "offline" } else { "error" };
        return Ok(GitSyncResult {
            status: status.into(),
            committed,
            detail: text,
        });
    }

    Ok(GitSyncResult {
        status: "ok".into(),
        committed,
        detail: String::new(),
    })
}

// ---------- AI-forslag ----------
// Autocomplete kalder Anthropic direkte fra Rust-siden, så API-nøglen
// aldrig ligger i webviewet. Stilprompten (destilleret fra "Skriv som
// Kristian"-skillen) caches hos Anthropic i op til en time, så hvert
// kald reelt kun betaler for den nære kontekst omkring markøren.

// modeller man kan vælge i statusbaren; første er standard. Thinking slås
// fra for fart: Sonnet 5.5 afviser "disabled" og bruger "between_tools"
const AI_MODELS: &[(&str, &str)] = &[
    ("claude-haiku-4-5", "disabled"),
    ("claude-sonnet-5", "disabled"),
    ("claude-sonnet-5-5", "between_tools"),
];
const AI_STYLE_PROMPT: &str = include_str!("../prompts/autocomplete.md");

struct AiState {
    client: reqwest::Client,
}

fn ai_key_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("anthropic-key"))
}

fn read_ai_key(app: &AppHandle) -> Option<String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let path = ai_key_path(app)?;
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn ai_key_present(app: AppHandle) -> bool {
    read_ai_key(&app).is_some()
}

#[tauri::command]
fn ai_set_key(app: AppHandle, key: String) -> Result<(), String> {
    let path = ai_key_path(&app).ok_or("Ingen konfigurationsmappe")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, key.trim()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
async fn suggest_completion(
    app: AppHandle,
    state: State<'_, AiState>,
    title: String,
    prefix: String,
    suffix: String,
    model: Option<String>,
) -> Result<String, String> {
    let key = read_ai_key(&app).ok_or("Ingen API-nøgle")?;
    let (model, thinking) = AI_MODELS
        .iter()
        .find(|(id, _)| Some(*id) == model.as_deref())
        .unwrap_or(&AI_MODELS[0]);
    // sidste ord(fragment) før markøren bruges som anker: modellen starter
    // sit svar med det, og vi skærer det af igen, så svaret er ren
    // fortsættelse. (Sonnet 5 og nyere understøtter ikke assistant-prefill.)
    let trimmed_prefix = prefix.trim_end();
    let ends_in_whitespace = trimmed_prefix.len() != prefix.len();
    let last_word = trimmed_prefix
        .rsplit(|c: char| c.is_whitespace())
        .next()
        .unwrap_or("");
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 120,
        "thinking": {"type": thinking},
        "system": [{
            "type": "text",
            "text": AI_STYLE_PROMPT,
            "cache_control": {"type": "ephemeral", "ttl": "1h"}
        }],
        "stop_sequences": ["</forslag>"],
        "messages": [{
            "role": "user",
            "content": format!(
                "Note: {}\n\n<tekst_foer_markoer>\n{}\n</tekst_foer_markoer>\n<tekst_efter_markoer>\n{}\n</tekst_efter_markoer>\n\nAnkerordet er: {}\nForeslå fortsættelsen ved markøren. Start svaret med <forslag>{}",
                title, prefix, suffix, last_word, last_word
            )
        }]
    });
    let resp = state
        .client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .timeout(std::time::Duration::from_secs(10))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API-fejl {}: {}", status, text));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    if let Some(blocks) = json.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    let out = match out.find("</forslag>") {
        Some(i) => out[..i].to_string(),
        None => out,
    };
    // skær "<forslag>" og ankerordet af, som modellen selv har gentaget
    let out = match out.find("<forslag>") {
        Some(i) => out[i + "<forslag>".len()..].to_string(),
        None => out.trim_start().to_string(),
    };
    let out = match out.strip_prefix(last_word) {
        Some(rest) if !last_word.is_empty() => rest.to_string(),
        _ => out,
    };
    let out = out.trim_end().to_string();
    // PAS også når modellen pakker det ind ("PAS.", "\"PAS\"", " PAS")
    let core: &str = out.trim().trim_matches(|c: char| !c.is_alphanumeric());
    if core == "PAS" {
        return Ok(String::new());
    }
    // ankerordet er skåret af og indgår ikke i svaret. Ender prefixet med
    // whitespace, står adskillelsen allerede i noten, så et ledende
    // mellemrum i fortsættelsen fjernes for ikke at fordoble det
    let out = if ends_in_whitespace {
        out.trim_start().to_string()
    } else {
        out
    };
    Ok(out)
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
        .manage(AiState {
            client: reqwest::Client::new(),
        })
        .invoke_handler(tauri::generate_handler![
            list_folder,
            read_file,
            write_file,
            create_file,
            create_folder,
            save_image,
            rename_file,
            delete_file,
            watch_folder,
            git_info,
            git_sync,
            frontend_ready,
            ai_key_present,
            ai_set_key,
            suggest_completion
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| match u.scheme() {
                    "file" => u
                        .to_file_path()
                        .ok()
                        .map(|p| p.to_string_lossy().to_string()),
                    // url-scheme: mdwriter:///absolut/sti/til/note.md
                    // (procent-kodet), så links fra fx Claude åbner direkte
                    "mdwriter" => {
                        let path = percent_encoding::percent_decode_str(u.path())
                            .decode_utf8()
                            .ok()?
                            .to_string();
                        // skrives linket med to skråstreger (mdwriter://Users/…),
                        // ender første led som "host" — sæt det tilbage på stien
                        match u.host_str() {
                            Some(host) if !host.is_empty() => {
                                Some(format!("/{}{}", host, path))
                            }
                            _ => Some(path),
                        }
                    }
                    _ => None,
                })
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

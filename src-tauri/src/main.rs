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
// skygge det, obsidian-git gjorde: stage → commit → fetch → rebase → push.
// Alt kører via systemets git, så eksisterende SSH-opsætning genbruges.
// Telefonen skriver også til repoet, så synken må aldrig sidde fast i en
// konflikt: .md flettes med union (begge sider bevares), og resten afgøres
// automatisk i finish_rebase, uden at noget går tabt. En rebase eller merge,
// som appen ikke selv har startet, røres aldrig.

// højst så mange konflikt-runder (efter sammenlægningen er der højst én)
const MAX_REBASE_ROUNDS: usize = 20;

// markør i rebasens egen mappe (.git/rebase-merge): rebasen er appens
const SYNC_MARKER: &str = "markdown-writer-sync";

// editorens midlertidige skrivefiler og obsidian-git's credentials-fil
// må aldrig ende på GitHub (eller i en sikkerhedskopi)
const SYNC_EXCLUDES: [&str; 2] = [
    ":(exclude,glob)**/.*.writing",
    ":(exclude,glob)**/.git_credentials_input",
];

#[derive(Serialize, Debug)]
struct GitSyncResult {
    status: String, // "ok" | "offline" | "conflict" | "error"
    committed: usize,
    detail: String,
}

fn git_command(dir: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        // hæng aldrig på en prompt eller en editor — fejl i stedet, så UI'et kan vise det
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .env("GIT_EDITOR", "true");
    cmd
}

// en fejlende kommando bliver til Err med gits egen tekst
fn run_ok(cmd: &mut std::process::Command) -> Result<std::process::Output, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("git kunne ikke startes: {}", e))?;
    if out.status.success() {
        Ok(out)
    } else {
        Err(git_text(&out))
    }
}

fn git(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    git_command(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git kunne ikke startes: {}", e))
}

fn git_ok(dir: &str, args: &[&str]) -> Result<std::process::Output, String> {
    run_ok(git_command(dir).args(args))
}

fn git_line(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = git_ok(dir, args)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// NUL-separeret liste fra fx `diff --name-only -z`
fn git_list(dir: &str, args: &[&str]) -> Result<Vec<String>, String> {
    let out = git_ok(dir, args)?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
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

// sti i .git-mappen (virker også i worktrees)
fn git_path(dir: &str, name: &str) -> Option<PathBuf> {
    let p = git_line(dir, &["rev-parse", "--git-path", name]).ok()?;
    Some(Path::new(dir).join(p))
}

fn rebase_dir(dir: &str) -> Option<PathBuf> {
    ["rebase-merge", "rebase-apply"]
        .iter()
        .filter_map(|name| git_path(dir, name))
        .find(|p| p.exists())
}

fn rebase_in_progress(dir: &str) -> bool {
    rebase_dir(dir).is_some()
}

// appens egen rebase: markøren ligger inde i rebasens egen mappe, som git
// sletter ved --abort og når rebasen er færdig — så den kan aldrig overleve
// og gøre en senere, fremmed rebase til appens. Dør appen midt i selve
// `git rebase`, før markøren er skrevet, ser rebasen fremmed ud (den sikre side).
fn own_rebase(dir: &str) -> bool {
    rebase_dir(dir).is_some_and(|r| r.join(SYNC_MARKER).exists())
}

fn mark_own_rebase(dir: &str) -> Result<(), String> {
    let r = rebase_dir(dir).ok_or("Rebasen forsvandt.")?;
    fs::write(r.join(SYNC_MARKER), "").map_err(|e| e.to_string())
}

// en git-handling, som nogen er midt i uden for appen
fn foreign_operation(dir: &str) -> Option<&'static str> {
    if rebase_in_progress(dir) {
        return Some("En rebase");
    }
    [
        ("MERGE_HEAD", "En merge"),
        ("CHERRY_PICK_HEAD", "En cherry-pick"),
        ("REVERT_HEAD", "En revert"),
    ]
    .iter()
    .find(|(name, _)| git_path(dir, name).is_some_and(|p| p.exists()))
    .map(|(_, label)| *label)
}

// Det, der er gemt i arbejdstræet, mens en rebase stod stille. Stagede og
// uflettede stier er rebasens egne mellemresultater og kasseres af aborten.
struct SavedFile {
    path: String,
    content: Option<Vec<u8>>, // None: slettet
    tracked: bool,
}

// Sikkerhedskopi før `rebase --abort`: filerne holdes i hukommelsen til
// genskrivningen og lægges i refs/markdown-writer/backup-<tid>, hvis appen
// skulle dø imellem. `git stash create` duer ikke her: den fejler, så snart
// indekset har uflettede stier, og stash apply kan give konfliktmarkører.
fn snapshot_worktree(root: &str) -> Result<(Vec<SavedFile>, Option<String>), String> {
    let unmerged = unmerged_paths(root)?;
    let with_excludes = |args: &[&'static str]| -> Vec<&'static str> {
        args.iter().chain(SYNC_EXCLUDES.iter()).copied().collect()
    };
    let mut paths: Vec<(String, bool)> =
        git_list(root, &with_excludes(&["diff", "--name-only", "-z", "--", "."]))?
            .into_iter()
            .map(|p| (p, true))
            .collect();
    paths.extend(
        git_list(
            root,
            &with_excludes(&["ls-files", "-z", "--others", "--exclude-standard", "--", "."]),
        )?
        .into_iter()
        .map(|p| (p, false)),
    );
    paths.sort();
    paths.dedup();

    let mut files = Vec::new();
    for (path, tracked) in paths {
        if unmerged.contains_key(&path) {
            continue;
        }
        let full = Path::new(root).join(&path);
        let content = match fs::symlink_metadata(&full) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("{}: {}", path, e)),
            // mapper og symlinks er ikke noter, og git genskaber dem selv
            Ok(meta) if !meta.is_file() => continue,
            Ok(_) => Some(fs::read(&full).map_err(|e| format!("{}: {}", path, e))?),
        };
        files.push(SavedFile { path, content, tracked });
    }
    if files.is_empty() {
        return Ok((files, None));
    }

    let index = git_path(root, "markdown-writer-backup.index")
        .ok_or("Kunne ikke finde .git-mappen.")?;
    let _ = fs::remove_file(&index);
    let with_index =
        |args: &[&str]| run_ok(git_command(root).env("GIT_INDEX_FILE", &index).args(args));
    let made = (|| -> Result<String, String> {
        with_index(&["read-tree", "HEAD"])?;
        // update-index, ikke add: en slettet sti, der ikke er i HEAD, er ingen fejl
        let mut update = vec!["update-index", "--add", "--remove", "--"];
        update.extend(files.iter().map(|f| f.path.as_str()));
        with_index(&update)?;
        let tree = with_index(&["write-tree"])?;
        let tree = String::from_utf8_lossy(&tree.stdout).trim().to_string();
        let mut commit = git_command(root);
        for var in ["GIT_AUTHOR", "GIT_COMMITTER"] {
            commit
                .env(format!("{}_NAME", var), "Markdown Writer")
                .env(format!("{}_EMAIL", var), "markdown-writer@localhost");
        }
        let commit = run_ok(commit.args([
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            "Markdown Writer: ucommittede ændringer før rebase --abort",
        ]))?;
        let sha = String::from_utf8_lossy(&commit.stdout).trim().to_string();
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let reference = format!("refs/markdown-writer/backup-{}", millis);
        git_ok(root, &["update-ref", &reference, &sha])?;
        Ok(reference)
    })();
    let _ = fs::remove_file(&index);
    let reference = made.map_err(|e| format!("Sikkerhedskopi før rebase --abort mislykkedes: {}", e))?;
    Ok((files, Some(reference)))
}

// skriver det gemte tilbage, hvor aborten har ændret det
fn restore_worktree(root: &str, files: &[SavedFile]) -> Result<(), String> {
    for f in files {
        let full = Path::new(root).join(&f.path);
        let io = |e: std::io::Error| format!("{}: {}", f.path, e);
        match (&f.content, fs::read(&full)) {
            (None, Ok(_)) => fs::remove_file(&full).map_err(io)?,
            (None, Err(_)) => {}
            (Some(saved), Ok(now)) if &now == saved => {}
            // en ny fil, der er væk igen, har appen selv flyttet
            (Some(_), Err(e)) if e.kind() == std::io::ErrorKind::NotFound && !f.tracked => {}
            (Some(saved), _) => {
                if let Some(parent) = full.parent() {
                    fs::create_dir_all(parent).map_err(io)?;
                }
                fs::write(&full, saved).map_err(io)?;
            }
        }
    }
    Ok(())
}

// Afbryder appens egen rebase uden at miste det, der er gemt imens
fn abort_rebase(dir: &str) -> Result<(), String> {
    let root = git_line(dir, &["rev-parse", "--show-toplevel"])?;
    let (files, reference) = snapshot_worktree(&root)?;
    let abort = git(&root, &["rebase", "--abort"])?;
    let restored = restore_worktree(&root, &files);
    let kept = |why: String| match &reference {
        Some(r) => format!("{}\nDe ucommittede ændringer er gemt i {}.", why.trim_end(), r),
        None => why,
    };
    if !abort.status.success() {
        return Err(kept(git_text(&abort)));
    }
    restored.map_err(kept)?;
    if let Some(r) = &reference {
        let _ = git(&root, &["update-ref", "-d", r]);
    }
    Ok(())
}

// stadie 2 og 3 for en uflettet sti; under en rebase er 2 upstream og 3 det
// lokale commit, der er ved at blive lagt ovenpå
#[derive(Default)]
struct Unmerged {
    upstream: Option<String>,
    local: Option<String>,
}

fn unmerged_paths(root: &str) -> Result<std::collections::BTreeMap<String, Unmerged>, String> {
    let out = git_ok(root, &["ls-files", "-u", "-z"])?;
    let mut paths = std::collections::BTreeMap::<String, Unmerged>::new();
    for entry in String::from_utf8_lossy(&out.stdout).split('\0') {
        // "<mode> <sha> <stadie>\t<sti>"
        let Some((meta, path)) = entry.split_once('\t') else {
            continue;
        };
        let mut meta = meta.split(' ').skip(1);
        let (Some(sha), Some(stage)) = (meta.next(), meta.next()) else {
            continue;
        };
        let e = paths.entry(path.to_string()).or_default();
        match stage {
            "2" => e.upstream = Some(sha.to_string()),
            "3" => e.local = Some(sha.to_string()),
            _ => {}
        }
    }
    Ok(paths)
}

// "Mappe/data.json" → "Mappe/data (konflikt).json" (eller "(konflikt 2)" osv.)
fn conflict_copy_name(root: &str, path: &str) -> String {
    let (dir, file) = match path.rsplit_once('/') {
        Some((d, f)) => (format!("{}/", d), f),
        None => (String::new(), path),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => file.split_at(i),
        _ => (file, ""),
    };
    let mut n = 1;
    loop {
        let label = if n == 1 {
            "konflikt".to_string()
        } else {
            format!("konflikt {}", n)
        };
        let candidate = format!("{}{} ({}){}", dir, stem, label, ext);
        if !Path::new(root).join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

fn resolve_path(root: &str, path: &str, entry: &Unmerged) -> Result<(), String> {
    // stierne kommer fra git selv og skal ikke tolkes som mønstre
    let run = |args: &[&str]| -> Result<(), String> {
        let mut full = vec!["--literal-pathspecs"];
        full.extend_from_slice(args);
        git_ok(root, &full).map(|_| ())
    };
    match (&entry.upstream, &entry.local) {
        // ændret begge steder og ikke flettet (fx binært eller ikke-md):
        // behold den lokale og gem upstreams version ved siden af
        (Some(up), Some(_)) => {
            run(&["checkout", "--theirs", "--", path])?;
            run(&["add", "--", path])?;
            let blob = git_ok(root, &["cat-file", "blob", up])?;
            let copy = conflict_copy_name(root, path);
            fs::write(Path::new(root).join(&copy), &blob.stdout)
                .map_err(|e| format!("{}: {}", copy, e))?;
            // er kopien gitignored, bliver den bare liggende lokalt
            let _ = run(&["add", "--", &copy]);
        }
        // slettet i upstream, ændret lokalt → behold den lokale
        (None, Some(_)) => {
            run(&["checkout", "--theirs", "--", path])?;
            run(&["add", "--", path])?;
        }
        // slettet lokalt, ændret i upstream → behold upstream
        (Some(_), None) => {
            run(&["checkout", "--ours", "--", path])?;
            run(&["add", "--", path])?;
        }
        // slettet begge steder
        (None, None) => run(&["rm", "--cached", "--quiet", "--ignore-unmatch", "--", path])?,
    }
    Ok(())
}

// Kører en stoppet rebase færdig ved at løse konflikterne runde for runde.
// Returnerer antallet af løste filer; Err betyder, at kalderen skal afbryde.
fn finish_rebase(path: &str, attributes: &str, max_rounds: usize) -> Result<usize, String> {
    let top = git_ok(path, &["rev-parse", "--show-toplevel"])?;
    let root = String::from_utf8_lossy(&top.stdout).trim().to_string();
    let mut resolved = std::collections::BTreeSet::<String>::new();
    for _ in 0..max_rounds {
        if !rebase_in_progress(&root) {
            return Ok(resolved.len());
        }
        let unmerged = unmerged_paths(&root)?;
        if unmerged.is_empty() {
            return Err("Rebasen stoppede uden konflikter, der kan løses automatisk.".into());
        }
        for (p, entry) in &unmerged {
            resolve_path(&root, p, entry)?;
            resolved.insert(p.clone());
        }
        // blev commit'et tomt af løsningen (fx en sletning, hvor upstream
        // vandt), springes det over i stedet for at fejle som "tomt"
        let unchanged = git(&root, &["diff", "--cached", "--quiet", "HEAD"])?
            .status
            .success();
        let step = if unchanged { "--skip" } else { "--continue" };
        let out = git(&root, &["-c", attributes, "-c", "core.editor=true", "rebase", step])?;
        if !out.status.success() && !rebase_in_progress(&root) {
            return Err(git_text(&out));
        }
    }
    if rebase_in_progress(&root) {
        Err(format!("Konflikterne kunne ikke løses på {} runder.", max_rounds))
    } else {
        Ok(resolved.len())
    }
}

#[tauri::command]
async fn git_sync(path: String) -> Result<GitSyncResult, String> {
    // union-merge for noter uden at ændre selve notes-repoet; mangler filen,
    // ignorerer git den, og synken kører som før
    let attributes = std::env::temp_dir().join("markdown-writer-union.gitattributes");
    let _ = fs::write(&attributes, "*.md merge=union\n");
    sync_repo(&path, &attributes)
}

fn sync_repo(path: &str, attributes_file: &Path) -> Result<GitSyncResult, String> {
    sync_repo_rounds(path, attributes_file, MAX_REBASE_ROUNDS)
}

// "Noter: a, b, c (+2 flere)"
fn notes_message(files: &[String]) -> String {
    let mut names: Vec<String> = files
        .iter()
        .take(3)
        .map(|f| {
            let base = f.rsplit('/').next().unwrap_or(f);
            base.strip_suffix(".md").unwrap_or(base).to_string()
        })
        .collect();
    if files.len() > 3 {
        names.push(format!("(+{} flere)", files.len() - 3));
    }
    format!("Noter: {}", names.join(", "))
}

// -z og quotepath=off: æøå i filnavne kommer ud som de er, ikke som "\303\246"
fn staged_files(path: &str) -> Result<Vec<String>, String> {
    git_list(
        path,
        &["-c", "core.quotepath=off", "diff", "--cached", "--name-only", "-z"],
    )
}

// Lokale commits, der ikke er pushet, lægges sammen til ét, så union kun
// fletter de to spidser. Fletter rebasen dem ét ad gangen, genopstår hver
// mellemversion af en linje, brugeren har skrevet videre på.
fn squash_local_commits(path: &str, base: &str) -> Result<(), String> {
    let head = git_line(path, &["rev-parse", "HEAD"])?;
    let range = format!("{}..HEAD", base);
    // hele beskeder, så trailers som Co-Authored-By bevares
    let subjects = git_line(path, &["log", "--reverse", "--format=- %B", &range])?;
    git_ok(path, &["reset", "--soft", base])?;
    let made = staged_files(path).and_then(|files| {
        // ændringerne gik lige op: grenen står nu på base
        if files.is_empty() {
            return Ok(());
        }
        let msg = format!(
            "{}\n\nSamlet af lokale commits:\n{}",
            notes_message(&files),
            subjects
        );
        git_ok(path, &["commit", "-q", "-m", &msg]).map(|_| ())
    });
    if made.is_err() {
        let _ = git(path, &["reset", "--soft", &head]);
    }
    made
}

fn sync_repo_rounds(
    path: &str,
    attributes_file: &Path,
    max_rounds: usize,
) -> Result<GitSyncResult, String> {
    let result = |status: &str, committed: usize, detail: String| GitSyncResult {
        status: status.into(),
        committed,
        detail,
    };
    let attributes = format!("core.attributesFile={}", attributes_file.display());

    // appens egen afbrudte synk (fx lukket midt i en rebase) må ikke låse
    // repoet; abort fører grenen tilbage til de lokale commits fra før
    if own_rebase(path) {
        if let Err(reason) = abort_rebase(path) {
            return Ok(result("error", 0, reason));
        }
    }
    // alt andet, nogen er midt i, er ikke appens at røre
    if let Some(what) = foreign_operation(path) {
        let detail = format!("{} er i gang i vaulten – gør den færdig i terminalen", what);
        return Ok(result("conflict", 0, detail));
    }
    let mut add_args = vec!["add", "-A", "--", "."];
    add_args.extend(SYNC_EXCLUDES);
    let add = git(path, &add_args)?;
    if !add.status.success() {
        return Ok(result("error", 0, git_text(&add)));
    }

    let files = match staged_files(path) {
        Ok(files) => files,
        Err(text) => return Ok(result("error", 0, text)),
    };
    let committed = files.len();
    if committed > 0 {
        let commit = git(path, &["commit", "-m", &notes_message(&files)])?;
        if !commit.status.success() {
            return Ok(result("error", 0, git_text(&commit)));
        }
    }

    let fetch = git(path, &["fetch", "--quiet"])?;
    if !fetch.status.success() {
        let text = git_text(&fetch);
        let status = if looks_offline(&text) { "offline" } else { "error" };
        return Ok(result(status, committed, text));
    }
    let tips = git_line(path, &["rev-parse", "@{u}"]).and_then(|upstream| {
        // --fork-point bruger upstreams reflog, så commits, der er fjernet fra
        // GitHub (force-push), ikke lægges ovenpå igen — som `pull --rebase`
        let base = git_line(path, &["merge-base", "--fork-point", "@{u}", "HEAD"])
            .ok()
            .filter(|b| !b.is_empty())
            .map_or_else(|| git_line(path, &["merge-base", "HEAD", &upstream]), Ok)
            .map_err(|e| format!("{}Ingen fælles historik med upstream.", e))?;
        let local = git_line(path, &["rev-list", "--count", &format!("{}..HEAD", base)])?;
        Ok((upstream, base, local.parse::<usize>().unwrap_or(0)))
    });
    let (upstream, base, local) = match tips {
        Ok(tips) => tips,
        Err(text) => return Ok(result("error", committed, text)),
    };

    let mut resolved = 0;
    // er upstream allerede med i HEAD, er der intet at lægge ovenpå
    if base != upstream {
        if local > 1 {
            if let Err(text) = squash_local_commits(path, &base) {
                return Ok(result("error", committed, text));
            }
        }

        // attributfilen gælder for hele rebasen, også --continue
        let rebase = git(
            path,
            &[
                "-c",
                &attributes,
                "-c",
                "core.editor=true",
                "rebase",
                "--onto",
                &upstream,
                &base,
            ],
        )?;
        if !rebase.status.success() {
            let text = git_text(&rebase);
            if rebase_in_progress(path) {
                if let Err(why) = mark_own_rebase(path) {
                    let _ = abort_rebase(path);
                    return Ok(result("error", committed, why));
                }
                match finish_rebase(path, &attributes, max_rounds) {
                    Ok(n) => resolved = n,
                    Err(reason) => {
                        // efterlad aldrig repoet midt i en rebase
                        let mut detail = format!("{}\n{}", text.trim_end(), reason);
                        if let Err(why) = abort_rebase(path) {
                            detail = format!("{}\n{}", detail, why);
                        }
                        return Ok(result("conflict", committed, detail));
                    }
                }
            } else {
                let status = if text.contains("CONFLICT") || text.contains("could not apply") {
                    "conflict"
                } else {
                    "error"
                };
                return Ok(result(status, committed, text));
            }
        }
    }

    let push = git(path, &["push"])?;
    if !push.status.success() {
        let text = git_text(&push);
        let status = if looks_offline(&text) { "offline" } else { "error" };
        return Ok(result(status, committed, text));
    }

    Ok(result(
        "ok",
        committed,
        match resolved {
            0 => String::new(),
            1 => "Konflikt løst automatisk: 1 fil".into(),
            n => format!("Konflikt løst automatisk: {} filer", n),
        },
    ))
}

#[cfg(test)]
mod git_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    // midlertidig mappe, der ryddes op, også når testen fejler
    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // bare-repo (GitHub) + to kloner: `a` er computeren, `b` er telefonen
    struct Repos {
        _tmp: TempDir,
        remote: PathBuf,
        a: PathBuf,
        b: PathBuf,
        attrs: PathBuf,
    }

    impl Repos {
        fn a(&self) -> &str {
            self.a.to_str().unwrap()
        }

        fn sync(&self) -> GitSyncResult {
            sync_repo(self.a(), &self.attrs).unwrap()
        }

        // telefonen ændrer noget og pusher
        fn push_from_b(&self, change: impl FnOnce(&Path)) {
            change(&self.b);
            sh(&self.b, &["add", "-A"]);
            sh(&self.b, &["commit", "-q", "-m", "Fra telefonen"]);
            sh(&self.b, &["push", "-q"]);
        }

        fn remote_file(&self, rel: &str) -> Option<String> {
            let spec = format!("main:{}", rel);
            let out = git(self.remote.to_str().unwrap(), &["show", &spec]).unwrap();
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).to_string())
        }

        // fælles slutkrav: ingen rebase, rent arbejdstræ, alt er pushet
        fn assert_settled(&self) {
            assert!(!rebase_in_progress(self.a()), "repoet er midt i en rebase");
            assert_eq!(sh(&self.a, &["status", "--porcelain"]), "");
            assert_eq!(
                sh(&self.a, &["rev-parse", "HEAD"]),
                sh(&self.remote, &["rev-parse", "main"])
            );
        }
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = git(dir.to_str().unwrap(), args).unwrap();
        assert!(out.status.success(), "git {:?}: {}", args, git_text(&out));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn write(dir: &Path, rel: &str, content: impl AsRef<[u8]>) {
        let p = dir.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn read(dir: &Path, rel: &str) -> String {
        fs::read_to_string(dir.join(rel)).unwrap()
    }

    const NOTE: &str = "# Note\n\nlinje et\nlinje to\nlinje tre\n";
    const DATA: &str = "{\n  \"farve\": \"blå\"\n}\n";
    const BIN: &[u8] = &[0, 1, 2, 3, 0, 255, 254, 0];

    fn bin(extra: u8) -> Vec<u8> {
        [BIN, &[extra]].concat()
    }

    fn setup() -> Repos {
        // brugerens egen git-opsætning må ikke påvirke testene
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

        let n = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("mw-git-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let tmp = TempDir(root.clone());

        sh(&root, &["-c", "init.defaultBranch=main", "init", "-q", "--bare", "remote.git"]);
        let seed = root.join("seed");
        sh(&root, &["-c", "init.defaultBranch=main", "init", "-q", "seed"]);
        sh(&seed, &["config", "user.name", "Seed"]);
        sh(&seed, &["config", "user.email", "seed@example.com"]);
        write(&seed, "Note.md", NOTE);
        write(&seed, "Anden.md", "Anden note\n");
        write(&seed, "data.json", DATA);
        write(&seed, "andet.json", DATA);
        write(&seed, "billede.bin", BIN);
        sh(&seed, &["add", "-A"]);
        sh(&seed, &["commit", "-q", "-m", "Start"]);
        sh(&seed, &["push", "-q", "../remote.git", "main"]);

        for (name, email) in [("a", "a@example.com"), ("b", "b@example.com")] {
            sh(&root, &["clone", "-q", "remote.git", name]);
            let dir = root.join(name);
            sh(&dir, &["config", "user.name", name]);
            sh(&dir, &["config", "user.email", email]);
        }

        let attrs = root.join("union.gitattributes");
        fs::write(&attrs, "*.md merge=union\n").unwrap();

        Repos {
            _tmp: tmp,
            remote: root.join("remote.git"),
            a: root.join("a"),
            b: root.join("b"),
            attrs,
        }
    }

    // et commit, der er fjernet fra GitHub med force-push, lægges ikke ovenpå igen
    #[test]
    fn fjernet_commit_genopstaar_ikke() {
        let r = setup();
        r.push_from_b(|b| write(b, "Hemmelig.md", "token\n"));
        assert_eq!(r.sync().status, "ok");
        assert!(r.a.join("Hemmelig.md").exists());
        // telefonen fjerner commit'et igen
        sh(&r.b, &["reset", "-q", "--hard", "HEAD~1"]);
        sh(&r.b, &["push", "-q", "-f"]);
        // computeren skriver videre i en anden note
        write(&r.a, "Note.md", format!("{}ny linje\n", NOTE));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(r.remote_file("Hemmelig.md"), None);
        assert!(r.remote_file("Note.md").unwrap().contains("ny linje"));
        r.assert_settled();
    }

    // sammenlagte commits beholder hele beskeden, også trailers
    #[test]
    fn sammenlagte_commits_beholder_trailers() {
        let r = setup();
        r.push_from_b(|b| write(b, "Anden.md", "Anden note\nfra telefonen\n"));
        write(&r.a, "Note.md", format!("{}en\n", NOTE));
        sh(&r.a, &["add", "-A"]);
        sh(&r.a, &["commit", "-q", "-m", "Første\n\nCo-Authored-By: Claude <noreply@anthropic.com>"]);
        write(&r.a, "Note.md", format!("{}en\nto\n", NOTE));
        sh(&r.a, &["add", "-A"]);
        sh(&r.a, &["commit", "-q", "-m", "Anden"]);

        assert_eq!(r.sync().status, "ok");
        let msg = sh(&r.a, &["log", "-1", "--format=%B"]);
        assert!(msg.contains("Co-Authored-By: Claude"), "{}", msg);
        r.assert_settled();
    }

    // (a) begge sider ændrer hver sin fil
    #[test]
    fn forskellige_filer_flettes() {
        let r = setup();
        r.push_from_b(|b| write(b, "Anden.md", "Anden note\nfra telefonen\n"));
        write(&r.a, "Note.md", format!("{}fra computeren\n", NOTE));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.committed, 1);
        assert_eq!(res.detail, "");
        assert_eq!(read(&r.a, "Anden.md"), "Anden note\nfra telefonen\n");
        assert!(r.remote_file("Note.md").unwrap().contains("fra computeren"));
        r.assert_settled();

        sh(&r.b, &["pull", "-q", "--rebase"]);
        assert!(read(&r.b, "Note.md").contains("fra computeren"));
    }

    // (b) samme linje ændret begge steder i en .md: union under rebase bevarer begge
    #[test]
    fn samme_linje_i_md_bevarer_begge() {
        let r = setup();
        r.push_from_b(|b| write(b, "Note.md", NOTE.replace("linje to", "linje to (telefon)")));
        write(&r.a, "Note.md", NOTE.replace("linje to", "linje to (computer)"));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        let merged = read(&r.a, "Note.md");
        assert!(merged.contains("linje to (telefon)"), "{}", merged);
        assert!(merged.contains("linje to (computer)"), "{}", merged);
        assert!(!merged.contains("<<<<<<<"), "{}", merged);
        assert_eq!(r.remote_file("Note.md").unwrap(), merged);
        r.assert_settled();
    }

    // (c) ændret lokalt, slettet på telefonen → den lokale version vinder
    #[test]
    fn aendret_lokalt_slettet_remote_beholder_lokal() {
        let r = setup();
        r.push_from_b(|b| fs::remove_file(b.join("Note.md")).unwrap());
        let mine = format!("{}vigtig tilføjelse\n", NOTE);
        write(&r.a, "Note.md", &mine);

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.detail, "Konflikt løst automatisk: 1 fil");
        assert_eq!(read(&r.a, "Note.md"), mine);
        assert_eq!(r.remote_file("Note.md").unwrap(), mine);
        r.assert_settled();
    }

    // (d) slettet lokalt, ændret på telefonen → telefonens version vinder
    #[test]
    fn slettet_lokalt_aendret_remote_beholder_remote() {
        let r = setup();
        let theirs = format!("{}skrevet på telefonen\n", NOTE);
        r.push_from_b(|b| write(b, "Note.md", &theirs));
        fs::remove_file(r.a.join("Note.md")).unwrap();

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.detail, "Konflikt løst automatisk: 1 fil");
        assert_eq!(read(&r.a, "Note.md"), theirs);
        assert_eq!(r.remote_file("Note.md").unwrap(), theirs);
        r.assert_settled();
    }

    // (e) konflikt i ikke-md og binære filer → lokal bevaret + "(konflikt)"-kopi
    #[test]
    fn konflikt_i_andre_filer_gemmer_kopi() {
        let r = setup();
        let theirs = DATA.replace("blå", "grøn");
        r.push_from_b(|b| {
            write(b, "data.json", &theirs);
            write(b, "billede.bin", bin(1));
        });
        let mine = DATA.replace("blå", "rød");
        write(&r.a, "data.json", &mine);
        write(&r.a, "billede.bin", bin(2));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.detail, "Konflikt løst automatisk: 2 filer");
        assert_eq!(read(&r.a, "data.json"), mine);
        assert_eq!(read(&r.a, "data (konflikt).json"), theirs);
        assert_eq!(fs::read(r.a.join("billede.bin")).unwrap(), bin(2));
        assert_eq!(
            fs::read(r.a.join("billede (konflikt).bin")).unwrap(),
            bin(1)
        );
        assert_eq!(r.remote_file("data.json").unwrap(), mine);
        assert_eq!(r.remote_file("data (konflikt).json").unwrap(), theirs);
        r.assert_settled();
    }

    // to lokale commits (fra to synk uden net), der støder sammen med telefonen
    fn two_conflicting_local_commits(r: &Repos) {
        let url = sh(&r.a, &["remote", "get-url", "origin"]);
        sh(&r.a, &["remote", "set-url", "origin", "/findes/ikke/remote.git"]);
        write(&r.a, "data.json", DATA.replace("blå", "rød"));
        assert_eq!(r.sync().status, "offline");
        // andet commit rører også en note, som kun union kan flette
        write(&r.a, "andet.json", DATA.replace("blå", "gul"));
        write(&r.a, "Note.md", NOTE.replace("linje tre", "linje tre (computer)"));
        assert_eq!(r.sync().status, "offline");
        sh(&r.a, &["remote", "set-url", "origin", url.trim()]);

        r.push_from_b(|b| {
            write(b, "data.json", DATA.replace("blå", "grøn"));
            write(b, "andet.json", DATA.replace("blå", "lilla"));
            write(b, "Note.md", NOTE.replace("linje tre", "linje tre (telefon)"));
        });
    }

    #[test]
    fn flere_runder_loeses_en_ad_gangen() {
        let r = setup();
        two_conflicting_local_commits(&r);

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.detail, "Konflikt løst automatisk: 2 filer");
        assert!(read(&r.a, "data.json").contains("rød"));
        assert!(read(&r.a, "data (konflikt).json").contains("grøn"));
        assert!(read(&r.a, "andet.json").contains("gul"));
        assert!(read(&r.a, "andet (konflikt).json").contains("lilla"));
        let note = read(&r.a, "Note.md");
        assert!(note.contains("linje tre (computer)") && note.contains("linje tre (telefon)"));
        assert!(!r.a.join("Note (konflikt).md").exists());
        r.assert_settled();
    }

    // (h) mislykkes løsningen, afbrydes rebasen, og de lokale ændringer er
    // urørte (de lokale commits kan være samlet til ét)
    #[test]
    fn mislykket_loesning_afbryder_rebasen() {
        let r = setup();
        two_conflicting_local_commits(&r);
        let before = sh(&r.a, &["rev-parse", "HEAD^{tree}"]);

        let res = sync_repo_rounds(r.a(), &r.attrs, 0).unwrap();
        assert_eq!(res.status, "conflict", "{:?}", res);
        assert!(!rebase_in_progress(r.a()));
        assert_eq!(sh(&r.a, &["rev-parse", "HEAD^{tree}"]), before);
        assert_eq!(sh(&r.a, &["status", "--porcelain"]), "");
        assert!(!r.a.join("data (konflikt).json").exists());

        // og næste synk kommer igennem
        assert_eq!(r.sync().status, "ok");
        r.assert_settled();
    }

    // sti i .git-mappen, som git selv oplyser den
    fn git_dir_path(dir: &Path, name: &str) -> PathBuf {
        dir.join(sh(dir, &["rev-parse", "--git-path", name]).trim())
    }

    // en rebase, der er stoppet i en konflikt (pull uden union-filen)
    fn stopped_rebase(r: &Repos) {
        r.push_from_b(|b| write(b, "Note.md", NOTE.replace("linje et", "linje et (telefon)")));
        write(&r.a, "Note.md", NOTE.replace("linje et", "linje et (computer)"));
        sh(&r.a, &["commit", "-q", "-am", "Lokalt"]);
        let pull = git(r.a(), &["pull", "-q", "--rebase"]).unwrap();
        assert!(!pull.status.success());
        assert!(rebase_in_progress(r.a()));
    }

    // markøren, appen lægger i sin egen rebases mappe
    fn mark_as_own_rebase(dir: &Path) {
        fs::write(git_dir_path(dir, "rebase-merge/markdown-writer-sync"), "").unwrap();
    }

    fn backup_refs(dir: &Path) -> String {
        sh(dir, &["for-each-ref", "refs/markdown-writer/"])
    }

    // (h) en rebase, appen selv har efterladt halvfærdig (fx lukket midt i en synk)
    #[test]
    fn efterladt_rebase_blokerer_ikke() {
        let r = setup();
        stopped_rebase(&r);
        mark_as_own_rebase(&r.a);

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        let merged = read(&r.a, "Note.md");
        assert!(merged.contains("linje et (telefon)") && merged.contains("linje et (computer)"));
        assert!(!merged.contains("<<<<<<<"), "{}", merged);
        assert!(!git_dir_path(&r.a, "markdown-writer-sync").exists());
        r.assert_settled();
    }

    // F2: en rebase, appen ikke selv har startet (terminal, Claude Code), røres
    // ikke: ingen add, intet commit, ingen abort
    #[test]
    fn fremmed_rebase_roeres_ikke() {
        let r = setup();
        stopped_rebase(&r);
        // brugeren skriver videre i appen imens
        write(&r.a, "Anden.md", "Anden note\nskrevet under rebasen\n");
        let head = sh(&r.a, &["rev-parse", "HEAD"]);
        let status = sh(&r.a, &["status", "--porcelain"]);
        let remote = sh(&r.remote, &["rev-parse", "main"]);
        let check = |res: GitSyncResult| {
            assert_eq!(res.status, "conflict", "{:?}", res);
            assert_eq!(
                res.detail,
                "En rebase er i gang i vaulten – gør den færdig i terminalen"
            );
            assert_eq!(res.committed, 0);
            assert!(rebase_in_progress(r.a()));
            assert_eq!(sh(&r.a, &["rev-parse", "HEAD"]), head);
            assert_eq!(sh(&r.a, &["status", "--porcelain"]), status);
            assert_eq!(read(&r.a, "Anden.md"), "Anden note\nskrevet under rebasen\n");
            assert_eq!(sh(&r.remote, &["rev-parse", "main"]), remote);
        };
        check(r.sync());

        // en gammel markør fra en anden synk gør den ikke til appens egen
        fs::write(git_dir_path(&r.a, "markdown-writer-sync"), &head).unwrap();
        check(r.sync());
    }

    // ligesom en fremmed merge, der venter på konfliktløsning
    #[test]
    fn fremmed_merge_roeres_ikke() {
        let r = setup();
        r.push_from_b(|b| write(b, "data.json", DATA.replace("blå", "grøn")));
        write(&r.a, "data.json", DATA.replace("blå", "rød"));
        sh(&r.a, &["commit", "-q", "-am", "Lokalt"]);
        let pull = git(r.a(), &["pull", "-q", "--no-rebase"]).unwrap();
        assert!(!pull.status.success());
        let status = sh(&r.a, &["status", "--porcelain"]);
        let remote = sh(&r.remote, &["rev-parse", "main"]);

        let res = r.sync();
        assert_eq!(res.status, "conflict", "{:?}", res);
        assert_eq!(
            res.detail,
            "En merge er i gang i vaulten – gør den færdig i terminalen"
        );
        assert_eq!(sh(&r.a, &["status", "--porcelain"]), status);
        assert!(read(&r.a, "data.json").contains("<<<<<<<"));
        assert_eq!(sh(&r.remote, &["rev-parse", "main"]), remote);
    }

    // F2: appens egen efterladte rebase afbrydes, men det, der er gemt i
    // vaulten imens, overlever aborten og kommer med i synken
    #[test]
    fn egen_rebase_afbrydes_uden_tab() {
        let r = setup();
        stopped_rebase(&r);
        mark_as_own_rebase(&r.a);
        let mine = "Anden note\nskrevet under rebasen\n";
        write(&r.a, "Anden.md", mine);
        fs::remove_file(r.a.join("andet.json")).unwrap();
        write(&r.a, "Mappe/Ny.md", "Ny note\n");
        // staget under rebasen og slettet igen: findes hverken i HEAD eller på disken
        write(&r.a, "Staget.md", "kortlivet\n");
        sh(&r.a, &["add", "Staget.md"]);
        fs::remove_file(r.a.join("Staget.md")).unwrap();

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(read(&r.a, "Anden.md"), mine);
        assert_eq!(r.remote_file("Anden.md").unwrap(), mine);
        assert!(!r.a.join("andet.json").exists());
        assert_eq!(r.remote_file("andet.json"), None);
        assert_eq!(r.remote_file("Mappe/Ny.md").unwrap(), "Ny note\n");
        assert!(!r.a.join("Staget.md").exists());
        assert_eq!(r.remote_file("Staget.md"), None);
        let merged = read(&r.a, "Note.md");
        assert!(merged.contains("linje et (telefon)") && merged.contains("linje et (computer)"));
        // sikkerhedskopien er ryddet op, da alt kom tilbage
        assert_eq!(backup_refs(&r.a), "");
        r.assert_settled();
    }

    // F2: må appen opgive sin egen rebase, overlever det, appen har gemt midt
    // i den (her skriver en hook, mens rebasen kører)
    #[test]
    fn opgivet_rebase_bevarer_det_gemte() {
        let r = setup();
        two_conflicting_local_commits(&r);
        let hook = r.a.join(".git/hooks/post-checkout");
        write(
            &r.a,
            ".git/hooks/post-checkout",
            "#!/bin/sh\n[ -e .git/gemt ] && exit 0\ntouch .git/gemt\n\
             printf 'Anden note\\ngemt under rebasen\\n' > Anden.md\n",
        );
        std::process::Command::new("chmod").arg("+x").arg(&hook).status().unwrap();
        let tree = sh(&r.a, &["rev-parse", "HEAD^{tree}"]);

        let res = sync_repo_rounds(r.a(), &r.attrs, 0).unwrap();
        assert_eq!(res.status, "conflict", "{:?}", res);
        assert!(r.a.join(".git/gemt").exists(), "hooken kørte ikke");
        assert!(!rebase_in_progress(r.a()));
        assert_eq!(sh(&r.a, &["rev-parse", "HEAD^{tree}"]), tree);
        assert_eq!(read(&r.a, "Anden.md"), "Anden note\ngemt under rebasen\n");
        assert_eq!(backup_refs(&r.a), "");

        assert_eq!(r.sync().status, "ok");
        assert_eq!(
            r.remote_file("Anden.md").unwrap(),
            "Anden note\ngemt under rebasen\n"
        );
        r.assert_settled();
    }

    // to synk uden net: ét lokalt commit pr. version af Note.md
    fn offline_commits(r: &Repos, versions: &[String]) {
        let url = sh(&r.a, &["remote", "get-url", "origin"]);
        sh(&r.a, &["remote", "set-url", "origin", "/findes/ikke/remote.git"]);
        for v in versions {
            write(&r.a, "Note.md", v);
            assert_eq!(r.sync().status, "offline");
        }
        sh(&r.a, &["remote", "set-url", "origin", url.trim()]);
    }

    // F1: to lokale commits, der skriver videre på samme linje, flettes som én
    // ændring mod telefonens tilføjelse: mellemversionen genopstår ikke
    #[test]
    fn lokale_commits_genopliver_ikke_mellemversioner() {
        let r = setup();
        offline_commits(
            &r,
            &[
                format!("{}Tirsdag: skrev\n", NOTE),
                format!("{}Tirsdag: skrev rapporten færdig\n", NOTE),
            ],
        );
        r.push_from_b(|b| write(b, "Note.md", format!("{}Indkøb: mælk\n", NOTE)));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        let note = read(&r.a, "Note.md");
        assert_eq!(
            note,
            format!("{}Indkøb: mælk\nTirsdag: skrev rapporten færdig\n", NOTE)
        );
        assert_eq!(r.remote_file("Note.md").unwrap(), note);
        // ét samlet commit oven på telefonens
        assert_eq!(sh(&r.a, &["rev-list", "--count", "HEAD"]).trim(), "3");
        assert_eq!(sh(&r.a, &["log", "-1", "--format=%s"]).trim(), "Noter: Note");
        r.assert_settled();
    }

    // går de lokale ændringer lige op, er der intet at samle eller pushe
    #[test]
    fn lokale_commits_der_gaar_lige_op() {
        let r = setup();
        offline_commits(&r, &[format!("{}midlertidig\n", NOTE), NOTE.to_string()]);
        r.push_from_b(|b| write(b, "Note.md", format!("{}Indkøb: mælk\n", NOTE)));

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(read(&r.a, "Note.md"), format!("{}Indkøb: mælk\n", NOTE));
        r.assert_settled();
    }

    // uden nyt fra telefonen pushes de lokale commits, som de er
    #[test]
    fn lokale_commits_uden_nyt_upstream_bevares() {
        let r = setup();
        offline_commits(
            &r,
            &[format!("{}første\n", NOTE), format!("{}første\nanden\n", NOTE)],
        );
        let head = sh(&r.a, &["rev-parse", "HEAD"]);

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(sh(&r.remote, &["rev-parse", "main"]), head);
        r.assert_settled();
    }

    // (f) remote utilgængelig → offline, og ingen halv rebase
    #[test]
    fn utilgaengelig_remote_er_offline() {
        let r = setup();
        sh(&r.a, &["remote", "set-url", "origin", "/findes/ikke/remote.git"]);
        write(&r.a, "Note.md", format!("{}ny linje\n", NOTE));

        let res = r.sync();
        assert_eq!(res.status, "offline", "{:?}", res);
        assert_eq!(res.committed, 1);
        assert!(!rebase_in_progress(r.a()));
    }

    // (g) æøå i filnavne må ikke blive til oktal-escapes i commit-beskeden
    #[test]
    fn commitbesked_med_aeoeaa() {
        let r = setup();
        write(&r.a, "Møde med Åse om æbler.md", "Referat\n");

        let res = r.sync();
        assert_eq!(res.status, "ok", "{:?}", res);
        assert_eq!(res.committed, 1);
        assert_eq!(
            sh(&r.a, &["log", "-1", "--format=%s"]).trim(),
            "Noter: Møde med Åse om æbler"
        );
        r.assert_settled();
    }
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

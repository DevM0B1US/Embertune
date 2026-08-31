use crate::db::{Db, NewTrack};
use crate::probe_duration;
use crate::settings::SettingsStore;
use crate::util::{is_audio_file, split_title, unix_now};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use std::process::Stdio;

mod parsers;
use parsers::*;

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Youtube,
    Spotify,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Downloading,
    Completed,
    Cancelled,
    Error,
}

#[derive(Clone, Serialize)]
pub struct JobView {
    pub id: u64,
    pub url: String,
    pub kind: JobKind,
    pub status: JobStatus,
    pub title: String,
    pub percent: f64,
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
    pub skipped: bool,
}

#[derive(Clone)]
struct Job {
    id: u64,
    url: String,
    kind: JobKind,
    status: JobStatus,
    title: String,
    percent: f64,
    downloaded: u64,
    total: u64,
    error: Option<String>,
    skipped: bool,
}

impl Job {
    fn view(&self) -> JobView {
        JobView {
            id: self.id,
            url: self.url.clone(),
            kind: self.kind,
            status: self.status,
            title: self.title.clone(),
            percent: self.percent,
            downloaded: self.downloaded,
            total: self.total,
            error: self.error.clone(),
            skipped: self.skipped,
        }
    }
}

pub struct DownloadManager {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<DownloadState>,
    procs: Mutex<HashMap<u64, Child>>,
    active: tokio::sync::Semaphore,
    next_id: AtomicU64,
    app: AppHandle,
    db: Arc<Db>,
    settings: Arc<SettingsStore>,
}

struct DownloadState {
    jobs: HashMap<u64, Job>,
    order: Vec<u64>,
}

impl DownloadManager {
    pub fn new(app: AppHandle, db: Arc<Db>, settings: Arc<SettingsStore>) -> Self {
        DownloadManager {
            inner: Arc::new(Inner {
                state: Mutex::new(DownloadState {
                    jobs: HashMap::new(),
                    order: Vec::new(),
                }),
                procs: Mutex::new(HashMap::new()),
                active: tokio::sync::Semaphore::new(1),
                next_id: AtomicU64::new(1),
                app,
                db,
                settings,
            }),
        }
    }

    pub fn add(&self, url: String) -> u64 {
        let kind = kind_of(&url);
        let inner = self.inner.clone();
        let id = push_job(&inner, url, kind);
        let inner2 = inner.clone();
        tauri::async_runtime::spawn(async move {
            run_job(inner2, id).await;
        });
        id
    }

    /// Cancel a job by id. No webview surface yet (audit Q6: the command was
    /// dead — no cancel button exists); kept for the future cancel UI, and
    /// the proc-kill path here mirrors run_job's internal cancellation.
    #[allow(dead_code)]
    pub fn cancel(&self, id: u64) {
        {
            let mut procs = self.inner.procs.lock().unwrap();
            if let Some(mut child) = procs.remove(&id) {
                let _ = child.start_kill();
            }
        }
        {
            let mut st = self.inner.state.lock().unwrap();
            if let Some(job) = st.jobs.get_mut(&id) {
                if job.status == JobStatus::Queued || job.status == JobStatus::Downloading {
                    job.status = JobStatus::Cancelled;
                    job.error = Some("cancelled by user".into());
                }
            }
        }
        emit_job(&self.inner, id);
    }

    pub fn list(&self) -> Vec<JobView> {
        let st = self.inner.state.lock().unwrap();
        let active = [JobStatus::Queued, JobStatus::Downloading];
        st.order
            .iter()
            .filter_map(|id| st.jobs.get(id).map(|j| j.view()))
            .filter(|v| active.contains(&v.status))
            .collect()
    }

    /// Drop finished/errored jobs from the map. No webview surface yet
    /// (audit Q6); kept for the future "clear" UI.
    #[allow(dead_code)]
    pub fn clear_finished(&self) {
        let mut st = self.inner.state.lock().unwrap();
        let active = [JobStatus::Queued, JobStatus::Downloading];
        let dead: Vec<u64> = st
            .order
            .iter()
            .copied()
            .filter(|id| {
                st.jobs
                    .get(id)
                    .map(|j| !active.contains(&j.status))
                    .unwrap_or(true)
            })
            .collect();
        for id in &dead {
            st.jobs.remove(id);
        }
        st.order.retain(|id| !dead.contains(id));
    }
}

fn push_job(inner: &Arc<Inner>, url: String, kind: JobKind) -> u64 {
    let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
    {
        let mut st = inner.state.lock().unwrap();
        st.jobs.insert(
            id,
            Job {
                id,
                url: url.clone(),
                kind,
                status: JobStatus::Queued,
                title: String::new(),
                percent: 0.0,
                downloaded: 0,
                total: 0,
                error: None,
                skipped: false,
            },
        );
        st.order.push(id);
    }
    id
}

fn is_spotify_url(url: &str) -> bool {
    url.contains("open.spotify.com") || url.starts_with("spotify:")
}

fn kind_of(url: &str) -> JobKind {
    if is_spotify_url(url) {
        JobKind::Spotify
    } else {
        JobKind::Youtube
    }
}

async fn run_job(inner: Arc<Inner>, id: u64) {
    let _permit = match inner.active.acquire().await {
        Ok(p) => p,
        Err(_) => return,
    };

    {
        let mut _st = inner.state.lock().unwrap();
        let jobs = &mut _st.jobs;
        let cancelled = jobs
            .get(&id)
            .map(|j| j.status == JobStatus::Cancelled)
            .unwrap_or(true);
        if cancelled {
            return;
        }
        if let Some(j) = jobs.get_mut(&id) {
            j.status = JobStatus::Downloading;
        }
    }
    emit_job(&inner, id);

    let job = inner.state.lock().unwrap().jobs.get(&id).cloned();
    let job = match job {
        Some(j) => j,
        None => return,
    };

    let guard = tokio::time::timeout(std::time::Duration::from_secs(3600), async {
        match job.kind {
            JobKind::Youtube => run_ytdlp(&inner, &job).await,
            JobKind::Spotify => run_spotdl(&inner, &job).await,
        }
    })
    .await;

    if guard.is_err() {
        if let Some(mut c) = inner.procs.lock().unwrap().remove(&id) {
            let _ = c.start_kill();
        }
        set_job_error(&inner, id, "timed out after 1 hour".into());
        emit_job(&inner, id);
    }
}

async fn run_ytdlp(inner: &Inner, job: &Job) {
    let id = job.id;
    let out = inner.settings.get().resolved_download_dir();
    let url = job.url.clone();
    if let Err(e) = std::fs::create_dir_all(&out) {
        set_job_error(inner, id, format!("could not create download dir: {e}"));
        return;
    }

    let mut args: Vec<String> = Vec::new();
    args.push("--newline".into());
    args.push("--progress".into());
    args.push("--ignore-errors".into());
    if let Some(rt) = js_runtime() {
        args.push("--js-runtimes".into());
        args.push(rt);
    }
    args.push("--remote-components".into());
    args.push("ejs:github".into());
    args.push("--extractor-args".into());
    args.push("youtube:player_client=web_embedded".into());
    args.push("--progress-template".into());
    args.push("download:dl:%(progress.downloaded_bytes)s/%(progress.total_bytes)s|%(info.title)s".into());
    args.push("--print".into());
    args.push("TITLE:%(title)s".into());
    args.push("--print".into());
    args.push("after_move:FILEPATH:%(filepath)s".into());
    args.push("-f".into());
    args.push("bestaudio[ext=m4a]/bestaudio/best".into());
    args.push("--embed-thumbnail".into());
    if let Some(q) = match inner.settings.get().quality.as_str() {
        "mp3_192" => Some("192"),
        "mp3_320" => Some("320"),
        _ => None,
    } {
        args.push("--audio-format".into());
        args.push("mp3".into());
        args.push("--audio-quality".into());
        args.push(q.into());
    }
    args.push("--retries".into());
    args.push("10".into());
    args.push("--fragment-retries".into());
    args.push("10".into());
    args.push("--file-access-retries".into());
    args.push("10".into());
    args.push("--retry-sleep".into());
    args.push("5".into());
    args.push("--socket-timeout".into());
    args.push("30".into());
    args.push("--http-chunk-size".into());
    args.push("5M".into());
    args.push("--concurrent-fragments".into());
    args.push("3".into());
    args.push("-o".into());
    args.push(format!("{}/%(title)s.%(ext)s", out.display()));
    args.push(url.clone());

    let mut child = match Command::new("yt-dlp").args(&args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
    {
        Ok(c) => c,
        Err(e) => {
            set_job_error(inner, id, format!("could not start yt-dlp: {e}"));
            return;
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    inner.procs.lock().unwrap().insert(id, child);

    let err_task = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if buf.len() < 8000 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    let mut paths: Vec<String> = Vec::new();
    let mut last_progress = std::time::Instant::now();
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(rest) = line.strip_prefix("TITLE:") {
            {
                let mut _st = inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.title = rest.to_string();
                }
            }
            emit_job(inner, id);
        } else if let Some(rest) = line.strip_prefix("dl:") {
            let (nums, title) = rest.split_once('|').unwrap_or((rest, ""));
            let (a, b) = nums.split_once('/').unwrap_or(("0", "0"));
            let downloaded = a.parse::<u64>().unwrap_or(0);
            let total = b.parse::<u64>().unwrap_or(0);
            let percent = if total > 0 {
                downloaded as f64 / total as f64 * 100.0
            } else {
                -1.0
            };
            {
                let mut _st = inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.downloaded = downloaded;
                    j.total = total;
                    j.percent = percent;
                    if !title.is_empty() {
                        j.title = title.to_string();
                    }
                }
            }
            if last_progress.elapsed() > std::time::Duration::from_millis(120) {
                emit_job(inner, id);
                last_progress = std::time::Instant::now();
            }
        } else if let Some(p) = line.strip_prefix("FILEPATH:") {
            paths.push(p.to_string());
        } else if ytdlp_skipped(&line) {
            {
                let mut _st = inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.skipped = true;
                }
            }
            emit_job(inner, id);
        }
    }

    let status = {
        let child = {
            let mut procs = inner.procs.lock().unwrap();
            procs.remove(&id)
        };
        match child {
            Some(mut c) => Some(c.wait().await),
            None => None,
        }
    };
    let err_text = err_task.await.unwrap_or_default();

    let was_cancelled = {
        inner
            .state
            .lock()
            .unwrap()
            .jobs
            .get(&id)
            .map(|j| j.status == JobStatus::Cancelled)
            .unwrap_or(false)
    };

    if was_cancelled {
        if !has_active_jobs(inner) {
            sweep_partials(&out);
        }
        emit_job(inner, id);
        return;
    }

    match status {
        Some(Ok(st)) if st.success() => {
            let now = unix_now();
            let mut added = 0usize;
            for p in &paths {
                if let Ok(Some(_existing)) = inner.db.track_id_by_path(p) {
                    continue;
                }
                let (artist, title) = split_artist_title(&file_stem(p));
                let nt = NewTrack {
                    title,
                    artist,
                    album: String::new(),
                    duration: probe_duration(p),
                    path: p.clone(),
                    source_url: url.clone(),
                    source: "youtube".into(),
                    added_at: now,
                };
                if let Ok(_tid) = inner.db.add_track(&nt) {
                    crate::art::extract_cover(p);
                    added += 1;
                }
            }
            {
                let mut _st = inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.percent = 100.0;
                    if j.title.is_empty() && added > 0 {
                        j.title = format!("{added} track(s) downloaded");
                    }
                }
            }
            let _ = inner.app.emit("library-changed", added);
            organize_lyrics(out.as_path());
        }
        _ => {
            if !has_active_jobs(inner) {
                sweep_partials(&out);
            }
            set_job_error(inner, id, tail(&err_text, 400));
        }
    }
    emit_job(inner, id);
}

async fn run_spotdl(inner: &Arc<Inner>, job: &Job) {
    let id = job.id;
    let out = inner.settings.get().resolved_download_dir();
    let url = job.url.clone();
    if let Err(e) = std::fs::create_dir_all(&out) {
        set_job_error(inner, id, format!("could not create download dir: {e}"));
        return;
    }
    let settings = inner.settings.get();
    let before: HashSet<String> = dir_snapshot(out.as_path());
    let temp = spotdl_temp_dir();
    let temp_before: Option<HashSet<String>> = temp.as_deref().map(|t| dir_snapshot(t));

    let mut cmd = Command::new(match find_spotdl() {
        Some(p) => p,
        None => {
            set_job_error(
                inner,
                id,
                "spotdl not found — install it (pipx install spotdl or pip install spotdl)".into(),
            );
            return;
        }
    });
    cmd.arg(&url)
        .arg("--output")
        .arg(format!("{}/{{artists}} - {{title}}.{{output-ext}}", out.display()));
    match inner.settings.get().quality.as_str() {
        "mp3_192" => {
            cmd.arg("--format").arg("mp3").arg("--bitrate").arg("192K");
        }
        "mp3_320" => {
            cmd.arg("--format").arg("mp3").arg("--bitrate").arg("320K");
        }
        _ => {
            cmd.arg("--format").arg("m4a").arg("--bitrate").arg("auto");
        }
    }
    cmd.arg("--threads")
        .arg("4")
        .arg("--print-errors")
        .arg("--simple-tui")
        .arg("--lyrics")
        .arg("genius")
        .arg("musixmatch")
        .arg("azlyrics")
        .arg("synced")
        .arg("--generate-lrc")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ydlp_args =
        String::from("--extractor-args youtube:player_client=web_embedded --remote-components ejs:github");
    if let Some(rt) = js_runtime() {
        ydlp_args = format!("--js-runtimes {rt} {ydlp_args}");
    }
    cmd.arg("--yt-dlp-args").arg(ydlp_args);
    if let (Some(cid), Some(csec)) = (
        settings.spotify_client_id.clone(),
        settings.spotify_client_secret.clone(),
    ) {
        cmd.env("SPOTIFY_CLIENT_ID", cid)
            .env("SPOTIFY_CLIENT_SECRET", csec);
    }
    cmd.env("PYTHONUNBUFFERED", "1");

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            set_job_error(
                inner,
                id,
                format!("could not start spotdl: {e} (install it: pip install spotdl)"),
            );
            return;
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    inner.procs.lock().unwrap().insert(id, child);

    let err_task = tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if buf.len() < 8000 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    {
        let mut _st = inner.state.lock().unwrap();
        let jobs = &mut _st.jobs;
        if let Some(j) = jobs.get_mut(&id) {
            if j.title.is_empty() {
                j.title = "Spotify — working…".into();
            }
            j.percent = -1.0;
        }
    }
    emit_job(inner, id);

    let mon_inner = inner.clone();
    let mon_out = out.clone();
    let mon_before = before.clone();
    let mon_temp = temp.clone();
    let mon_temp_before = temp_before.clone();
    let mon_id = id;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let (bytes, name) = spotdl_work(
                mon_out.as_path(),
                mon_temp.as_deref(),
                mon_temp_before.as_ref(),
                &mon_before,
            );
            let stop = {
                let mut _st = mon_inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                let Some(j) = jobs.get_mut(&mon_id) else {
                    return;
                };
                if j.status != JobStatus::Downloading {
                    true
                } else {
                    if bytes > 0 {
                        j.downloaded = bytes;
                    }
                    if let Some(n) = name {
                        if j.title.is_empty() || j.title == "Spotify — working…" {
                            j.title = n;
                        }
                    }
                    false
                }
            };
            if stop {
                return;
            }
            emit_job(&mon_inner, mon_id);
        }
    });

    let mut raw = String::new();
    let mut last_emit = std::time::Instant::now();
    let mut pout = stdout;
    loop {
        let mut chunk = vec![0u8; 8192];
        match tokio::io::AsyncReadExt::read(&mut pout, &mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                raw.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if raw.len() > 32768 {
                    raw = raw.split_off(raw.len() - 32768);
                }
                let pct = last_percent(&raw).or_else(|| spotdl_phase_percent(&raw));
                let file = last_dl_file(&raw);
                let song = spotdl_song_name(&raw);
                let sk = spotdl_skipped(&raw);
                {
                    let mut _st = inner.state.lock().unwrap();
                    let jobs = &mut _st.jobs;
                    if let Some(j) = jobs.get_mut(&id) {
                        if let Some(p) = pct {
                            j.percent = p;
                        }
                        if let Some(s) = song {
                            j.title = s;
                        } else if let Some(f) = file {
                            j.title = f;
                        }
                        if sk {
                            j.skipped = true;
                        }
                        let (b, _) = spotdl_work(out.as_path(), temp.as_deref(), temp_before.as_ref(), &before);
                        if b > 0 {
                            j.downloaded = b;
                        }
                    }
                }
                if last_emit.elapsed() > std::time::Duration::from_millis(250) {
                    emit_job(inner, id);
                    last_emit = std::time::Instant::now();
                }
            }
            Err(_) => break,
        }
    }
    emit_job(inner, id);

    let status = {
        let child = {
            let mut procs = inner.procs.lock().unwrap();
            procs.remove(&id)
        };
        match child {
            Some(mut c) => Some(c.wait().await),
            None => None,
        }
    };
    let err_text = err_task.await.unwrap_or_default();

    let was_cancelled = {
        inner
            .state
            .lock()
            .unwrap()
            .jobs
            .get(&id)
            .map(|j| j.status == JobStatus::Cancelled)
            .unwrap_or(false)
    };
    if was_cancelled {
        if !has_active_jobs(inner) {
            sweep_partials(&out);
        }
        emit_job(inner, id);
        return;
    }

    match status {
        Some(Ok(st)) if st.success() => {
            let now = unix_now();
            let mut added = 0usize;
            for p in dir_diff(out.as_path(), &before) {
                if let Ok(Some(_existing)) = inner.db.track_id_by_path(&p) {
                    continue;
                }
                let (artist, title) = split_artist_title(&file_stem(&p));
                let nt = NewTrack {
                    title,
                    artist,
                    album: String::new(),
                    duration: probe_duration(&p),
                    path: p.clone(),
                    source_url: url.clone(),
                    source: "spotify".into(),
                    added_at: now,
                };
                if let Ok(_tid) = inner.db.add_track(&nt) {
                    crate::art::extract_cover(&p);
                    added += 1;
                }
            }
            {
                let mut _st = inner.state.lock().unwrap();
                let jobs = &mut _st.jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.percent = 100.0;
                    if added == 0 {
                        j.skipped = true;
                        if j.title.is_empty() || j.title == "Spotify — working…" {
                            j.title = "Already downloaded".into();
                        }
                    } else if j.title.is_empty() || j.title == "Spotify — working…" {
                        j.title = format!("{added} track(s) downloaded");
                    }
                }
            }
            let _ = inner.app.emit("library-changed", added);
            organize_lyrics(out.as_path());
        }
        _ => {
            if !has_active_jobs(inner) {
                sweep_partials(&out);
            }
            let msg = tail(&err_text, 500);
            let hint = if settings.spotify_client_id.is_none() {
                " | if this is a Spotify auth error, run 'spotdl' once in a terminal to configure its API credentials"
            } else {
                ""
            };
            set_job_error(inner, id, format!("{msg}{hint}"));
        }
    }
    emit_job(inner, id);
}

fn set_job_error(inner: &Inner, id: u64, msg: String) {
    let mut _st = inner.state.lock().unwrap();
    let jobs = &mut _st.jobs;
    if let Some(j) = jobs.get_mut(&id) {
        if j.status != JobStatus::Cancelled {
            j.status = JobStatus::Error;
            j.error = Some(msg);
        }
    }
    emit_job(inner, id);
}

fn emit_job(inner: &Inner, id: u64) {
    let view = inner.state.lock().unwrap().jobs.get(&id).map(|j| j.view());
    if let Some(v) = view {
        let _ = inner.app.emit("download-progress", &v);
    }
}

fn dir_snapshot(dir: &std::path::Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            set.insert(e.path().to_string_lossy().to_string());
        }
    }
    set
}

pub(crate) fn organize_lyrics(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut moved = 0u32;
    for e in rd.flatten() {
        let path = e.path();
        if !e.metadata().map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".lrc") && !name.ends_with(".lrclib") {
            let sub = dir.join("Lyrics");
            if std::fs::create_dir_all(&sub).is_ok() {
                if std::fs::rename(&path, sub.join(&name)).is_ok() {
                    moved += 1;
                }
            }
        }
    }
    if moved > 0 {
        eprintln!("organize_lyrics: moved {moved} .lrc file(s) into Lyrics/");
    }
}

fn dir_diff(dir: &std::path::Path, before: &HashSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let s = p.to_string_lossy().to_string();
            if !before.contains(&s) && p.is_file() && is_audio(&e.file_name().to_string_lossy()) {
                out.push(s);
            }
        }
    }
    out
}

fn is_audio(name: &str) -> bool {
    // shared implementation lives in crate::util (audit Q7)
    is_audio_file(name)
}

fn spotdl_temp_dir() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    for base in [home.join(".config/spotdl"), home.join(".spotdl")] {
        let t = base.join("temp");
        if t.is_dir() {
            return Some(t);
        }
    }
    None
}

fn spotdl_work(
    out: &std::path::Path,
    temp: Option<&std::path::Path>,
    temp_before: Option<&HashSet<String>>,
    before: &HashSet<String>,
) -> (u64, Option<String>) {
    let mut sum: u64 = 0;
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(10))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    if let Some(tdir) = temp {
        if let Ok(rd) = std::fs::read_dir(tdir) {
            for e in rd.flatten() {
                let path = e.path();
                if temp_before
                    .map(|tb| tb.contains(&path.to_string_lossy().to_string()))
                    .unwrap_or(false)
                {
                    continue;
                }
                if !e.metadata().map(|m| m.is_file()).unwrap_or(false) {
                    continue;
                }
                sum += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    let mut newest_audio: Option<(std::time::SystemTime, String)> = None;
    if let Ok(rd) = std::fs::read_dir(out) {
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if before.contains(&path.to_string_lossy().to_string()) {
                continue;
            }
            let mtime = e.metadata().ok().and_then(|m| m.modified().ok());
            if is_audio(&name) {
                if let Some(t) = mtime {
                    if t >= cutoff && newest_audio.as_ref().map(|(nt, _)| t > *nt).unwrap_or(true) {
                        newest_audio = Some((t, name.clone()));
                    }
                    if t >= cutoff {
                        sum += e.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
        }
    }
    (sum, newest_audio.map(|(_, n)| clean_song_name(&n)))
}

#[cfg(test)]
fn current_work(
    dir: &std::path::Path,
    before: &std::collections::HashSet<String>,
) -> (u64, Option<String>) {
    let mut sum: u64 = 0;
    let mut newest_part: Option<(std::time::SystemTime, String)> = None;
    let mut newest_audio: Option<(std::time::SystemTime, String)> = None;
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(10))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if before.contains(&path.to_string_lossy().to_string()) {
                continue;
            }
            let mtime = e.metadata().ok().and_then(|m| m.modified().ok());
            if is_partial(&name) {
                sum += e.metadata().map(|m| m.len()).unwrap_or(0);
                if let Some(t) = mtime {
                    if newest_part.as_ref().map(|(nt, _)| t > *nt).unwrap_or(true) {
                        newest_part = Some((t, name.clone()));
                    }
                }
            } else if is_audio(&name) {
                if let Some(t) = mtime {
                    if t >= cutoff && newest_audio.as_ref().map(|(nt, _)| t > *nt).unwrap_or(true) {
                        newest_audio = Some((t, name.clone()));
                    }
                }
            }
        }
    }
    let name = match (newest_part, newest_audio) {
        (Some((_, n)), _) => Some(clean_song_name(&n)),
        (None, Some((_, n))) => Some(clean_song_name(&n)),
        _ => None,
    };
    (sum, name)
}

fn clean_song_name(name: &str) -> String {
    let mut n = name.to_string();
    for suf in [".part-Frag", ".part", ".ytdl"] {
        if let Some(i) = n.find(suf) {
            n.truncate(i);
            break;
        }
    }
    if let Some(e) = n.rfind('.') {
        n.truncate(e);
    }
    n.trim().to_string()
}

fn is_partial(name: &str) -> bool {
    name.ends_with(".part") || name.contains(".part-Frag") || name.ends_with(".ytdl")
}

fn sweep_partials(dir: &std::path::Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && is_partial(&e.file_name().to_string_lossy()) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

pub fn sweep_orphaned_partials(dir: &std::path::Path) {
    sweep_partials(dir);
}

fn has_active_jobs(inner: &Inner) -> bool {
    inner
        .state
        .lock()
        .unwrap()
        .jobs
        .values()
        .any(|j| matches!(j.status, JobStatus::Queued | JobStatus::Downloading))
}

fn find_spotdl() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if !home.is_empty() {
        candidates.push(std::path::Path::new(&home).join(".local/bin/spotdl"));
        candidates.push(std::path::Path::new(&home).join(".cargo/bin/spotdl"));
        candidates.push(std::path::Path::new(&home).join(".pipx/venvs/spotdl/bin/spotdl"));
    }
    for p in ["/usr/local/bin/spotdl", "/usr/bin/spotdl", "/bin/spotdl"] {
        candidates.push(std::path::PathBuf::from(p));
    }
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    std::process::Command::new("which")
        .arg("spotdl")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string().into())
            } else {
                None
            }
        })
}

fn js_runtime() -> Option<String> {
    for name in ["node", "deno", "bun"] {
        let probe = std::process::Command::new(name)
            .arg("--version")
            .output();
        if matches!(probe, Ok(o) if o.status.success()) {
            return Some(name.to_string());
        }
    }
    None
}

fn file_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn split_artist_title(stem: &str) -> (String, String) {
    // shared implementation lives in crate::util (audit Q8)
    split_title(stem)
}

fn tail(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let start = s.char_indices().nth(s.chars().count() - max).map(|(i, _)| i);
        match start {
            Some(i) => format!("…{}", &s[i..]),
            None => s.to_string(),
        }
    }
}

// unix_now() comes from crate::util (audit Q9 — one shared definition)

#[cfg(test)]
mod work_tests {
    use super::*;

    fn snapshot(dir: &std::path::Path) -> HashSet<String> {
        dir_snapshot(dir)
    }

    #[test]
    fn current_work_detects_partial_download() {
        let dir = std::env::temp_dir().join("ewt-partial-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let before = snapshot(&dir);
        let p = dir.join("Rick Astley - Never Gonna Give You Up.m4a.part");
        std::fs::write(&p, vec![0u8; 4096]).unwrap();
        let (bytes, name) = current_work(&dir, &before);
        assert_eq!(bytes, 4096);
        assert_eq!(name.as_deref(), Some("Rick Astley - Never Gonna Give You Up"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn current_work_ignores_pre_existing_files() {
        let dir = std::env::temp_dir().join("ewt-preexisting-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("old.mp3");
        std::fs::write(&p, vec![0u8; 512]).unwrap();
        let before = snapshot(&dir);
        let (bytes, name) = current_work(&dir, &before);
        assert_eq!(bytes, 0);
        assert_eq!(name, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_song_name_strips_part_and_extension() {
        assert_eq!(clean_song_name("Artist - Title.m4a.part"), "Artist - Title");
        assert_eq!(clean_song_name("Artist - Title.mp3.part-Frag1"), "Artist - Title");
        assert_eq!(clean_song_name("Artist - Title.flac"), "Artist - Title");
    }

    #[test]
    fn spotdl_work_sums_temp_partials_and_names_newest_audio() {
        let tmp = std::env::temp_dir().join("ewt-spotdl-work-test");
        let _ = std::fs::remove_dir_all(&tmp);
        let out = tmp.join("out");
        let temp = tmp.join("temp");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&temp).unwrap();
        let out_before = snapshot(&out);
        let temp_before = snapshot(&temp);
        std::fs::write(temp.join("abc123.m4a.part"), vec![0u8; 8192]).unwrap();
        let song = out.join("Artist - Song.m4a");
        std::fs::write(&song, vec![0u8; 4096]).unwrap();
        let (bytes, name) = spotdl_work(&out, Some(&temp), Some(&temp_before), &out_before);
        assert_eq!(bytes, 12288);
        assert_eq!(name.as_deref(), Some("Artist - Song"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn spotdl_work_ignores_pre_existing_temp_files() {
        let tmp = std::env::temp_dir().join("ewt-spotdl-temp-before-test");
        let _ = std::fs::remove_dir_all(&tmp);
        let out = tmp.join("out");
        let temp = tmp.join("temp");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(temp.join("stale.m4a.part"), vec![0u8; 1024]).unwrap();
        let temp_before = snapshot(&temp);
        let (bytes, _) = spotdl_work(&out, Some(&temp), Some(&temp_before), &snapshot(&out));
        assert_eq!(bytes, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

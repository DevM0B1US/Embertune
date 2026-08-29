use crate::db::{Db, NewTrack};
use crate::probe_duration;
use crate::settings::SettingsStore;
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
    Playlist,
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
    /// Track already existed on disk (or in the library) — nothing was
    /// downloaded, the UI should show it as skipped rather than done.
    pub skipped: bool,
    /// Set on track jobs spawned from a playlist download; the playlist's own
    /// job id. The frontend groups tracks by this to build the playlist panel.
    pub group_id: Option<u64>,
    /// Playlist metadata only on the playlist's own job (kind == Playlist):
    /// resolved playlist name and total track count.
    pub group_name: String,
    pub group_total: usize,
    /// Completed-track count for the playlist header (live on fallback
    /// whole-playlist downloads that spotdl/yt-dlp report as "X of Y").
    pub group_done: usize,
    /// How many songs spotdl skipped (already on disk) during a fallback
    /// whole-playlist download — surfaced in the group header so the user
    /// sees them instead of a silent "X/Y complete".
    pub group_skipped: usize,
    /// App playlist id the tracks are being added to (set on playlist downloads).
    pub db_playlist: Option<i64>,
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
    children: Vec<u64>,
    group_id: Option<u64>,
    group_name: String,
    group_total: usize,
    group_done: usize,
    group_skipped: usize,
    db_playlist: Option<i64>,
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
            group_id: self.group_id,
            group_name: self.group_name.clone(),
            group_total: self.group_total,
            group_done: self.group_done,
            group_skipped: self.group_skipped,
            db_playlist: self.db_playlist,
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

/// Unified state behind a single mutex — eliminates the ABBA lock-order
/// inversion between `list()` and `clear_finished()`.
struct DownloadState {
    jobs: HashMap<u64, Job>,
    order: Vec<u64>,
}

impl Inner {
    fn with_jobs<T>(&self, f: impl FnOnce(&mut HashMap<u64, Job>) -> T) -> T {
        let mut st = self.state.lock().unwrap();
        f(&mut st.jobs)
    }
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
        let kind = if is_playlist_url(&url) {
            JobKind::Playlist
        } else {
            kind_of(&url)
        };
        let inner = self.inner.clone();
        let id = push_job(&inner, url, kind);
        let inner2 = inner.clone();
        if kind == JobKind::Playlist {
            // A playlist URL gets resolved into its individual tracks first
            // (per-track download jobs with real progress), with a fallback to
            // downloading the whole playlist as one job if enumeration fails.
            tauri::async_runtime::spawn(async move {
                run_playlist(&inner2, id).await;
            });
        } else {
            tauri::async_runtime::spawn(async move {
                run_job(inner2, id).await;
            });
        }
        id
    }

    pub fn cancel(&self, id: u64) {
        // Cancelling a playlist job cancels every track it queued too.
        let children: Vec<u64> = {
            let st = self.inner.state.lock().unwrap();
            st.jobs.get(&id)
                .map(|j| j.children.clone())
                .unwrap_or_default()
        };
        for c in children {
            self.cancel(c);
        }
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
        // Surface running work, plus completed playlist headers so the
        // playlist panel survives an app restart mid-download.
        st.order
            .iter()
            .filter_map(|id| st.jobs.get(id).map(|j| j.view()))
            .filter(|v| active.contains(&v.status) || v.kind == JobKind::Playlist)
            .collect()
    }

    pub fn clear_finished(&self) {
        let mut st = self.inner.state.lock().unwrap();
        let active = [JobStatus::Queued, JobStatus::Downloading];
        st.order.retain(|id| {
            let keep = st
                .jobs
                .get(id)
                .map(|j| active.contains(&j.status))
                .unwrap_or(false);
            if !keep {
                st.jobs.remove(id);
            }
            keep
        });
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
                children: Vec::new(),
                group_id: None,
                group_name: String::new(),
                group_total: 0,
                group_done: 0,
                group_skipped: 0,
                db_playlist: None,
            },
        );
        st.order.push(id);
    }
    id
}

struct Entry {
    url: String,
    title: String,
}

const MAX_PLAYLIST_TRACKS: usize = 1000;

/// A playlist URL resolves into its individual tracks before anything is
/// downloaded: YouTube playlists are enumerated with `yt-dlp --flat-playlist`
/// and Spotify playlists through the Spotify Web API (the app already stores
/// the client credentials for spotdl). Each track becomes its own download
/// job so the UI shows real per-track progress.
async fn run_playlist(inner: &Arc<Inner>, id: u64) {
    {
        let mut jobs = inner.state.lock().unwrap().jobs;
        if let Some(j) = jobs.get_mut(&id) {
            j.status = JobStatus::Downloading;
            j.title = "Resolving playlist…".into();
        }
    }
    emit_job(inner, id);

    let url = inner
        .jobs
        .lock()
        .unwrap()
        .get(&id)
        .map(|j| j.url.clone())
        .unwrap_or_default();

    let resolved = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        resolve_entries(inner, &url),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err("playlist resolve timed out".into()),
    };

    {
        let cancelled = inner
            .jobs
            .lock()
            .unwrap()
            .get(&id)
            .map(|j| j.status == JobStatus::Cancelled)
            .unwrap_or(false);
        if cancelled {
            emit_job(inner, id);
            return;
        }
    }

    match resolved {
        Ok((_title, entries)) if entries.is_empty() => {
            set_job_error(
                inner,
                id,
                "playlist has no tracks (is it private?)".into(),
            );
        }
        Ok((title, entries)) => {
            let kind = kind_of(&url);
            let total = entries.len();
            // every downloaded track also lands in its own app playlist, so the
            // collection shows up in the Playlists menu alongside the library
            let db_playlist = inner.db.create_playlist_unique(title.clone()).ok();
            let mut child_ids: Vec<u64> = Vec::with_capacity(total);
            for e in entries {
                let child = push_job(inner, track_url(&url, &e), kind);
                {
                    let mut jobs = inner.state.lock().unwrap().jobs;
                    if let Some(j) = jobs.get_mut(&child) {
                        j.title = e.title.clone();
                        j.group_id = Some(id);
                        j.db_playlist = db_playlist;
                    }
                    if let Some(j) = jobs.get_mut(&id) {
                        j.children.push(child);
                    }
                }
                child_ids.push(child);
                let inner2 = inner.clone();
                tauri::async_runtime::spawn(async move {
                    run_job(inner2, child).await;
                });
            }
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.percent = 100.0;
                    j.title = title.clone();
                    j.group_name = title;
                    j.group_total = total;
                    j.db_playlist = db_playlist;
                }
            }
            emit_job(inner, id);
            // surface every track immediately so the panel shows the full song
            // list with the current one highlighted as it downloads
            for c in child_ids {
                emit_job(inner, c);
            }
        }
        Err(_e) => {
            // Enumeration failed (private playlist, missing creds, network…).
            // Don't give up — fall back to downloading the whole URL as one job
            // (spotdl / yt-dlp handle playlist URLs natively).
            let db_playlist = inner.db.create_playlist_unique("Playlist".into()).ok();
            let child = push_job(inner, url.clone(), kind_of(&url));
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&child) {
                    j.group_id = Some(id);
                    j.db_playlist = db_playlist;
                }
                if let Some(j) = jobs.get_mut(&id) {
                    j.children.push(child);
                    j.group_total = 1;
                }
            }
            let inner2 = inner.clone();
            tauri::async_runtime::spawn(async move {
                run_job(inner2, child).await;
            });
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.title = "Playlist — downloading as one job".into();
                    j.group_name = "Playlist".into();
                    j.group_total = 1;
                    j.db_playlist = db_playlist;
                }
            }
            emit_job(inner, id);
        }
    }
}

async fn resolve_entries(inner: &Arc<Inner>, url: &str) -> Result<(String, Vec<Entry>), String> {
    if is_spotify_playlist(url) {
        let inner = inner.clone();
        let url = url.to_string();
        tauri::async_runtime::spawn_blocking(move || resolve_spotify_playlist(&inner, &url))
            .await
            .map_err(|e| e.to_string())?
    } else {
        resolve_ytdlp_playlist(url).await
    }
}

async fn resolve_ytdlp_playlist(url: &str) -> Result<(String, Vec<Entry>), String> {
    let mut args: Vec<String> = vec![
        "--flat-playlist".into(),
        "-J".into(),
        "--no-warnings".into(),
        "--ignore-errors".into(),
    ];
    // Same youtube handling as the download path: JS runtime for challenge
    // solving plus the web_embedded client to dodge 403s.
    if let Some(rt) = js_runtime() {
        args.push("--js-runtimes".into());
        args.push(rt);
    }
    args.push("--remote-components".into());
    args.push("ejs:github".into());
    args.push("--extractor-args".into());
    args.push("youtube:player_client=web_embedded".into());
    args.push(url.to_string());

    let out = match Command::new("yt-dlp").args(&args).output().await {
        Ok(o) => o,
        Err(e) => return Err(format!("yt-dlp not available: {e}")),
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(tail(err.trim(), 300));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Playlist")
        .to_string();
    let mut entries = Vec::new();
    if let Some(arr) = json.get("entries").and_then(|v| v.as_array()) {
        for it in arr.iter().take(MAX_PLAYLIST_TRACKS) {
            let u = it
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if u.is_empty() {
                continue;
            }
            let t = it
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            entries.push(Entry { url: u, title: t });
        }
    }
    Ok((title, entries))
}

fn resolve_spotify_playlist(
    inner: &Arc<Inner>,
    url: &str,
) -> Result<(String, Vec<Entry>), String> {
    let settings = inner.settings.get();
    let (cid, csec) = match (
        settings.spotify_client_id.clone(),
        settings.spotify_client_secret.clone(),
    ) {
        (Some(a), Some(b)) => (a, b),
        _ => {
            // The app stores its own creds in Settings → Spotify, but most
            // installs only ever configured spotdl itself. Borrow spotdl's
            // credentials so a playlist URL still resolves into per-track
            // jobs (real per-song progress + skipped markers) instead of
            // silently degrading to a single whole-playlist job.
            match spotdl_config_creds() {
                Some((a, b)) => (a, b),
                None => {
                    return Err(
                        "Spotify credentials missing — set Client ID/Secret in Settings → Spotify".into(),
                    )
                }
            }
        }
    };
    let pid = spotify_playlist_id(url).ok_or("could not parse Spotify playlist URL")?;
    let token = spotify_token(&cid, &csec)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build();

    let meta_url = format!("https://api.spotify.com/v1/playlists/{pid}?fields=name");
    let meta: serde_json::Value = agent
        .get(&meta_url)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    let title = meta
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Spotify playlist")
        .to_string();

    let mut entries: Vec<Entry> = Vec::new();
    let mut offset = 0usize;
    loop {
        let tracks_url = format!(
            "https://api.spotify.com/v1/playlists/{pid}/tracks?limit=50&offset={offset}&fields=items(track(id,name,duration_ms,artists(name))),next"
        );
        let resp: serde_json::Value = agent
            .get(&tracks_url)
            .set("Authorization", &format!("Bearer {token}"))
            .call()
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())?;
        if let Some(items) = resp.get("items").and_then(|v| v.as_array()) {
            for it in items {
                let track = &it["track"];
                // some entries are null placeholders (region-locked/unavailable)
                if track.is_null() {
                    continue;
                }
                let tid = track
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if tid.is_empty() {
                    continue;
                }
                let name = track
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let artists: Vec<String> = track
                    .get("artists")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.get("name").and_then(|n| n.as_str()))
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let entry_title = if artists.is_empty() {
                    name.clone()
                } else {
                    format!("{} - {}", artists.join(", "), name)
                };
                entries.push(Entry {
                    url: format!("https://open.spotify.com/track/{tid}"),
                    title: entry_title,
                });
                if entries.len() >= MAX_PLAYLIST_TRACKS {
                    break;
                }
            }
        }
        let has_next = resp
            .get("next")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if !has_next || entries.len() >= MAX_PLAYLIST_TRACKS {
            break;
        }
        offset += 50;
    }
    Ok((title, entries))
}

fn spotify_token(cid: &str, csec: &str) -> Result<String, String> {
    use base64::Engine;
    let cred = base64::engine::general_purpose::STANDARD
        .encode(format!("{cid}:{csec}").as_bytes());
    let resp = ureq::post("https://accounts.spotify.com/api/token")
        .set("Authorization", &format!("Basic {cred}"))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_form(&[("grant_type", "client_credentials")])
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Spotify auth failed — check your Client ID/Secret".into())
}

fn spotify_playlist_id(url: &str) -> Option<String> {
    let u = url.trim();
    const PREFIXES: [&str; 2] = ["spotify:playlist:", "open.spotify.com/playlist/"];
    for p in PREFIXES {
        if let Some(idx) = u.find(p) {
            let rest = &u[idx + p.len()..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric())
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

fn track_url(playlist_url: &str, e: &Entry) -> String {
    if e.url.starts_with("http://") || e.url.starts_with("https://") {
        e.url.clone()
    } else if is_spotify_playlist(playlist_url) {
        format!("https://open.spotify.com/track/{}", e.url)
    } else {
        format!("https://www.youtube.com/watch?v={}", e.url)
    }
}

fn is_playlist_url(url: &str) -> bool {
    is_youtube_playlist(url) || is_spotify_playlist(url)
}

fn is_youtube_playlist(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    (u.contains("youtube.com") || u.contains("youtu.be") || u.contains("music.youtube.com"))
        && (u.contains("/playlist") || u.contains("list="))
}

fn is_spotify_playlist(url: &str) -> bool {
    let u = url.trim();
    u.contains("open.spotify.com/playlist/") || u.starts_with("spotify:playlist:")
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
    // limit how many download processes run at once so bulk queuing doesn't
    // saturate the link with dozens of yt-dlp/spotdl children
    let _permit = match inner.active.acquire().await {
        Ok(p) => p,
        Err(_) => return,
    };

    {
        let mut jobs = inner.state.lock().unwrap().jobs;
        // cancelled while waiting on the permit — don't resurrect it
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

    // Playlist child that's already in the library (same source URL, e.g. an
    // earlier download or a song repeated across playlists): don't re-download,
    // just link the existing track into the collection and mark it done.
    if let Some(pid) = job.db_playlist {
        if let Ok(Some(existing)) = inner.db.track_id_by_source_url(&job.url) {
            let _ = inner.db.add_to_playlist(pid, existing);
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.percent = 100.0;
                    j.skipped = true;
                    // keep the real song title (playlist children are pre-titled
                    // from the resolved entry) so the group shows WHICH song was
                    // skipped — only a bare single-track add gets the generic text
                    if j.title.is_empty() {
                        j.title = "Already in library — added to playlist".into();
                    }
                }
            }
            emit_job(&inner, id);
            return;
        }
    }

    let guard = tokio::time::timeout(std::time::Duration::from_secs(3600), async {
        match job.kind {
            JobKind::Youtube => run_ytdlp(&inner, &job).await,
            JobKind::Spotify => run_spotdl(&inner, &job).await,
            JobKind::Playlist => {}
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
    // `--print` (used below for title/filepath) forces quiet mode, which yt-dlp
    // maps to `noprogress`. Without this flag no progress lines are emitted and
    // the UI progress bar never moves.
    args.push("--progress".into());
    args.push("--ignore-errors".into());
    // yt-dlp 2026 needs a JS runtime for YouTube challenge solving; prefer
    // whatever is installed (node > deno > bun).
    if let Some(rt) = js_runtime() {
        args.push("--js-runtimes".into());
        args.push(rt);
    }
    args.push("--remote-components".into());
    args.push("ejs:github".into());
    args.push("--extractor-args".into());
    args.push("youtube:player_client=web_embedded".into());
    args.push("--progress-template".into());
    // `download:` is the reserved type-prefix and gets consumed by yt-dlp, so the
    // emitted line is `dl:<bytes>/<bytes>|<title>`.
    args.push("download:dl:%(progress.downloaded_bytes)s/%(progress.total_bytes)s|%(info.title)s".into());
    // prints the real title as soon as yt-dlp has fetched the page, before
    // any progress lines arrive
    args.push("--print".into());
    args.push("TITLE:%(title)s".into());
    args.push("--print".into());
    args.push("after_move:FILEPATH:%(filepath)s".into());
    args.push("-f".into());
    // prefer m4a so --embed-thumbnail can actually embed (webm is unsupported);
    // fall back to anything if m4a isn't offered.
    args.push("bestaudio[ext=m4a]/bestaudio/best".into());
    args.push("--embed-thumbnail".into());
    // download-quality config: "best" keeps the original m4a; mp3 presets
    // re-encode to a fixed bitrate via ffmpeg.
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
    // flaky-network resilience: generous retries with backoff, longer socket
    // timeouts, chunked transfers (finer-grained resume on drops), and
    // fragment-level retries for DASH/HLS streams.
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
                let mut jobs = inner.state.lock().unwrap().jobs;
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
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.downloaded = downloaded;
                    j.total = total;
                    j.percent = percent;
                    if !title.is_empty() {
                        j.title = title.to_string();
                    }
                }
            }
            // throttle: yt-dlp --newline emits ~4-8 progress lines/sec and each
            // one was triggering a full frontend library re-render; 120ms keeps
            // the progress bar feeling live without hammering the UI.
            if last_progress.elapsed() > std::time::Duration::from_millis(120) {
                emit_job(inner, id);
                last_progress = std::time::Instant::now();
            }
        } else if let Some(p) = line.strip_prefix("FILEPATH:") {
            paths.push(p.to_string());
        } else if ytdlp_skipped(&line) {
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.skipped = true;
                }
            }
            emit_job(inner, id);
        } else if let Some((item, total_items)) = ytdlp_item(&line) {
            // fallback whole-playlist download: yt-dlp prints "Downloading
            // item X of Y" before each video — feed it into the playlist
            // header for a live group progress bar.
            if is_playlist_url(&job.url) {
                if let Some(pid) = job.group_id {
                    let changed = {
                        let mut jobs = inner.state.lock().unwrap().jobs;
                        let mut c = false;
                        if let Some(g) = jobs.get_mut(&pid) {
                            if g.group_total != total_items || g.group_done != item.saturating_sub(1) {
                                g.group_total = total_items;
                                g.group_done = item.saturating_sub(1);
                                c = true;
                            }
                        }
                        c
                    };
                    if changed {
                        emit_job(inner, pid);
                    }
                }
            }
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
            .jobs
            .lock()
            .unwrap()
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
                if let Ok(Some(existing)) = inner.db.track_id_by_path(p) {
                    if let Some(pid) = job.db_playlist {
                        let _ = inner.db.add_to_playlist(pid, existing);
                    }
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
                if let Ok(tid) = inner.db.add_track(&nt) {
                    crate::art::extract_cover(p);
                    if let Some(pid) = job.db_playlist {
                        let _ = inner.db.add_to_playlist(pid, tid);
                    }
                    added += 1;
                }
            }
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
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
    // spotdl downloads via yt-dlp into its own temp folder (~/.config/spotdl/
    // temp or ~/.spotdl/temp) and only moves finished files into the output
    // dir — so partial bytes must be read from there, not the output dir.
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
    // download-quality config
    match inner.settings.get().quality.as_str() {
        "mp3_192" => {
            cmd.arg("--format").arg("mp3").arg("--bitrate").arg("192K");
        }
        "mp3_320" => {
            cmd.arg("--format").arg("mp3").arg("--bitrate").arg("320K");
        }
        _ => {
            // keep the source audio at its original bitrate instead of
            // re-encoding to a fixed value
            cmd.arg("--format").arg("m4a").arg("--bitrate").arg("auto");
        }
    }
    cmd.arg("--threads")
        .arg("4")
        .arg("--print-errors")
        // plain single-line progress so we can parse a live percent
        .arg("--simple-tui")
        // synced lyrics provider is required for --generate-lrc to write
        // .lrc files next to the track (the app's lyrics panel reads them)
        .arg("--lyrics")
        .arg("genius")
        .arg("musixmatch")
        .arg("azlyrics")
        .arg("synced")
        .arg("--generate-lrc")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // spotdl bundles its own yt-dlp; feed it the same flags that make the
    // app's direct yt-dlp downloads work — a JS runtime for challenge solving
    // plus the web_embedded client to dodge 403s. Without these spotdl fails
    // ("Some YouTube downloads require Deno").
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
    // Python block-buffers stdout when it's a pipe, which would stall spotdl's
    // progress lines (and the UI) until 8KB accumulates. Force unbuffered.
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
        let mut jobs = inner.state.lock().unwrap().jobs;
        if let Some(j) = jobs.get_mut(&id) {
            // playlist children already carry their real song title from the
            // resolved entry — don't replace it with the generic marker
            if j.title.is_empty() {
                j.title = "Spotify — working…".into();
            }
            j.percent = -1.0;
        }
    }
    emit_job(inner, id);

    // spotdl's stdout can be buffered/unreliable (and its percent only steps
    // through coarse phases), so drive the live UI from the file actually being
    // written on disk: every 300ms we report the current song name and byte
    // count, which gives a real-time title, MB count and MB/s rate regardless
    // of what spotdl prints.
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
                let mut jobs = mon_inner.state.lock().unwrap().jobs;
                let Some(j) = jobs.get_mut(&mon_id) else {
                    return;
                };
                if j.status != JobStatus::Downloading {
                    true
                } else {
                    if bytes > 0 {
                        j.downloaded = bytes;
                    }
                    // fall back to the on-disk file name when spotdl hasn't
                    // given us a song title yet (or only the generic marker)
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

    // parse spotdl's simple-tui stdout for a live percent + track name
    let mut raw = String::new();
    let mut last_emit = std::time::Instant::now();
    let mut last_skipped_count = 0usize;
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
                let compl = spotdl_complete(&raw);
                let sk = spotdl_skipped(&raw);
                {
                    let mut jobs = inner.state.lock().unwrap().jobs;
                    if let Some(j) = jobs.get_mut(&id) {
                        if let Some(p) = pct {
                            j.percent = p;
                        }
                        // song name beats a raw filename for display
                        if let Some(s) = song {
                            j.title = s;
                        } else if let Some(f) = file {
                            j.title = f;
                        }
                        // a single-track job that was skipped stays marked; a
                        // whole-playlist download skips individual songs all the
                        // time, so never flag the job itself as skipped there
                        if sk && !is_playlist_url(&job.url) {
                            j.skipped = true;
                        }
                        // real-time byte count (file-system driven; the monitor
                        // task also updates it, this keeps the rate fresh on
                        // every stdout flush too)
                        let (b, _) = spotdl_work(out.as_path(), temp.as_deref(), temp_before.as_ref(), &before);
                        if b > 0 {
                            j.downloaded = b;
                        }
                    }
                }
                // fallback whole-playlist download: spotdl reports "X/Y complete",
                // feed that into the playlist header so the group progress bar,
                // done/total counter and "Done" state stay accurate.
                if let (Some((done, total)), Some(pid)) = (compl, job.group_id) {
                    if is_playlist_url(&job.url) {
                        let changed = {
                            let mut jobs = inner.state.lock().unwrap().jobs;
                            let mut c = false;
                            if let Some(g) = jobs.get_mut(&pid) {
                                if g.group_total != total || g.group_done != done {
                                    g.group_total = total;
                                    g.group_done = done;
                                    c = true;
                                }
                            }
                            c
                        };
                        if changed {
                            emit_job(inner, pid);
                        }
                    }
                }
                // tally songs spotdl skipped on a fallback whole-playlist download
                // (one "Skipping X…"/"X: Skipped" line per song) so the group
                // header can show "N skipped" instead of hiding it entirely.
                let skipped_now = spotdl_skipped_count(&raw);
                if skipped_now > last_skipped_count {
                    let delta = skipped_now - last_skipped_count;
                    last_skipped_count = skipped_now;
                    if is_playlist_url(&job.url) {
                        if let Some(pid) = job.group_id {
                            let changed = {
                                let mut jobs = inner.state.lock().unwrap().jobs;
                                let mut c = false;
                                if let Some(g) = jobs.get_mut(&pid) {
                                    g.group_skipped += delta;
                                    c = true;
                                }
                                c
                            };
                            if changed {
                                emit_job(inner, pid);
                            }
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
            .jobs
            .lock()
            .unwrap()
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
                if let Ok(Some(existing)) = inner.db.track_id_by_path(&p) {
                    if let Some(pid) = job.db_playlist {
                        let _ = inner.db.add_to_playlist(pid, existing);
                    }
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
                if let Ok(tid) = inner.db.add_track(&nt) {
                    crate::art::extract_cover(&p);
                    if let Some(pid) = job.db_playlist {
                        let _ = inner.db.add_to_playlist(pid, tid);
                    }
                    added += 1;
                }
            }
            {
                let mut jobs = inner.state.lock().unwrap().jobs;
                if let Some(j) = jobs.get_mut(&id) {
                    j.status = JobStatus::Completed;
                    j.percent = 100.0;
                    // Single track: success with zero new files means spotdl
                    // found it already on disk and skipped it.
                    if added == 0 && !is_playlist_url(&url) {
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
    let mut jobs = inner.state.lock().unwrap().jobs;
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

/// Move spotdl's plain `.lrc` lyrics files (unused by the app) into a
/// `Lyrics/` subfolder so the download dir stays audio-only. The app's own
/// `.lrclib` cache must stay next to the audio file — the player reads it.
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
            // Only audio files are tracks — spotdl also drops `.lrc` lyric
            // files next to each download, and those must not become library
            // entries (they'd break playback and confuse lyrics lookup).
            if !before.contains(&s) && p.is_file() && is_audio(&e.file_name().to_string_lossy()) {
                out.push(s);
            }
        }
    }
    out
}

fn is_audio(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3" | "m4a"
            | "m4b"
            | "flac"
            | "ogg"
            | "oga"
            | "opus"
            | "wav"
            | "webm"
            | "aac"
            | "aif"
            | "aiff"
            | "wma"
            | "mka"
    )
}

/// Bytes + file name currently being written for a download that doesn't
/// report its own byte progress (spotdl). Sums the partial files yt-dlp drops
/// while downloading; once those are gone (postprocessor running / finished),
/// falls back to the most recently modified audio file — the final file ffmpeg
/// is writing — if it changed within the last few seconds. Files that already
/// existed when the job started are ignored.
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

/// Spotdl progress: byte count comes from yt-dlp partials growing inside
/// spotdl's temp folder; the current song name comes from the newest finished
/// audio in the output dir (temp filenames are just video IDs, useless as titles).
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
                        // conversion/embedding is writing the final file into the
                        // output dir — count those bytes too so the speed keeps
                        // flowing through the whole song lifecycle
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
        .jobs
        .lock()
        .unwrap()
        .values()
        .any(|j| matches!(j.status, JobStatus::Queued | JobStatus::Downloading))
}

/// GUI-launched processes on Linux get a minimal PATH that often omits
/// ~/.local/bin (pipx/venv installs), so resolve spotdl by probing the usual
/// locations before falling back to PATH lookup.
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

/// Read Spotify client credentials from spotdl's own config file, which most
/// users configure once for spotdl and never repeat inside the app. Checks the
/// standard spotdl locations (XDG config, then home). Returns None when spotdl
/// was never configured or the creds are blank.
fn spotdl_config_creds() -> Option<(String, String)> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        candidates.push(std::path::Path::new(&xdg).join("spotdl/config.json"));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        candidates.push(std::path::Path::new(&home).join(".config/spotdl/config.json"));
        candidates.push(std::path::Path::new(&home).join(".spotdl/config.json"));
    }
    for p in candidates {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                let id = v
                    .get("client_id")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .filter(|x| !x.is_empty());
                let sec = v
                    .get("client_secret")
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
                    .filter(|x| !x.is_empty());
                if let (Some(id), Some(sec)) = (id, sec) {
                    return Some((id, sec));
                }
            }
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

/// Filenames are almost always `Artist - Title` (spotdl's `{artists} -
/// {title}` template and typical YouTube uploads). Split on the FIRST " - "
/// so the artist lands in its own field — which the lyrics lookup needs,
/// and the UI reads better.
fn split_artist_title(stem: &str) -> (String, String) {
    if let Some(i) = stem.find(" - ") {
        let artist = stem[..i].trim();
        let title = stem[i + 3..].trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    (String::new(), stem.to_string())
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

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

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
        // partial bytes live in spotdl's temp folder (video-id filenames)
        std::fs::write(temp.join("abc123.m4a.part"), vec![0u8; 8192]).unwrap();
        // finished song lands in the output dir
        let song = out.join("Artist - Song.m4a");
        std::fs::write(&song, vec![0u8; 4096]).unwrap();
        let (bytes, name) = spotdl_work(&out, Some(&temp), Some(&temp_before), &out_before);
        // 8192 temp partial + 4096 freshly-written output audio
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

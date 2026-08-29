mod art;
mod db;
mod downloader;
mod player;
mod settings;

use db::{Db, NewTrack, Playlist, Track};
use downloader::{DownloadManager, JobView};
use player::{Player, PlayerState};
use settings::Settings;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

fn is_audio_file(name: &str) -> bool {
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

fn split_title(stem: &str) -> (String, String) {
    if let Some(i) = stem.find(" - ") {
        let artist = stem[..i].trim();
        let title = stem[i + 3..].trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    (String::new(), stem.to_string())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Register every audio file in the download dir that isn't in the DB yet so
/// songs downloaded outside the app (or before the DB existed) still appear in
/// the library. Returns the number of tracks added.
fn scan_music_dir(db: &Arc<Db>, dir: &std::path::Path) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut added = 0usize;
    for e in rd.flatten() {
        let path = e.path();
        if !e.metadata().map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !is_audio_file(&name) {
            continue;
        }
        let path_s = path.to_string_lossy().to_string();
        if db
            .track_id_by_path(&path_s)
            .map(|o| o.is_some())
            .unwrap_or(false)
        {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (artist, title) = split_title(&stem);
        let nt = NewTrack {
            title,
            artist,
            album: String::new(),
            duration: probe_duration(&path_s),
            path: path_s.clone(),
            source_url: String::new(),
            source: "local".into(),
            added_at: now_unix(),
        };
        if db.add_track(&nt).is_ok() {
            let _ = art::extract_cover(&path_s);
            added += 1;
        }
    }
    added
}

#[tauri::command]
fn add_download(dm: State<DownloadManager>, url: String) -> u64 {
    dm.add(url)
}

#[tauri::command]
fn cancel_download(dm: State<DownloadManager>, id: u64) {
    dm.cancel(id);
}

#[tauri::command]
fn list_downloads(dm: State<DownloadManager>) -> Vec<JobView> {
    dm.list()
}

#[tauri::command]
fn clear_downloads(dm: State<DownloadManager>) {
    dm.clear_finished();
}

#[tauri::command]
fn get_library(db: State<Arc<Db>>) -> Result<Vec<Track>, String> {
    db.get_tracks().map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_track(
    app: AppHandle,
    db: State<Arc<Db>>,
    id: i64,
) -> Result<(), String> {
    if let Some(t) = db.get_track(id).map_err(|e| e.to_string())? {
        db.remove_track(id).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&t.path);
        let _ = app.emit("library-changed", ());
    }
    Ok(())
}

#[tauri::command]
fn add_local_file(db: State<Arc<Db>>, path: String) -> Result<bool, String> {
    if db
        .track_id_by_path(&path)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok(false);
    }
    let title = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let duration = probe_duration(&path);
    db.add_track(&NewTrack {
        title,
        artist: String::new(),
        album: String::new(),
        duration,
        path: path.clone(),
        source_url: String::new(),
        source: "local".into(),
        added_at: unix_now(),
    })
    .map_err(|e| e.to_string())?;
    Ok(true)
}

pub(crate) fn probe_duration(path: &str) -> i64 {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().unwrap_or(0.0) as i64
        }
        _ => 0,
    }
}

#[tauri::command]
fn play_track(p: State<Player>, id: i64) {
    p.load_track(id);
}

#[tauri::command]
fn toggle_play(p: State<Player>) {
    p.toggle_play();
}

#[tauri::command]
fn player_stop(p: State<Player>) {
    p.stop();
}

#[tauri::command]
fn player_next(p: State<Player>) {
    p.next();
}

#[tauri::command]
fn player_prev(p: State<Player>) {
    p.prev();
}

#[tauri::command]
fn player_seek(p: State<Player>, secs: f64) {
    p.seek(secs);
}

#[tauri::command]
fn player_set_volume(p: State<Player>, volume: f64) {
    p.set_volume(volume);
}

#[tauri::command]
fn get_player_state(p: State<Player>) -> PlayerState {
    p.state()
}

#[tauri::command]
fn get_settings(s: State<Arc<settings::SettingsStore>>) -> Settings {
    s.get()
}

#[tauri::command]
fn set_spotify_creds(
    s: State<Arc<settings::SettingsStore>>,
    client_id: String,
    client_secret: String,
) {
    s.set_spotify_creds(Some(client_id), Some(client_secret));
}

#[tauri::command]
fn set_download_dir(s: State<Arc<settings::SettingsStore>>, dir: String) {
    s.set_download_dir(dir);
}

#[tauri::command]
fn set_download_quality(s: State<Arc<settings::SettingsStore>>, quality: String) {
    s.set_quality(quality);
}

#[tauri::command]
fn set_theme(s: State<Arc<settings::SettingsStore>>, theme: String) {
    s.set_theme(theme);
}

#[derive(serde::Serialize)]
struct TrackMeta {
    format: String,
    codec: String,
    bitrate: u64,
    sample_rate: u32,
    channels: u32,
    duration: f64,
    size: u64,
}

#[tauri::command]
fn get_track_meta(track_path: String) -> Option<TrackMeta> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name,duration,size,bit_rate",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:stream_tags=BPS",
            "-of",
            "json",
            &track_path,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let format = &v["format"];
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let audio = streams
        .iter()
        .find(|s| s["codec_type"] == "audio")
        .cloned()
        .unwrap_or_default();
    let fmt_name = format["format_name"]
        .as_str()
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .to_string();
    let codec = audio["codec_name"].as_str().unwrap_or("").to_string();
    let sample_rate = audio["sample_rate"]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let channels = audio["channels"].as_u64().unwrap_or(0) as u32;
    // stream BPS tag (mp3 CBR) else format bit_rate
    let bitrate = audio["tags"]["BPS"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| format["bit_rate"].as_str().and_then(|s| s.parse::<u64>().ok()))
        .unwrap_or(0);
    Some(TrackMeta {
        format: fmt_name,
        codec,
        bitrate,
        sample_rate,
        channels,
        duration: format["duration"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
        size: format["size"].as_str().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
    })
}

#[tauri::command]
fn get_download_dir(s: State<Arc<settings::SettingsStore>>) -> String {
    s.get()
        .resolved_download_dir()
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn update_engines(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut out = String::new();
        if let Ok(o) = tokio::process::Command::new("yt-dlp").arg("-U").output().await {
            out.push_str(&format!("[yt-dlp] {}\n", tail_str(&o.stdout, 800)));
        } else {
            out.push_str("[yt-dlp] could not run (is it installed?)\n");
        }
        let pip = tokio::process::Command::new("python3")
            .args(["-m", "pip", "install", "--user", "-U", "spotdl"])
            .output()
            .await;
        match pip {
            Ok(o) if o.status.success() => {
                out.push_str(&format!("[spotdl] {}\n", tail_str(&o.stdout, 800)));
            }
            Ok(o) => {
                out.push_str(&format!("[spotdl] failed: {}\n", tail_str(&o.stderr, 500)));
            }
            Err(e) => out.push_str(&format!("[spotdl] could not run pip: {e}\n")),
        }
        let _ = app.emit("engines-updated", out);
    });
}

fn tail_str(b: &[u8], max: usize) -> String {
    let s = String::from_utf8_lossy(b).trim().to_string();
    let s = s.lines().last().unwrap_or("").to_string();
    if s.len() > max {
        format!("…{}", &s[s.len() - max..])
    } else {
        s
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn set_favorite(db: State<Arc<Db>>, id: i64, favorite: bool) -> Result<(), String> {
    db.set_favorite(id, favorite).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_track_meta(
    db: State<Arc<Db>>,
    id: i64,
    title: String,
    artist: String,
    album: String,
) -> Result<(), String> {
    db.update_meta(id, title, artist, album)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_playlists(db: State<Arc<Db>>) -> Result<Vec<Playlist>, String> {
    db.get_playlists().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_playlist(db: State<Arc<Db>>, name: String) -> Result<i64, String> {
    db.create_playlist(name, unix_now()).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_playlist(db: State<Arc<Db>>, id: i64, name: String) -> Result<(), String> {
    db.rename_playlist(id, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_playlist(app: AppHandle, db: State<Arc<Db>>, id: i64) -> Result<(), String> {
    db.delete_playlist(id).map_err(|e| e.to_string())?;
    let _ = app.emit("playlists-changed", ());
    Ok(())
}

#[tauri::command]
fn add_to_playlist(db: State<Arc<Db>>, playlist_id: i64, track_id: i64) -> Result<(), String> {
    db.add_to_playlist(playlist_id, track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_from_playlist(
    db: State<Arc<Db>>,
    playlist_id: i64,
    track_id: i64,
) -> Result<(), String> {
    db.remove_from_playlist(playlist_id, track_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_playlist_tracks(db: State<Arc<Db>>, playlist_id: i64) -> Result<Vec<Track>, String> {
    db.get_playlist_tracks(playlist_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_shuffle(p: State<Player>, on: bool) {
    p.set_shuffle(on);
}

#[tauri::command]
fn set_repeat(p: State<Player>, mode: String) {
    p.set_repeat(mode);
}

#[tauri::command]
fn set_speed(p: State<Player>, speed: f64) {
    p.set_speed(speed);
}

#[tauri::command]
fn set_equalizer(p: State<Player>, preset: String) {
    p.set_equalizer(preset);
}

#[tauri::command]
fn set_eq_bands(p: State<Player>, bands: Vec<f64>) {
    p.set_eq_bands(bands);
}

#[tauri::command]
fn set_fade(s: State<Arc<settings::SettingsStore>>, enabled: bool, duration: f64) {
    s.set_fade(enabled, duration);
}

#[tauri::command]
fn set_effect(p: State<Player>, effect: String) {
    p.set_effect(effect);
}

#[tauri::command]
fn set_window_controls(s: State<Arc<settings::SettingsStore>>, enabled: bool) {
    s.set_window_controls(enabled);
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        } else {
            let _ = w.maximize();
        }
    }
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

#[tauri::command]
fn reorder_queue(p: State<Player>, from: usize, to: usize) {
    p.reorder_queue(from, to);
}

#[tauri::command]
/// Lyrics directly beside the track file (`<stem>.lrclib` = our reliable
/// LRCLIB cache, then spotdl/manual `.lrc`/`.txt`/`.lyr`).
fn local_lyrics(p: &std::path::Path) -> Option<String> {
    let stem = p.with_extension("");
    for ext in ["lrclib", "lrc", "txt", "lyr"] {
        let f = stem.with_extension(ext);
        if let Ok(s) = std::fs::read_to_string(&f) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn lrclib_get(track: &str, artist: &str, duration_ms: i64) -> Option<String> {
    let url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}&duration={}",
        urlencode(track),
        urlencode(artist),
        duration_ms
    );
    lrclib_parse(&url)
}

fn lrclib_search(track: &str, artist: &str, duration_ms: i64) -> Option<String> {
    // No exact duration match — search and pick the closest duration result.
    let url = format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        urlencode(track),
        urlencode(artist)
    );
    let body = ureq_get(&url)?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&body).ok()?;
    let mut best: Option<(i64, serde_json::Value)> = None;
    for it in items {
        let d = it.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
        let diff = (d - duration_ms).abs();
        if best.as_ref().map(|(bd, _)| diff < *bd).unwrap_or(true) {
            best = Some((diff, it));
        }
    }
    best.and_then(|(_, it)| lrc_from_json(&it))
}

fn lrc_from_json(it: &serde_json::Value) -> Option<String> {
    if let Some(s) = it.get("syncedLyrics").and_then(|v| v.as_str()) {
        if !s.trim().is_empty() {
            return Some(s.to_string());
        }
    }
    it.get("plainLyrics")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

fn lrclib_parse(url: &str) -> Option<String> {
    match ureq_get(url) {
        Some(body) => {
            let it: serde_json::Value = serde_json::from_str(&body).ok()?;
            lrc_from_json(&it)
        }
        None => None,
    }
}

fn ureq_get(url: &str) -> Option<String> {
    let req = ureq::get(url)
        .set(
            "User-Agent",
            concat!("Embertune/", env!("CARGO_PKG_VERSION"), " (music player)"),
        )
        .set("Accept", "application/json");
    match req.call() {
        Ok(resp) => resp.into_string().ok(),
        Err(ureq::Error::Status(404, _)) => None,
        Err(_) => None,
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[tauri::command]
async fn get_lyrics(
    track_path: String,
    title: String,
    artist: String,
    duration: i64,
) -> Option<String> {
    let p = std::path::Path::new(&track_path);
    // 1) Cached duration-matched LRCLIB lyrics (the reliable source).
    let cached = p.with_extension("lrclib");
    if cached.is_file() {
        if let Ok(s) = std::fs::read_to_string(&cached) {
            if !s.trim().is_empty() {
                return Some(s);
            }
        }
    }
    // 2) Fetch duration-matched lyrics from LRCLIB. Duration is the key: it
    // filters out covers/remixes/wrong-version matches that spotdl's fuzzy
    // title-only providers pick up.
    let title2 = title.clone();
    let artist2 = artist.clone();
    let dur_ms = duration.saturating_mul(1000);
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        lrclib_get(&title2, &artist2, dur_ms).or_else(|| lrclib_search(&title2, &artist2, dur_ms))
    })
    .await
    .ok()
    .flatten();
    if let Some(lrc) = fetched {
        let _ = std::fs::write(&cached, &lrc);
        return Some(lrc);
    }
    // 3) Fall back to lyrics already sitting next to the file (spotdl, manual).
    local_lyrics(p)
}

#[tauri::command]
fn set_sleep_timer(s: State<Arc<settings::SettingsStore>>, minutes: Option<i64>) {
    s.set_sleep_timer(minutes);
}

#[tauri::command]
fn get_art(track_path: String) -> Option<String> {
    use base64::Engine;
    let p = art::art_path_for(&track_path);
    std::fs::read(&p)
        .ok()
        .map(|b| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
}

#[tauri::command]
fn extract_art(track_path: String) -> bool {
    art::extract_cover(&track_path)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                if let Some(p) = app.try_state::<Player>() {
                    p.shutdown();
                }
            }
        })
        .setup(|app| {
            let data = settings::data_dir();
            let _ = std::fs::create_dir_all(&data);
            let db = Arc::new(
                Db::new(&data.join("embertune.db")).map_err(Box::<dyn std::error::Error>::from)?,
            );
            {
                let db = db.clone();
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    if let Ok(tracks) = db.get_tracks() {
                        for t in tracks {
                            if t.duration <= 0 {
                                let d = probe_duration(&t.path);
                                if d > 0 {
                                    let _ = db.update_duration(t.id, d);
                                }
                            }
                            if !art::art_file_exists(&t.path) {
                                let _ = art::extract_cover(&t.path);
                            }
                        }
                    }
                    let _ = app.emit("library-changed", 0);
                });
            }
            let store = Arc::new(settings::SettingsStore::load(data.join("settings.json")));
            downloader::sweep_orphaned_partials(&store.get().resolved_download_dir());
            let dm = DownloadManager::new(app.handle().clone(), db.clone(), store.clone());
            {
                // Index any audio files already on disk (downloaded before the
                // DB existed or outside the app) and tuck spotdl's stray .lrc
                // files into Lyrics/ so the download dir stays audio-only.
                let db = db.clone();
                let store = store.clone();
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    let dir = store.get().resolved_download_dir();
                    let added = scan_music_dir(&db, dir.as_path());
                    downloader::organize_lyrics(dir.as_path());
                    if added > 0 {
                        let _ = app.emit("library-changed", added);
                    }
                });
            }
            let player = Player::new(
                app.handle().clone(),
                db.clone(),
                store.clone(),
                data.join("mpv.sock"),
            );
            app.manage(db);
            app.manage(store);
            app.manage(dm);
            app.manage(player);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_download,
            cancel_download,
            list_downloads,
            clear_downloads,
            get_library,
            remove_track,
            add_local_file,
            play_track,
            toggle_play,
            player_stop,
            player_next,
            player_prev,
            player_seek,
            player_set_volume,
            get_player_state,
            get_settings,
            set_spotify_creds,
            set_download_dir,
            set_download_quality,
            set_theme,
            get_track_meta,
            get_download_dir,
            update_engines,
            set_favorite,
            update_track_meta,
            get_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            add_to_playlist,
            remove_from_playlist,
            get_playlist_tracks,
            set_shuffle,
            set_repeat,
            set_speed,
            set_sleep_timer,
            set_equalizer,
            set_eq_bands,
            set_fade,
            set_effect,
            set_window_controls,
            window_minimize,
            window_toggle_maximize,
            window_close,
            reorder_queue,
            get_lyrics,
            get_art,
            extract_art,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
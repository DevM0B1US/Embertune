use crate::db::{Db, Track};
use crate::settings::{data_dir, Settings, SettingsStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

/// Overall deadline for one mpv request/response round trip. The per-read
/// timeout (2s) alone can let the reply loop spin for many seconds when mpv
/// floods broadcast events (audit B12); this caps the whole request.
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
pub struct PlayerState {
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub volume: f64,
    pub idle: bool,
    pub current: Option<Track>,
    pub shuffle: bool,
    pub repeat: String,
    pub speed: f64,
}

pub struct Player {
    conn: Arc<Mutex<Option<IpcConn>>>,
    child: Mutex<Option<Child>>,
    /// ids in current play order (matches mpv's playlist 1:1)
    queue: Mutex<Vec<i64>>,
    /// ids in the order the queue was built (pre-shuffle) — used to
    /// restore order when shuffle is switched off (audit B13)
    base_order: Mutex<Vec<i64>>,
    /// signals the connect/fade background threads to exit (audit A6)
    shutdown_flag: Arc<AtomicBool>,
    db: Arc<Db>,
    settings: Arc<SettingsStore>,
}

// mpv is driven over its JSON IPC socket. One mutex-serialized connection;
// every command is a request/reply with a matching request_id, so concurrent
// property polls and transport commands never interleave badly.
struct IpcConn {
    out: UnixStream,
    inp: BufReader<UnixStream>,
    next_id: u64,
}

impl IpcConn {
    fn connect(sock: &std::path::Path) -> std::io::Result<Self> {
        let out = UnixStream::connect(sock)?;
        out.set_read_timeout(Some(Duration::from_secs(2)))?;
        out.set_write_timeout(Some(Duration::from_secs(2)))?;
        let inp = out.try_clone()?;
        Ok(IpcConn {
            out,
            inp: BufReader::new(inp),
            next_id: 1,
        })
    }

    fn request(&mut self, cmd: &[Value]) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "request_id": id, "command": cmd });
        let mut line = req.to_string();
        line.push('\n');
        self.out.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.out.flush().map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + REQUEST_DEADLINE;
        loop {
            if std::time::Instant::now() > deadline {
                return Err("mpv request timed out".into());
            }
            let mut raw = String::new();
            self.inp
                .read_line(&mut raw)
                .map_err(|e| format!("mpv read: {e}"))?;
            let v: Value =
                serde_json::from_str(raw.trim()).map_err(|e| format!("mpv reply parse: {e}"))?;
            if v.get("request_id").and_then(|r| r.as_u64()) == Some(id) {
                return Ok(v);
            }
            // otherwise: a broadcast event, skip it
        }
    }

    fn command(&mut self, args: &[&str]) -> Result<(), String> {
        let v: Vec<Value> = args.iter().map(|a| Value::String(a.to_string())).collect();
        self.request(&v).map(|_| ())
    }

    fn set_prop<T: serde::Serialize>(&mut self, name: &str, val: T) -> Result<(), String> {
        self.request(&[json!("set_property"), json!(name), json!(val)])
            .map(|_| ())
    }

    fn set_prop_str(&mut self, name: &str, val: &str) -> Result<(), String> {
        self.request(&[json!("set_property"), json!(name), json!(val)])
            .map(|_| ())
    }

    fn get_bool(&mut self, name: &str) -> Result<bool, String> {
        let v = self.request(&[json!("get_property"), json!(name)])?;
        v.get("data")
            .and_then(|d| d.as_bool())
            .ok_or_else(|| format!("no bool for {name}"))
    }

    fn get_f64(&mut self, name: &str) -> Result<Option<f64>, String> {
        let v = self.request(&[json!("get_property"), json!(name)])?;
        Ok(v.get("data").and_then(|d| d.as_f64()))
    }

    fn get_i64(&mut self, name: &str) -> Result<Option<i64>, String> {
        let v = self.request(&[json!("get_property"), json!(name)])?;
        Ok(v.get("data").and_then(|d| d.as_i64()))
    }

    fn get_str(&mut self, name: &str) -> Result<Option<String>, String> {
        let v = self.request(&[json!("get_property"), json!(name)])?;
        Ok(v.get("data").and_then(|d| d.as_str()).map(|s| s.to_string()))
    }

    /// Filenames of mpv's current playlist, in play order.
    fn playlist_filenames(&mut self) -> Vec<String> {
        let v = match self.request(&[json!("get_property"), json!("playlist")]) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        v.get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        e.get("filename").and_then(|f| f.as_str()).map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Player {
    pub fn new(_app: AppHandle, db: Arc<Db>, settings: Arc<SettingsStore>, sock: PathBuf) -> Self {
        let sock2 = sock.clone();
        // A crashed previous run can leave an mpv holding the IPC socket. A
        // fresh mpv then fails to bind and the app silently drives the OLD
        // mpv — including its resume/save-position flags. Reap any mpv bound
        // to our socket, then unlink it so the new mpv always owns the IPC
        // endpoint.
        kill_stale_mpv(&sock);
        let _ = std::fs::remove_file(&sock);
        let child = Command::new("mpv")
            .args([
                "--idle=yes",
                "--no-video",
                "--force-window=no",
                "--no-terminal",
                "--keep-open=no",
                "--volume=100",
                "--no-resume-playback",
                "--no-save-position-on-quit",
                // seamless consecutive tracks — no silence at track changes
                "--gapless-audio=yes",
            ])
            .arg(format!("--input-ipc-server={}", sock2.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
        let child_holder = Mutex::new(child);
        let conn_holder: Arc<Mutex<Option<IpcConn>>> = Arc::new(Mutex::new(None));
        let conn_thread = conn_holder.clone();
        let settings_thread = settings.clone();
        let connect_flag = Arc::new(AtomicBool::new(false));
        let fade_flag = connect_flag.clone();
        // the connect thread gets its own handle — connect_flag itself is
        // kept for Player.shutdown_flag (Arc is not Copy; moving it into
        // the closure would leave nothing to store on the struct)
        let connect_thread = connect_flag.clone();

        let connect_flag_inner = connect_flag.clone();
        std::thread::spawn(move || {
            let mut attempt = 0u32;
            loop {
                if connect_thread.load(Ordering::Relaxed) {
                    return;
                }
                match IpcConn::connect(&sock2) {
                    Ok(mut c) => {
                        let _ = c.set_prop("volume", 100f64);
                        let s = settings_thread.get();
                        if s.speed > 0.0 {
                            let _ = c.set_prop("speed", s.speed);
                        }
                        let (lp, lf) = match s.repeat.as_str() {
                            "one" => ("no", "inf"),
                            "all" => ("inf", "no"),
                            _ => ("no", "no"),
                        };
                        let _ = c.set_prop_str("loop-playlist", lp);
                        let _ = c.set_prop_str("loop-file", lf);
                        let _ = c.set_prop_str("af", &af_from_settings(&s));
                        *conn_thread.lock().unwrap() = Some(c);
                        return;
                    }
                    Err(_) => {
                        attempt += 1;
                        if attempt > 200 {
                            return; // give up (~20s)
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });

        // Crossfade: adaptive poller — 80ms only when fade enabled, else 500ms and no IPC
        let fade_conn = conn_holder.clone();
        let fade_settings = settings.clone();
        std::thread::spawn(move || {
            let mut base = 100.0f64;
            let mut vol_cur = 100.0f64;
            loop {
                if fade_flag.load(Ordering::Relaxed) {
                    return;
                }
                // check settings without cloning full struct when disabled
                let (fade, fd) = {
                    let s = fade_settings.get();
                    (s.fade_enabled, if s.fade_duration > 0.0 { s.fade_duration } else { 0.0 })
                };
                if !fade || fd <= 0.0 {
                    // disabled: sleep longer and adopt volume without IPC storm
                    std::thread::sleep(Duration::from_millis(500));
                    // still adopt volume base occasionally but with single IPC per wake
                    let v = fade_conn
                        .lock()
                        .unwrap()
                        .as_mut()
                        .and_then(|c| c.get_f64("volume").ok().flatten())
                        .unwrap_or(base);
                    if v != vol_cur {
                        base = v;
                        vol_cur = v;
                    }
                    continue;
                }
                std::thread::sleep(Duration::from_millis(80));
                let mut target: Option<f64> = None;
                let mut in_zone = false;
                {
                    let mut guard = fade_conn.lock().unwrap();
                    if let Some(c) = guard.as_mut() {
                        let paused = c.get_bool("pause").unwrap_or(true);
                        let pos = c.get_f64("time-pos").ok().flatten().unwrap_or(0.0);
                        let dur = c.get_f64("duration").ok().flatten().unwrap_or(0.0);
                        if !paused && dur > 0.0 {
                            if pos < fd {
                                in_zone = true;
                                target = Some(base * (pos / fd));
                            } else {
                                let remaining = dur - pos;
                                if remaining <= fd && remaining >= -0.5 {
                                    in_zone = true;
                                    target = Some(base * (remaining / fd).clamp(0.0, 1.0));
                                }
                            }
                        }
                    }
                }
                if in_zone {
                    if let Some(t) = target {
                        let t = t.clamp(0.0, base).round();
                        if (t - vol_cur).abs() >= 0.5 {
                            let mut guard = fade_conn.lock().unwrap();
                            if let Some(c) = guard.as_mut() {
                                let _ = c.set_prop("volume", t);
                            }
                            vol_cur = t;
                        }
                    }
                } else {
                    let v = fade_conn
                        .lock()
                        .unwrap()
                        .as_mut()
                        .and_then(|c| c.get_f64("volume").ok().flatten())
                        .unwrap_or(base);
                    if v != vol_cur {
                        base = v;
                        vol_cur = v;
                    }
                }
            }
        });

        Player {
            conn: conn_holder,
            child: child_holder,
            queue: Mutex::new(Vec::new()),
            base_order: Mutex::new(Vec::new()),
            shutdown_flag: connect_flag,
            db,
            settings,
        }
    }

    fn with_conn<T>(&self, f: impl FnOnce(&mut IpcConn) -> T) -> Option<T> {
        let mut guard = self.conn.lock().unwrap();
        match guard.as_mut() {
            Some(c) => Some(f(c)),
            None => None,
        }
    }

    /// Play a track and enqueue the rest of the library after it. mpv's own
    /// playlist handles auto-advance; the UI tracks position via `playlist-pos`.
    ///
    /// The whole queue is handed to mpv with a single `loadlist` call on a
    /// generated .m3u (audit B1). The old per-track `loadfile append` loop
    /// was one IPC round trip per track — a 10k-track library froze the
    /// play click for tens of seconds. A 10k-line file write is ~ms; the
    /// IPC cost is now O(1) regardless of library size.
    pub fn load_track(&self, id: i64) {
        let all = match self.db.get_tracks() {
            Ok(t) => t,
            Err(_) => return,
        };
        let idx = match all.iter().position(|t| t.id == id) {
            Some(i) => i,
            None => return,
        };
        let mut rest: Vec<Track> = all[idx..].to_vec();
        if self.settings.get().shuffle && rest.len() > 1 {
            let mut tail: Vec<Track> = rest.split_off(1);
            shuffle_vec(&mut tail, now_nanos());
            rest.extend(tail);
        }
        let ids: Vec<i64> = rest.iter().map(|t| t.id).collect();
        *self.queue.lock().unwrap() = ids.clone();
        // this load establishes the base (un-shuffled) order
        *self.base_order.lock().unwrap() = ids;
        self.load_playlist(&rest, 0);
        self.with_conn(|c| {
            let _ = c.set_prop("pause", false);
        });
    }

    /// Write the play order to the shared m3u and hand it to mpv in one
    /// IPC call. `start` is the entry that should play first (mpv jumps
    /// there before playback, so the clicked track begins immediately).
    fn load_playlist(&self, tracks: &[Track], start: usize) {
        if tracks.is_empty() {
            return;
        }
        let mut body = String::with_capacity(tracks.iter().map(|t| t.path.len() + 1).sum::<usize>());
        for t in tracks {
            body.push_str(&t.path);
            body.push('\n');
        }
        let file = data_dir().join("queue.m3u");
        if std::fs::write(&file, body).is_err() {
            return; // keep the old queue; playback is simply not started
        }
        let file_s = file.to_string_lossy().to_string();
        self.with_conn(|c| {
            let _ = c.command(&["loadlist", &file_s, "replace"]);
            if start > 0 {
                let _ = c.set_prop("playlist-pos", start as i64);
            }
        });
    }

    /// Rebuild mpv's playlist in the pre-shuffle order, keeping the current
    /// track current and (best effort) its playhead position.
    fn restore_base_order(&self) {
        let base: Vec<i64> = self.base_order.lock().unwrap().clone();
        if base.is_empty() {
            return;
        }
        let by_id: HashMap<i64, Track> = self
            .db
            .get_tracks()
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id, t))
            .collect();
        let tracks: Vec<Track> = base.iter().filter_map(|id| by_id.get(id).cloned()).collect();
        if tracks.is_empty() {
            return;
        }
        let (cur_path, cur_pos, paused) = self
            .with_conn(|c| {
                (
                    c.get_str("path").ok().flatten(),
                    c.get_f64("time-pos").ok().flatten().unwrap_or(0.0),
                    c.get_bool("pause").unwrap_or(false),
                )
            })
            .unwrap_or((None, 0.0, false));
        let start = cur_path
            .as_ref()
            .and_then(|p| tracks.iter().position(|t| &t.path == p))
            .unwrap_or(0);
        *self.queue.lock().unwrap() = tracks.iter().map(|t| t.id).collect();
        self.load_playlist(&tracks, start);
        // give mpv a beat to open the target entry, then restore state
        std::thread::sleep(Duration::from_millis(120));
        self.with_conn(|c| {
            let _ = c.set_prop("pause", paused);
            if cur_pos > 0.5 {
                let _ = c.command(&["seek", &format!("{cur_pos}"), "absolute"]);
            }
        });
    }

    pub fn toggle_play(&self) {
        self.with_conn(|c| {
            let paused = c.get_bool("pause").unwrap_or(true);
            let _ = c.set_prop("pause", !paused);
        });
    }

    pub fn next(&self) {
        self.with_conn(|c| {
            let _ = c.command(&["playlist-next"]);
        });
    }

    pub fn prev(&self) {
        self.with_conn(|c| {
            let _ = c.command(&["playlist-prev"]);
        });
    }

    pub fn seek(&self, secs: f64) {
        self.with_conn(|c| {
            let _ = c.request(&[json!("seek"), json!(secs), json!("absolute")]);
        });
    }

    pub fn set_volume(&self, vol: f64) {
        self.with_conn(|c| {
            let _ = c.set_prop("volume", vol);
        });
    }

    /// Persist the setting AND apply it to the running playlist (audit B13):
    /// on → mpv's `playlist-shuffle` (no playback interruption), then the Rust
    /// queue is re-synced from mpv's actual order; off → the pre-shuffle order
    /// is rebuilt, keeping the current track current.
    pub fn set_shuffle(&self, on: bool) {
        let was = self.settings.get().shuffle;
        self.settings.set_playback(Some(on), None, None);
        if was == on {
            return;
        }
        if on {
            let order = self.with_conn(|c| {
                let _ = c.command(&["playlist-shuffle"]);
                c.playlist_filenames()
            });
            let Some(order) = order else { return };
            if order.is_empty() {
                return;
            }
            let by_path: HashMap<String, i64> = self
                .db
                .get_tracks()
                .unwrap_or_default()
                .into_iter()
                .map(|t| (t.path, t.id))
                .collect();
            let ids: Vec<i64> = order.iter().filter_map(|p| by_path.get(p).copied()).collect();
            if !ids.is_empty() {
                *self.queue.lock().unwrap() = ids;
            }
        } else {
            self.restore_base_order();
        }
    }

    pub fn set_repeat(&self, mode: String) {
        self.settings.set_playback(None, Some(mode.clone()), None);
        self.with_conn(|c| {
            let (lp, lf) = match mode.as_str() {
                "one" => ("no", "inf"),
                "all" => ("inf", "no"),
                _ => ("no", "no"),
            };
            let _ = c.set_prop_str("loop-playlist", lp);
            let _ = c.set_prop_str("loop-file", lf);
        });
    }

    pub fn set_speed(&self, speed: f64) {
        self.settings.set_playback(None, None, Some(speed));
        self.with_conn(|c| {
            let _ = c.set_prop("speed", speed);
        });
    }

    pub fn state(&self) -> PlayerState {
        let (playing, position, duration, volume, idle, pos) = self
            .with_conn(|c| {
                let pause = c.get_bool("pause").unwrap_or(true);
                (
                    !pause,
                    c.get_f64("time-pos").ok().flatten().unwrap_or(0.0),
                    c.get_f64("duration").ok().flatten().unwrap_or(0.0),
                    c.get_f64("volume").ok().flatten().unwrap_or(100.0),
                    c.get_bool("idle-active").unwrap_or(true),
                    c.get_i64("playlist-pos").ok().flatten(),
                )
            })
            .unwrap_or((false, 0.0, 0.0, 100.0, true, None));

        // fetch ONLY the current track (audit B2). The old path cloned the
        // whole queue and ran `SELECT … WHERE id IN (…N…)` per 500ms poll —
        // 20k DB rows/sec sustained on a 10k library — to look up one row.
        let current = match pos {
            Some(p) if p >= 0 => {
                let id = self.queue.lock().unwrap().get(p as usize).copied();
                match id {
                    Some(id) => self.db.get_track(id).ok().flatten(),
                    None => None,
                }
            }
            _ => None,
        };
        let s = self.settings.get();
        PlayerState {
            playing,
            position,
            duration,
            volume,
            idle,
            current,
            shuffle: s.shuffle,
            repeat: s.repeat,
            speed: if s.speed > 0.0 { s.speed } else { 1.0 },
        }
    }

    pub fn shutdown(&self) {
        // stop the connect/fade background threads first (audit A6)
        self.shutdown_flag.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn af_from_settings(s: &Settings) -> String {
    match s.sound_effect.as_str() {
        "echo" => "aecho=0.6:0.6:250:0.4".to_string(),
        "reverb" => "lavfi=[aecho=0.8:0.9:500|1000|1500|2000:0.4|0.3|0.2|0.1]".to_string(),
        "tremolo" => "tremolo=5:0.5".to_string(),
        "vibrato" => "vibrato=5:0.5".to_string(),
        "phaser" => "aphaser=0.9:0.6:2:0.4:1".to_string(),
        "chorus" => "lavfi=[chorus=0.6:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3]".to_string(),
        _ => String::new(),
    }
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

/// Kill any mpv that's still alive from a previous Embertune run. Our mpv is
/// always launched with our unique IPC socket path, so matching on that plus
/// the process name is unambiguous and can never touch another player.
fn kill_stale_mpv(sock: &std::path::Path) {
    let sock_str = sock.to_string_lossy().to_string();
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return;
    };
    for e in rd.flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if pid <= 0 {
            continue;
        }
        let Ok(cmd) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        let prog = cmd
            .split('\0')
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        if prog == "mpv" && cmd.contains(&sock_str) {
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .status();
        }
    }
}

fn shuffle_vec<T>(v: &mut [T], seed: u64) {
    let mut s = seed | 1;
    if s == 0 {
        s = 0x9E3779B97F4A7C15;
    }
    for i in (1..v.len()).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let j = (s % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}
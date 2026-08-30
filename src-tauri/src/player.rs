use crate::db::{Db, Track};
use crate::settings::{Settings, SettingsStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

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
    queue: Mutex<Vec<i64>>,
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
        loop {
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

        std::thread::spawn(move || {
            let mut attempt = 0u32;
            loop {
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

        // Crossfade: a small poller ramps the volume down near the end of a
        // track and back up at the start of the next. One mpv instance, one
        // thread, ~80ms tick — negligible cost, no extra decode. Disabled until
        // the user flips the setting on.
        let fade_conn = conn_holder.clone();
        let fade_settings = settings.clone();
        std::thread::spawn(move || {
            let mut base = 100.0f64;
            let mut vol_cur = 100.0f64;
            loop {
                std::thread::sleep(Duration::from_millis(80));
                let s = fade_settings.get();
                let fade = s.fade_enabled;
                let fd = if s.fade_duration > 0.0 { s.fade_duration } else { 0.0 };
                let mut target: Option<f64> = None;
                let mut in_zone = false;
                {
                    let mut guard = fade_conn.lock().unwrap();
                    if let Some(c) = guard.as_mut() {
                        let paused = c.get_bool("pause").unwrap_or(true);
                        let pos = c.get_f64("time-pos").ok().flatten().unwrap_or(0.0);
                        let dur = c.get_f64("duration").ok().flatten().unwrap_or(0.0);
                        if !paused && fade && fd > 0.0 && dur > 0.0 {
                            if pos < fd {
                                // fade-in at the start of a track
                                in_zone = true;
                                target = Some(base * (pos / fd));
                            } else {
                                let remaining = dur - pos;
                                if remaining <= fd && remaining >= -0.5 {
                                    // fade-out before the next track takes over
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
                    // outside fade zones adopt mpv's current volume as the base,
                    // so the user's volume slider is never fought
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
        *self.queue.lock().unwrap() = rest.iter().map(|t| t.id).collect();
        if let Some(first) = rest.first() {
            let paths: Vec<String> = rest.iter().map(|t| t.path.clone()).collect();
            self.with_conn(|c| {
                let _ = c.command(&["playlist-clear"]);
                let _ = c.command(&["loadfile", &first.path, "replace"]);
                // guarantee playback always starts from the top of the track
                let _ = c.command(&["seek", "0", "absolute"]);
                for p in &paths[1..] {
                    let _ = c.command(&["loadfile", p, "append"]);
                }
                let _ = c.set_prop("pause", false);
            });
        }
    }

    pub fn toggle_play(&self) {
        self.with_conn(|c| {
            let paused = c.get_bool("pause").unwrap_or(true);
            let _ = c.set_prop("pause", !paused);
        });
    }

    pub fn stop(&self) {
        self.with_conn(|c| {
            let _ = c.command(&["stop"]);
            let _ = c.command(&["playlist-clear"]);
        });
        *self.queue.lock().unwrap() = Vec::new();
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

    pub fn set_shuffle(&self, on: bool) {
        self.settings.set_playback(Some(on), None, None);
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

    pub fn set_equalizer(&self, preset: String) {
        self.settings.set_eq_bands(eq_preset_bands(&preset));
        self.rebuild_af();
    }

    pub fn set_eq_bands(&self, bands: Vec<f64>) {
        self.settings.set_eq_bands(bands);
        self.rebuild_af();
    }

    pub fn set_effect(&self, effect: String) {
        self.settings.set_effect(Some(effect));
        self.rebuild_af();
    }

    fn rebuild_af(&self) {
        let s = self.settings.get();
        let af = af_from_settings(&s);
        self.with_conn(|c| {
            let _ = c.set_prop_str("af", &af);
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

        // fetch current track
        let ids: Vec<i64> = self.queue.lock().unwrap().clone();
        let by_id: HashMap<i64, Track> = self
            .db
            .get_tracks_by_ids(&ids)
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t.id, t))
            .collect();
        let current = match pos {
            Some(p) if p >= 0 => ids.get(p as usize).and_then(|id| by_id.get(id).cloned()),
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

/// 10 graphic-EQ bands (Hz), in order — must match the frontend panel.
pub const EQ_FREQS: [f64; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// Quick-set preset curves (dB per band, matching `EQ_FREQS`).
pub fn eq_preset_bands(preset: &str) -> Vec<f64> {
    match preset {
        "bass" => vec![7.0, 5.0, 3.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "treble" => vec![0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 4.0, 6.0, 6.0, 6.0],
        "pop" => vec![-2.0, -1.0, 1.0, 2.0, 3.0, 3.0, 4.0, 4.0, 3.0, 2.0],
        "rock" => vec![5.0, 4.0, 3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 4.0, 3.0],
        "vocal" => vec![1.0, 2.0, 3.0, 3.0, 4.0, 5.0, 4.0, 3.0, 2.0, 1.0],
        _ => vec![0.0; 10],
    }
}

fn eq_filter(bands: &[f64]) -> String {
    if bands.len() != EQ_FREQS.len() {
        return String::new();
    }
    bands
        .iter()
        .enumerate()
        .filter(|(_, g)| g.abs() > 0.05)
        .map(|(i, g)| format!("equalizer=f={}:t=q:w=1:g={:.1}", EQ_FREQS[i], g))
        .collect::<Vec<_>>()
        .join(",")
}

fn af_from_settings(s: &Settings) -> String {
    let eq = eq_filter(&s.eq_bands);
    let fx = match s.sound_effect.as_str() {
        "echo" => "aecho=0.6:0.6:250:0.4",
        "reverb" => "lavfi=[aecho=0.8:0.9:500|1000|1500|2000:0.4|0.3|0.2|0.1]",
        "tremolo" => "tremolo=5:0.5",
        "vibrato" => "vibrato=5:0.5",
        "phaser" => "aphaser=0.9:0.6:2:0.4:1",
        "chorus" => "lavfi=[chorus=0.6:0.9:50|60|40:0.4|0.32|0.3:0.25|0.4|0.3:2|2.3|1.3]",
        _ => "",
    };
    vec![eq, fx.to_string()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<String>>().join(",")
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
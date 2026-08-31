use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Tighten a file to owner-only permissions (audit SE1). No-op on non-Unix.
/// The settings file carries the Spotify client secret, so it must never be
/// world-readable regardless of the user's umask.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub spotify_client_id: Option<String>,
    pub spotify_client_secret: Option<String>,
    pub download_dir: Option<String>,
    pub quality: String,
    pub shuffle: bool,
    pub repeat: String,
    pub speed: f64,
    pub sleep_timer: Option<i64>,
    pub theme: String,
    pub fade_enabled: bool,
    pub fade_duration: f64,
    pub sound_effect: String,
    pub window_controls: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            spotify_client_id: None,
            spotify_client_secret: None,
            download_dir: None,
            quality: "best".into(),
            shuffle: false,
            repeat: "off".into(),
            speed: 1.0,
            sleep_timer: None,
            theme: "glass".into(),
            fade_enabled: false,
            fade_duration: 2.0,
            sound_effect: "off".into(),
            window_controls: false,
        }
    }
}

impl Settings {
    pub fn resolved_download_dir(&self) -> PathBuf {
        match &self.download_dir {
            Some(d) => PathBuf::from(d),
            None => dirs::audio_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
                .join("Embertune"),
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        // Migration: settings written before SE1 may be world-readable.
        // Tighten as soon as the store opens (best effort).
        restrict_perms(&path);
        let data = match fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Settings>(&s) {
                Ok(settings) => settings,
                Err(e) => {
                    eprintln!("settings.json parse error: {e} — using defaults");
                    // Preserve the corrupt file as a .bak so the user can inspect it.
                    let _ = fs::copy(&path, path.with_extension("json.bak"));
                    Settings::default()
                }
            },
            Err(_) => Settings::default(),
        };
        SettingsStore {
            path,
            data: Mutex::new(data),
        }
    }

    /// Atomic persist: write to a temp file then rename. Prevents corruption
    /// from crashes mid-write. The renamed file is tightened to 0o600 — it
    /// contains the Spotify client secret (audit SE1), and the rename would
    /// otherwise inherit the process umask (often world-readable).
    fn persist(&self, settings: &Settings) {
        let s = match serde_json::to_string_pretty(settings) {
            Ok(s) => s,
            Err(_) => return,
        };
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, &s).is_ok() {
            restrict_perms(&tmp);
            let _ = fs::rename(&tmp, &self.path);
            restrict_perms(&self.path); // rename may reset ownership/perms on some filesystems
        }
    }

    pub fn get(&self) -> Settings {
        self.data.lock().unwrap().clone()
    }

    pub fn set_spotify_creds(&self, id: Option<String>, secret: Option<String>) {
        let mut d = self.data.lock().unwrap();
        d.spotify_client_id = id;
        d.spotify_client_secret = secret;
        self.persist(&d);
    }

    pub fn set_download_dir(&self, dir: String) {
        let mut d = self.data.lock().unwrap();
        d.download_dir = Some(dir);
        self.persist(&d);
    }

    pub fn set_quality(&self, quality: String) {
        let mut d = self.data.lock().unwrap();
        d.quality = quality;
        self.persist(&d);
    }

    pub fn set_theme(&self, theme: String) {
        let mut d = self.data.lock().unwrap();
        d.theme = theme;
        self.persist(&d);
    }

    pub fn set_playback(&self, shuffle: Option<bool>, repeat: Option<String>, speed: Option<f64>) {
        let mut d = self.data.lock().unwrap();
        if let Some(s) = shuffle {
            d.shuffle = s;
        }
        if let Some(r) = repeat {
            d.repeat = r;
        }
        if let Some(s) = speed {
            d.speed = s;
        }
        self.persist(&d);
    }

    pub fn set_sleep_timer(&self, minutes: Option<i64>) {
        let mut d = self.data.lock().unwrap();
        d.sleep_timer = minutes;
        self.persist(&d);
    }

    /// No webview surface yet (audit Q6: the set_fade command was removed —
    /// no fade UI exists). Values remain readable from settings.json and the
    /// fade poller stays dormant until a UI ships.
    #[allow(dead_code)]
    pub fn set_fade(&self, enabled: bool, duration: f64) {
        let mut d = self.data.lock().unwrap();
        d.fade_enabled = enabled;
        if duration > 0.0 {
            d.fade_duration = duration;
        }
        self.persist(&d);
    }

    /// No webview surface yet (audit Q6: the set_effect command was removed
    /// — no sound-effect UI exists). Kept for future UI.
    #[allow(dead_code)]
    pub fn set_effect(&self, effect: Option<String>) {
        let mut d = self.data.lock().unwrap();
        if let Some(e) = effect {
            d.sound_effect = e;
        }
        self.persist(&d);
    }

    pub fn set_window_controls(&self, enabled: bool) {
        let mut d = self.data.lock().unwrap();
        d.window_controls = enabled;
        self.persist(&d);
    }
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("embertune")
}
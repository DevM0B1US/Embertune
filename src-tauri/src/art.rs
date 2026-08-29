use crate::settings::data_dir;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn art_dir() -> PathBuf {
    data_dir().join("art")
}

/// Deterministic art cache filename for a given audio file path.
pub fn art_path_for(track_path: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    track_path.hash(&mut h);
    art_dir().join(format!("{:016x}.jpg", h.finish()))
}

pub fn art_file_exists(track_path: &str) -> bool {
    art_path_for(track_path).is_file()
}

/// Best-effort: extract the embedded cover art from an audio file into the
/// cache dir using ffmpeg. Returns true if a cover was written.
pub fn extract_cover(track_path: &str) -> bool {
    let dir = art_dir();
    if !dir.is_dir() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let out = art_path_for(track_path);
    if out.is_file() {
        return true;
    }
    let tmp = out.with_extension("tmp.jpg");
    // Extraction is best-effort — files without embedded art fail here and that
    // is normal. Silence ffmpeg so those don't spam the terminal.
    let ok = Command::new("ffmpeg")
        .args([
            "-y",
            "-loglevel",
            "error",
            "-i",
            track_path,
            "-an",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "3",
            "-frames:v",
            "1",
            "-f",
            "mjpeg",
        ])
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok && tmp.is_file() {
        let _ = std::fs::rename(&tmp, &out);
        true
    } else {
        let _ = std::fs::remove_file(&tmp);
        false
    }
}
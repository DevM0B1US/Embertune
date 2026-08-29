use crate::settings::data_dir;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn art_dir() -> PathBuf {
    data_dir().join("art")
}

/// Deterministic art cache filename for a given audio file path.
/// Uses FNV-1a (deterministic across process restarts, unlike DefaultHasher
/// which randomizes seeds per process).
pub fn art_path_for(track_path: &str) -> PathBuf {
    let hash = fnv1a(track_path);
    art_dir().join(format!("{:016x}.jpg", hash))
}

/// FNV-1a 64-bit — deterministic, stable across runs, no external deps.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn art_path_is_deterministic() {
        let p1 = art_path_for("/home/user/Music/song.m4a");
        let p2 = art_path_for("/home/user/Music/song.m4a");
        assert_eq!(p1, p2);
    }

    #[test]
    fn different_paths_produce_different_hashes() {
        let p1 = art_path_for("/a.m4a");
        let p2 = art_path_for("/b.m4a");
        assert_ne!(p1, p2);
    }
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
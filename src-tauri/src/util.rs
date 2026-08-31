//! Shared helpers that used to live duplicated in `lib.rs` and
//! `downloader/mod.rs` (audit Q7/Q8/Q9). One definition each — no drift.

/// Audio extensions recognized when indexing files from disk.
pub fn is_audio_file(name: &str) -> bool {
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

/// "Artist - Title" stem splitter. Falls back to (empty, whole stem).
pub fn split_title(stem: &str) -> (String, String) {
    if let Some(i) = stem.find(" - ") {
        let artist = stem[..i].trim();
        let title = stem[i + 3..].trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    (String::new(), stem.to_string())
}

/// Current UNIX epoch seconds (0 if the clock is before the epoch).
pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_extensions() {
        for name in ["a.mp3", "b.FLAC", "c.Opus", "d.webm", "e.m4b"] {
            assert!(is_audio_file(name), "{name} should be audio");
        }
        for name in ["a.txt", "b.jpg", "c", "d.mp4", "e.exe"] {
            assert!(!is_audio_file(name), "{name} should NOT be audio");
        }
    }

    #[test]
    fn splits_on_artist_title_separator() {
        let (a, t) = split_title("Artist Name - Song Title");
        assert_eq!(a, "Artist Name");
        assert_eq!(t, "Song Title");
        // spaces around the separator are trimmed
        let (a, t) = split_title("Artist  -  Song");
        assert_eq!(a, "Artist");
        assert_eq!(t, "Song");
    }

    #[test]
    fn no_separator_falls_back_to_stem() {
        let (a, t) = split_title("Just A Title");
        assert_eq!(a, "");
        assert_eq!(t, "Just A Title");
        // " - " with an empty side is not treated as a separator
        let (a, t) = split_title("- Song");
        assert_eq!(a, "");
        assert_eq!(t, "- Song");
    }

    #[test]
    fn unix_now_is_plausible() {
        assert!(unix_now() > 1_700_000_000);
    }
}

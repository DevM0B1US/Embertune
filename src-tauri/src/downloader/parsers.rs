
/// Last `NN%` (0..=100) seen in a chunk of spotdl output.
pub(crate) fn last_percent(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    for i in (0..b.len()).rev() {
        if b[i] == b'%' {
            let mut j = i;
            while j > 0 && b[j - 1].is_ascii_digit() {
                j -= 1;
            }
            if j < i {
                if let Ok(n) = s[j..i].parse::<f64>() {
                    if (0.0..=100.0).contains(&n) {
                        return Some(n);
                    }
                }
            }
            return None;
        }
    }
    None
}

/// spotdl 4.x never prints a percent, but with `--simple-tui` it emits coarse
/// phase lines that map to its internal per-song progress steps
/// (25 → 40 → 70 → 95 → 100). Map the most recent phase seen to a percent so
/// the download UI shows live movement instead of hanging at "Downloading…".
pub(crate) fn spotdl_phase_percent(s: &str) -> Option<f64> {
    const PHASES: [(&str, f64); 5] = [
        ("Searching for song", 25.0),
        ("Getting audio meta", 40.0),
        ("Downloading", 70.0),
        ("Embedding metadata", 95.0),
        ("Done", 100.0),
    ];
    let mut best: Option<(usize, f64)> = None;
    for (marker, val) in PHASES {
        if let Some(pos) = s.rfind(marker) {
            if best.map(|(bp, _)| pos > bp).unwrap_or(true) {
                best = Some((pos, val));
            }
        }
    }
    best.map(|(_, v)| v)
}

/// Last filename-looking line (`.mp3`/`.m4a`/`.opus`/…) in a chunk of output.
pub(crate) fn last_dl_file(s: &str) -> Option<String> {
    const EXTS: [&str; 6] = ["mp3", "m4a", "opus", "flac", "ogg", "wav"];
    let mut best: Option<(usize, String)> = None;
    for ext in EXTS {
        let needle = format!(".{ext}");
        if let Some(idx) = s.rfind(&needle) {
            let start = s[..idx].rfind('\n').map(|p| p + 1).unwrap_or(0);
            let cand = s[start..idx + needle.len()].trim().to_string();
            if (3..200).contains(&cand.len()) {
                if best.as_ref().map(|(p, _)| idx + needle.len() > *p).unwrap_or(true) {
                    best = Some((idx + needle.len(), cand));
                }
            }
        }
    }
    best.map(|(_, c)| c)
}

/// spotdl's simple-tui logs every phase as `"{song}: {phase}"`
/// ("Artist - Title: Downloading"). Returns the last song name seen — the
/// track spotdl is currently working on.
pub(crate) fn spotdl_song_name(s: &str) -> Option<String> {
    // "Skipped" and "Error" are not download phases, but spotdl logs them the
    // same way ("Song: Skipped") and they carry the song name — without them
    // a mostly-skipped playlist re-download leaves the UI stuck on the generic
    // "working…" marker the whole time instead of showing what's being processed.
    const PHASES: [&str; 7] = [
        "Searching for song",
        "Getting audio meta",
        "Downloading",
        "Embedding metadata",
        "Done",
        "Skipped",
        "Error",
    ];
    let mut best: Option<(usize, String)> = None;
    for phase in PHASES {
        let marker = format!(": {phase}");
        if let Some(idx) = s.rfind(&marker) {
            let start = s[..idx].rfind('\n').map(|p| p + 1).unwrap_or(0);
            let name = s[start..idx].trim().to_string();
            if !name.is_empty() && name.len() < 200 {
                if best.as_ref().map(|(p, _)| idx > *p).unwrap_or(true) {
                    best = Some((idx, name));
                }
            }
        }
    }
    best.map(|(_, n)| n)
}

/// spotdl's simple-tui logs `"{done}/{total} complete"` whenever a song
/// finishes. Returns the latest (done, total) pair seen.
pub(crate) fn spotdl_complete(s: &str) -> Option<(usize, usize)> {
    const SUF: &str = " complete";
    let bytes = s.as_bytes();
    let mut best: Option<(usize, (usize, usize))> = None;
    let mut i = 0;
    while let Some(rel) = s[i..].find(SUF) {
        let end = i + rel;
        let mut k = end;
        while k > 0 && bytes[k - 1].is_ascii_digit() {
            k -= 1;
        }
        if k == end || k == 0 || bytes[k - 1] != b'/' {
            i = end + SUF.len();
            continue;
        }
        let total: usize = s[k..end].parse().unwrap_or(0);
        let mut l = k - 1;
        while l > 0 && bytes[l - 1].is_ascii_digit() {
            l -= 1;
        }
        if l == k - 1 {
            i = end + SUF.len();
            continue;
        }
        let done: usize = s[l..k - 1].parse().unwrap_or(0);
        if total > 0 && best.as_ref().map(|(p, _)| end > *p).unwrap_or(true) {
            best = Some((end, (done, total)));
        }
        i = end + SUF.len();
    }
    best.map(|(_, v)| v)
}

/// spotdl prints `Song already exists.` / `Skipping X (file already exists)` /
/// `X: Skipped` when a track is already on disk — nothing is downloaded and the
/// job should be shown as skipped.
pub(crate) fn spotdl_skipped(s: &str) -> bool {
    s.contains("already exists")
        || s.contains("already downloaded")
        || s.contains("Skipping")
        || s.contains(": Skipped")
}

/// Number of distinct skip lines seen so far in a spotdl output buffer. Each
/// skipped song logs exactly one line, so counting lines (not substrings) gives
/// an idempotent tally the caller can diff against a previous count to detect
/// newly-skipped songs without double-counting lines that match several
/// patterns at once (e.g. "Skipping X (file already exists)").
pub(crate) fn spotdl_skipped_count(s: &str) -> usize {
    s.lines()
        .filter(|l| {
            let l = l.trim();
            l.contains(": Skipped")
                || l.contains("Skipping ")
                || l.contains("already exists")
                || l.contains("already downloaded")
        })
        .count()
}

/// yt-dlp prints `[download] <title> has already been downloaded` when the
/// file is already on disk.
pub(crate) fn ytdlp_skipped(s: &str) -> bool {
    s.contains("has already been downloaded")
}

/// yt-dlp prints `[download] Downloading item 3 of 20` before each playlist
/// track. Returns the latest (current_item, total_items) pair seen.
pub(crate) fn ytdlp_item(s: &str) -> Option<(usize, usize)> {
    const MARK: &str = "Downloading item ";
    let mut best: Option<(usize, (usize, usize))> = None;
    let mut from = 0;
    while let Some(rel) = s[from..].find(MARK) {
        let start = from + rel + MARK.len();
        let rest = &s[start..];
        let num_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        if let Ok(done) = rest[..num_end].parse::<usize>() {
            let after = &rest[num_end..];
            if let Some(of) = after.strip_prefix(" of ") {
                let n2 = of.find(|c: char| !c.is_ascii_digit()).unwrap_or(of.len());
                if let Ok(total) = of[..n2].parse::<usize>() {
                    if total > 0 && best.as_ref().map(|(p, _)| start > *p).unwrap_or(true) {
                        best = Some((start, (done, total)));
                    }
                }
            }
        }
        from = start;
    }
    best.map(|(_, v)| v)
}


#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn complete_parses_done_total() {
        assert_eq!(spotdl_complete("3/20 complete"), Some((3, 20)));
        assert_eq!(spotdl_complete("1/1 complete\n"), Some((1, 1)));
        // with rich trailing spaces like real output
        assert_eq!(spotdl_complete("3/20 complete                    \n"), Some((3, 20)));
        assert_eq!(spotdl_complete("no counter here"), None);
    }

    #[test]
    fn song_name_parses_phase_lines() {
        assert_eq!(
            spotdl_song_name("Artist - Title: Downloading"),
            Some("Artist - Title".to_string())
        );
        assert_eq!(
            spotdl_song_name("Cup of Joe - Multo: Searching for song           \n"),
            Some("Cup of Joe - Multo".to_string())
        );
        assert_eq!(spotdl_song_name("1/1 complete"), None);
    }

    #[test]
    fn ytdlp_item_parses() {
        assert_eq!(ytdlp_item("[download] Downloading item 3 of 20"), Some((3, 20)));
        assert_eq!(ytdlp_item("no item here"), None);
    }

    #[test]
    fn skipped_detection() {
        assert!(spotdl_skipped("Song already exists."));
        assert!(spotdl_skipped("Skipping Rick Astley - Never Gonna Give You Up (file already exists)"));
        assert!(spotdl_skipped("Rick Astley - Never Gonna Give You Up: Skipped"));
        assert!(ytdlp_skipped("[download] Some Song has already been downloaded"));
        assert!(!spotdl_skipped("Downloading: Artist - Title"));
        assert!(!ytdlp_skipped("Downloading item 1 of 5"));
    }

    #[test]
    fn skipped_count_tallies_distinct_lines() {
        assert_eq!(spotdl_skipped_count(""), 0);
        assert_eq!(spotdl_skipped_count("Downloading: Artist - Title"), 0);
        assert_eq!(
            spotdl_skipped_count(
                "Song already exists.\n\
                 Artist A - Song 1: Skipped\n\
                 Skipping Artist B - Song 2 (file already exists)\n\
                 Artist C - Song 3: Downloading"
            ),
            3
        );
        // one line that matches several patterns still counts once
        assert_eq!(
            spotdl_skipped_count("Skipping X - Y (already exists already downloaded)"),
            1
        );
    }

    #[test]
    fn song_name_parses_skipped_line() {
        assert_eq!(
            spotdl_song_name("The Calling - Anything: Skipped").as_deref(),
            Some("The Calling - Anything")
        );
    }
}

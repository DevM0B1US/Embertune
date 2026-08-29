use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: i64,
    pub path: String,
    pub source_url: String,
    pub source: String,
    pub added_at: i64,
    pub favorite: bool,
}

pub struct NewTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: i64,
    pub path: String,
    pub source_url: String,
    pub source: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub track_count: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn new(db_path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tracks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                artist      TEXT DEFAULT '',
                album       TEXT DEFAULT '',
                duration    INTEGER DEFAULT 0,
                path        TEXT NOT NULL UNIQUE,
                source_url  TEXT DEFAULT '',
                source      TEXT DEFAULT '',
                added_at    INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlists (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id INTEGER NOT NULL,
                track_id    INTEGER NOT NULL,
                position    INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, track_id)
            );",
        )?;
        let _ = conn.execute_batch("ALTER TABLE tracks ADD COLUMN favorite INTEGER DEFAULT 0");
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn add_track(&self, t: &NewTrack) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM tracks WHERE path = ?1",
                params![t.path],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = exists {
            return Ok(id);
        }
        conn.execute(
            "INSERT INTO tracks (title, artist, album, duration, path, source_url, source, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                t.title,
                t.artist,
                t.album,
                t.duration,
                t.path,
                t.source_url,
                t.source,
                t.added_at
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<Track> {
        Ok(Track {
            id: r.get(0)?,
            title: r.get(1)?,
            artist: r.get(2)?,
            album: r.get(3)?,
            duration: r.get(4)?,
            path: r.get(5)?,
            source_url: r.get(6)?,
            source: r.get(7)?,
            added_at: r.get(8)?,
            favorite: r.get::<_, i64>(9)? != 0,
        })
    }

    const SELECT: &'static str =
        "SELECT id, title, artist, album, duration, path, source_url, source, added_at, favorite FROM tracks";

    pub fn get_tracks(&self) -> rusqlite::Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{} ORDER BY added_at DESC", Self::SELECT))?;
        let rows = stmt.query_map([], |r| Self::row_to_track(r))?;
        rows.collect()
    }

    pub fn update_duration(&self, id: i64, duration: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET duration = ?1 WHERE id = ?2",
            params![duration, id],
        )?;
        Ok(())
    }

    pub fn set_favorite(&self, id: i64, fav: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET favorite = ?1 WHERE id = ?2",
            params![fav as i64, id],
        )?;
        Ok(())
    }

    pub fn update_meta(
        &self,
        id: i64,
        title: String,
        artist: String,
        album: String,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET title = ?1, artist = ?2, album = ?3 WHERE id = ?4",
            params![title, artist, album, id],
        )?;
        Ok(())
    }

    pub fn get_track(&self, id: i64) -> rusqlite::Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{} WHERE id = ?1", Self::SELECT))?;
        let mut rows = stmt.query_map(params![id], |r| Self::row_to_track(r))?;
        rows.next().transpose()
    }

    pub fn track_id_by_path(&self, path: &str) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM tracks WHERE path = ?1",
            params![path],
            |r| r.get(0),
        )
        .optional()
    }

    pub fn track_id_by_source_url(&self, source_url: &str) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM tracks WHERE source_url = ?1 LIMIT 1",
            params![source_url],
            |r| r.get(0),
        )
        .optional()
    }

    /// Batch fetch preserving `ids` order — one query instead of N for the
    /// player's per-poll state refresh.
    pub fn get_tracks_by_ids(&self, ids: &[i64]) -> rusqlite::Result<Vec<Track>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("{} WHERE id IN ({})", Self::SELECT, placeholders);
        let mut stmt = conn.prepare(&sql)?;
        let rows =
            stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| Self::row_to_track(r))?;
        let fetched: Vec<Track> = rows.collect::<rusqlite::Result<_>>()?;
        let by_id: std::collections::HashMap<i64, Track> =
            fetched.into_iter().map(|t| (t.id, t)).collect();
        Ok(ids
            .iter()
            .filter_map(|id| by_id.get(id).cloned())
            .collect())
    }

    pub fn remove_track(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM playlist_tracks WHERE track_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // --- playlists ---
    pub fn create_playlist(&self, name: String, created_at: i64) -> rusqlite::Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlists (name, created_at) VALUES (?1, ?2)",
            params![name, created_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Creates a playlist, appending " (2)", " (3)"… when the name is taken so
    /// every downloaded playlist gets its own collection instead of merging
    /// into an existing one.
    pub fn create_playlist_unique(&self, base: String) -> rusqlite::Result<i64> {
        let existing: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT name FROM playlists")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut name = base.trim().to_string();
        if name.is_empty() {
            name = "Playlist".into();
        }
        if existing.iter().any(|n| n == &name) {
            let mut i = 2;
            loop {
                let cand = format!("{name} ({i})");
                if !existing.iter().any(|n| n == &cand) {
                    name = cand;
                    break;
                }
                i += 1;
            }
        }
        self.create_playlist(name, unix_now())
    }

    pub fn rename_playlist(&self, id: i64, name: String) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn delete_playlist(&self, id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn get_playlists(&self) -> rusqlite::Result<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.created_at, COUNT(pt.track_id)
             FROM playlists p
             LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
             GROUP BY p.id
             ORDER BY p.created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Playlist {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                track_count: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_to_playlist(&self, playlist_id: i64, track_id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
             VALUES (?1, ?2, ?3)",
            params![playlist_id, track_id, pos],
        )?;
        Ok(())
    }

    pub fn remove_from_playlist(&self, playlist_id: i64, track_id: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )?;
        Ok(())
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> rusqlite::Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "{} WHERE id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC)",
            Self::SELECT
        ))?;
        let rows = stmt.query_map(params![playlist_id], |r| Self::row_to_track(r))?;
        rows.collect()
    }
}
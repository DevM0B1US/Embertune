use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

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
            );",
        )?;
        let _ = conn.execute_batch("ALTER TABLE tracks ADD COLUMN favorite INTEGER DEFAULT 0");
        // hot-path indexes — speed ORDER BY added_at, lookups by path, favorites filter
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at DESC);
             CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
             CREATE INDEX IF NOT EXISTS idx_tracks_favorite ON tracks(favorite);",
        );
        // WAL mode for concurrent read/write, synchronous NORMAL for speed
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
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
        Ok(())
    }
}
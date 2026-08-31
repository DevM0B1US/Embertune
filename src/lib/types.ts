export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  path: string;
  source_url: string;
  source: string;
  added_at: number;
  favorite: boolean;
}

export interface JobView {
  id: number;
  url: string;
  kind: string;
  status: string;
  title: string;
  percent: number;
  downloaded: number;
  total: number;
  error: string | null;
  skipped: boolean;
  /** smoothed download rate (bytes/s), folded in by the downloads store */
  rate?: number;
}

export interface PlayerState {
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  idle: boolean;
  current: Track | null;
  shuffle: boolean;
  repeat: string;
  speed: number;
}

export interface SeekTarget {
  pct: number;
  secs: number;
  at: number;
}

export interface TrackMetaInfo {
  format: string;
  codec: string;
  bitrate: number;
  sample_rate: number;
  channels: number;
  duration: number;
  size: number;
}

export interface AppSettings {
  spotify_client_id: string | null;
  has_spotify_creds: boolean;
  quality: string;
  theme: string;
  window_controls: boolean;
}

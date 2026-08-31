// ═══════════════════════════════════════════════════════════════════
//  URL kind classification (audit B9) — pure module, shared by the
//  downloads store and unit tests. Mirrors the backend's `kind_of`
//  exactly: only real Spotify hosts/URIs are "spotify".
// ═══════════════════════════════════════════════════════════════════

export function kindOfUrl(url: string): "spotify" | "youtube" {
  return url.includes("open.spotify.com") || url.startsWith("spotify:")
    ? "spotify"
    : "youtube";
}

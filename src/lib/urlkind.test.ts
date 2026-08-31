import { describe, expect, it } from "vitest";
import { kindOfUrl } from "./urlkind";

describe("kindOfUrl (audit B9)", () => {
  it("classifies real Spotify links", () => {
    expect(kindOfUrl("https://open.spotify.com/track/abc")).toBe("spotify");
    expect(kindOfUrl("spotify:playlist:xyz")).toBe("spotify");
  });

  it("classifies YouTube links, even when 'spotify' appears in a query param", () => {
    // the old loose check (url.includes("spotify")) misclassified this
    expect(kindOfUrl("https://youtube.com/watch?v=spotify_playlist_review")).toBe("youtube");
    expect(kindOfUrl("https://youtu.be/abc")).toBe("youtube");
  });
});

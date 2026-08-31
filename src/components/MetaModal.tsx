import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { closeMeta, metaOpen, metaTrack } from "../lib/state/ui";
import { focusModal, trapModalFocus } from "../lib/modal";
import { refreshLibrary } from "../lib/state/library";
import { sndDone } from "../lib/sounds";
import { fmtDur } from "../lib/format";
import type { TrackMetaInfo } from "../lib/types";

export default function MetaModal() {
  let overlay!: HTMLDivElement;
  let titleInp!: HTMLInputElement;
  let artistInp!: HTMLInputElement;
  let albumInp!: HTMLInputElement;
  // undefined = loading, null = no metadata, else the info
  const [meta, setMeta] = createSignal<TrackMetaInfo | null | undefined>(undefined);

  // populate fields whenever a track is opened for editing
  createEffect(() => {
    const t = metaTrack();
    if (!t) return;
    titleInp.value = t.title;
    artistInp.value = t.artist || "";
    albumInp.value = t.album || "";
    setMeta(undefined);
    void (async () => {
      try {
        setMeta(await invoke<TrackMetaInfo | null>("get_track_meta", { trackId: t.id }));
      } catch {
        setMeta(null);
      }
    })();
  });

  const onOverlayClick = (e: MouseEvent): void => {
    if (e.target === overlay) closeMeta();
  };

  // focus management (audit U3)
  createEffect(() => focusModal(metaOpen(), overlay));
  onMount(() => onCleanup(trapModalFocus(overlay)));

  const bits = (b: number) => (b > 0 ? `${(b / 1000).toFixed(0)} kbps` : "—");
  const sz = (s: number) => (s > 0 ? `${(s / 1024 / 1024).toFixed(1)} MB` : "—");

  const save = () => {
    const t = metaTrack();
    if (!t) return;
    void (async () => {
      await invoke("update_track_meta", {
        id: t.id,
        title: titleInp.value.trim() || t.title,
        artist: artistInp.value.trim(),
        album: albumInp.value.trim(),
      });
      sndDone();
      closeMeta();
      await refreshLibrary();
    })();
  };

  return (
    <div ref={overlay} id="meta-overlay" classList={{ open: metaOpen() }} onClick={onOverlayClick}>
      <div class="settings-card meta-card" role="dialog" aria-modal="true" aria-label="Edit track">
        <h2>Edit track</h2>
        <label>
          Title <input ref={titleInp} id="meta-title" type="text" spellcheck={false} />
        </label>
        <label>
          Artist <input ref={artistInp} id="meta-artist" type="text" spellcheck={false} />
        </label>
        <label>
          Album <input ref={albumInp} id="meta-album" type="text" spellcheck={false} />
        </label>
        <div id="meta-details" class="meta-details">
          <Show when={meta() !== undefined} fallback="">
            <Show
              when={meta()}
              fallback={"No technical metadata available."}
            >
              {(m) => (
                <For
                  each={
                    [
                      ["Format", m().format || "—"],
                      ["Codec", m().codec || "—"],
                      ["Bitrate", bits(m().bitrate)],
                      ["Sample rate", m().sample_rate > 0 ? `${m().sample_rate} Hz` : "—"],
                      ["Channels", m().channels > 0 ? String(m().channels) : "—"],
                      ["Duration", m().duration > 0 ? fmtDur(m().duration) : "—"],
                      ["Size", sz(m().size)],
                    ] as Array<[string, string]>
                  }
                >
                  {([k, v]) => (
                    <div class="meta-row">
                      <span>{k}</span>
                      <b>{v}</b>
                    </div>
                  )}
                </For>
              )}
            </Show>
          </Show>
        </div>
        <div class="meta-btns">
          <button id="meta-cancel" class="btn" onClick={() => closeMeta()}>
            Cancel
          </button>
          <button id="meta-save" class="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

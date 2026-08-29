import { invoke } from "@tauri-apps/api/core";
import {
  $,
  esc,
  toast,
  promptDialog,
  confirmDialog,
  refreshIcons,
  sndOpen,
  sndClose,
  playlists,
  setPlaylists,
  currentPlaylist,
  setCurrentPlaylist,
  pendingAddTrack,
  setPendingAddTrack,
} from "./lib";
import { refreshLibrary } from "./library";
import { closeMenus } from "./lib";
import type { Playlist, Track } from "./lib";

// --- playlists ---
export async function refreshPlaylists(): Promise<void> {
  setPlaylists(await invoke<Playlist[]>("get_playlists"));
}

export function renderPlaylistsMenu(): void {
  const wrap = $("#playlists-list");
  wrap.innerHTML = "";
  for (const p of playlists) {
    const row = document.createElement("div");
    row.className = "menu-row";
    row.innerHTML = `
      <button class="menu-item open-pl" title="Open">${esc(p.name)} <span class="pl-count">${p.track_count}</span></button>
      <button class="pl-act" data-act="rename" title="Rename">✎</button>
      <button class="pl-act" data-act="del" title="Delete">🗑</button>
    `;
    row.querySelector(".open-pl")!.addEventListener("click", async () => {
      if (pendingAddTrack) {
        await invoke("add_to_playlist", { playlistId: p.id, trackId: pendingAddTrack.id });
        setPendingAddTrack(null);
        closeMenus();
        toast(`Added to "${p.name}"`);
        return;
      }
      closeMenus();
      void openPlaylist(p);
    });
    row.querySelector('[data-act="rename"]')!.addEventListener("click", async () => {
      const name = await promptDialog("Rename playlist", { initial: p.name, okText: "Rename" });
      if (name) {
        await invoke("rename_playlist", { id: p.id, name });
        await refreshPlaylists();
        renderPlaylistsMenu();
        if (currentPlaylist && currentPlaylist.id === p.id) {
          currentPlaylist.name = name;
          $("#lib-title").textContent = currentPlaylist.name;
        }
      }
    });
    row.querySelector('[data-act="del"]')!.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete playlist "${p.name}"?`))) return;
      await invoke("delete_playlist", { id: p.id });
      if (currentPlaylist && currentPlaylist.id === p.id) setCurrentPlaylist(null);
      await refreshPlaylists();
      renderPlaylistsMenu();
      await refreshLibrary();
    });
    wrap.appendChild(row);
  }
  refreshIcons();
}

$("#btn-new-playlist").addEventListener("click", async () => {
  const name = await promptDialog("New playlist", {
    message: "Name your playlist.",
    okText: "Create",
  });
  if (name) {
    const id = await invoke<number>("create_playlist", { name });
    await refreshPlaylists();
    renderPlaylistsMenu();
    if (pendingAddTrack) {
      await invoke("add_to_playlist", { playlistId: id, trackId: pendingAddTrack.id });
      setPendingAddTrack(null);
      toast("Added to playlist");
    }
  }
});

export function openPlaylistsFor(t: Track): void {
  setPendingAddTrack(t);
  const m = $("#playlists-menu");
  const opening = m.classList.toggle("hidden");
  if (opening) sndOpen();
  else sndClose();
  renderPlaylistsMenu();
}

export async function openPlaylist(p: Playlist): Promise<void> {
  setCurrentPlaylist({ id: p.id, name: p.name });
  await refreshLibrary();
}

$("#btn-back").addEventListener("click", async () => {
  setCurrentPlaylist(null);
  await refreshLibrary();
});

$("#btn-playlist-op").addEventListener("click", async () => {
  if (!currentPlaylist) return;
  const p = playlists.find((x) => x.id === currentPlaylist!.id);
  if (!p) return;
  const choice = await promptDialog("Playlist", {
    message: "Type 1 to rename, 2 to delete.",
    okText: "Go",
  });
  if (choice === "1") {
    const name = await promptDialog("Rename playlist", { initial: p.name, okText: "Rename" });
    if (name) {
      await invoke("rename_playlist", { id: p.id, name });
      currentPlaylist.name = name;
      await refreshPlaylists();
      await refreshLibrary();
    }
  } else if (choice === "2") {
    if (!(await confirmDialog(`Delete playlist "${p.name}"?`))) return;
    await invoke("delete_playlist", { id: p.id });
    setCurrentPlaylist(null);
    await refreshPlaylists();
    await refreshLibrary();
  }
});


import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Album, ArrowDownUp, ChevronLeft, ChevronRight, Clock3, Disc3, Download,
  Expand, Heart, Home, Library, ListMusic, ListPlus, Maximize2, Menu, Mic2,
  MoreHorizontal, Music2, Moon, Pause, Play, Plus, Radio, Repeat, Search, Shuffle, Sun,
  SkipBack, SkipForward, Sparkles, Trash2, Upload, Video, Volume1, Volume2,
  VolumeX, X
} from "lucide-react";
import "./spool.css";

const STORAGE_KEY = "spool-library-v1";
const uid = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
const todayStr = () => new Date().toISOString().slice(0, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const fmtTime = (sec) => {
  const safe = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};
const isYouTubeUrl = (url = "") => /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/)|youtu\.be\/)/i.test(String(url));
const getYouTubeId = (url = "") => {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || "";
    return u.searchParams.get("v") || "";
  } catch { return ""; }
};
const isYouTubeSong = (song) => String(song?.mediaType || "").toLowerCase() === "video/youtube" || isYouTubeUrl(song?.sourceUrl || "");
const isVideoFile = (song) => isYouTubeSong(song) || String(song?.mediaType || "").toLowerCase() === "video/mp4" || /\.mp4(?:$|[?#])/i.test(song?.audioUrl || "");
const isRemoteUrl = (url = "") => /^https?:\/\//i.test(url);
const remotePlaybackUrl = (url = "") => isRemoteUrl(url) && !isYouTubeUrl(url) ? `/api/media-proxy?url=${encodeURIComponent(url)}` : url;
const parseFilename = (name = "") => {
  const clean = name.replace(/\.(mp3|mp4|wav|ogg|m4a|aac|flac)$/i, "").replace(/[._]+/g, " ").trim();
  const match = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return match ? { singer: match[1].trim(), name: match[2].trim() } : { singer: "", name: clean || "Untitled" };
};

async function enrichTrack(data) {
  const params = new URLSearchParams({
    name: data.name || "",
    artist: data.singer || "",
    album: data.album || "",
    duration: String(Number(data.duration) || 0),
  });
  const res = await fetch(`/api/enrich?${params.toString()}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Could not detect track details.");
  return body;
}

function readLocalMediaMeta(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const el = file.type === "video/mp4" || /\.mp4$/i.test(file.name) ? document.createElement("video") : document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? Math.round(el.duration) : 0;
      URL.revokeObjectURL(objectUrl);
      el.remove();
      resolve(duration);
    };
    el.onerror = () => { URL.revokeObjectURL(objectUrl); el.remove(); resolve(0); };
    el.src = objectUrl;
  });
}
const textAvatar = (name = "S") => (name.trim()[0] || "S").toUpperCase();

const defaultCover = (song) => {
  const key = encodeURIComponent(`${song?.name || "Spool"}-${song?.singer || "Music"}`);
  return `https://picsum.photos/seed/${key}/700/700`;
};

const seedSongs = () => [];
const seedLibrary = () => ({ songs: [], playlists: [], playHistory: {}, deletedSongIds: [], _updatedAt: 0, _version: 2 });

function libraryUpdatedAt(library) {
  return Number(library?._updatedAt) || 0;
}

function recordUpdatedAt(song) {
  return Number(song?._updatedAt) || Number(song?.addedAt) || 0;
}

function mergeLibraries(localValue, serverValue) {
  const local = localValue && typeof localValue === "object" ? localValue : seedLibrary();
  const server = serverValue && typeof serverValue === "object" ? serverValue : seedLibrary();
  const localSongs = Array.isArray(local.songs) ? local.songs : [];
  const serverSongs = Array.isArray(server.songs) ? server.songs : [];
  const byId = new Map();
  serverSongs.forEach((song) => byId.set(song.id, song));
  localSongs.forEach((song) => {
    const existing = byId.get(song.id);
    if (!existing || recordUpdatedAt(song) >= recordUpdatedAt(existing)) byId.set(song.id, song);
  });

  const deleted = new Set([
    ...(Array.isArray(server.deletedSongIds) ? server.deletedSongIds : []),
    ...(Array.isArray(local.deletedSongIds) ? local.deletedSongIds : []),
  ]);
  deleted.forEach((id) => byId.delete(id));

  const playlistMap = new Map();
  [...server.playlists, ...local.playlists].forEach((playlist) => {
    if (playlist?.id && !playlistMap.has(playlist.id)) playlistMap.set(playlist.id, playlist);
  });
  const songIds = new Set(byId.keys());
  const playlists = [...playlistMap.values()].map((playlist) => ({
    ...playlist,
    songIds: Array.isArray(playlist.songIds) ? playlist.songIds.filter((id) => songIds.has(id)) : [],
  }));

  const playHistory = { ...(server.playHistory || {}), ...(local.playHistory || {}) };
  const merged = {
    ...server,
    ...local,
    songs: [...byId.values()],
    playlists,
    playHistory,
    deletedSongIds: [...deleted],
    _version: 2,
  };
  merged._updatedAt = Math.max(libraryUpdatedAt(local), libraryUpdatedAt(server));
  return merged;
}

function normalizeSongRecord(song) {
  if (!song || typeof song !== "object") return song;
  let name = String(song.name || "Untitled").trim();
  // Repair records created by older online-import logic that accidentally saved
  // a full lyrics/video-page title as the track name.
  if (name.length > 140 || /^\[?lyrics?\s+of/i.test(name)) {
    const quoted = name.match(/"([^"\n]{2,120})"/);
    if (quoted?.[1]) name = quoted[1].trim();
    else name = name.replace(/^\[?lyrics?[^:]*[:\-]?/i, "").split(/\r?\n|\s+\[Verse|\s+\[Chorus/i)[0].trim().slice(0, 120);
  }
  let singer = String(song.singer || "Unknown artist").trim() || "Unknown artist";
  let album = String(song.album || "Single").trim() || "Single";
  if (/^youtube$/i.test(singer)) singer = "Online source";
  if (/^youtube$/i.test(album)) album = "Online";
  return { ...song, name: name || "Untitled", singer, album };
}

function parseLyrics(raw = "", duration = 0, sourceDuration = 0) {
  const lines = String(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const lrc = [];
  const re = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
  lines.forEach((line) => {
    const tags = [...line.matchAll(re)];
    const text = line.replace(re, "").trim() || "♪";
    if (tags.length) tags.forEach((tag) => lrc.push({ time: Number(tag[1]) * 60 + Number(tag[2]), text }));
  });
  if (lrc.length) {
    const sorted = lrc.sort((a, b) => a.time - b.time);
    // When the lyric source and actual media are slightly different edits,
    // apply a conservative time stretch only for small duration drift.
    // Large mismatches are left untouched because scaling those can make a
    // correctly matched lyric set worse.
    const source = Number(sourceDuration) || 0;
    const actual = Number(duration) || 0;
    const ratio = source > 0 && actual > 0 ? actual / source : 1;
    if (ratio >= 0.90 && ratio <= 1.10 && Math.abs(actual - source) > 0.75) {
      return sorted.map((line) => ({ ...line, time: line.time * ratio }));
    }
    return sorted;
  }
  const spacing = duration > 0 ? duration / Math.max(lines.length, 1) : 5;
  return lines.map((text, index) => ({ time: index * spacing, text }));
}


async function uploadMediaFile(file) {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Media upload failed.");
  return body;
}


function downloadRemoteMedia(url, filename = 'spool-track') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/download?url=${encodeURIComponent(url)}`);
    xhr.responseType = 'blob';
    xhr.onprogress = (event) => {
      if (event.lengthComputable) window.dispatchEvent(new CustomEvent('spool-download-progress', { detail: event.loaded / event.total }));
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('Download failed.'));
      const blob = xhr.response;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 140) || 'spool-track';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      resolve();
    };
    xhr.onerror = () => reject(new Error('Network error while downloading.'));
    xhr.send();
  });
}

let youtubeApiPromise = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-spool-youtube-api]');
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    if (existing) return;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.spoolYoutubeApi = 'true';
    script.onerror = () => reject(new Error('YouTube player could not be loaded.'));
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

export default function SpoolApp() {
  const [lib, setLib] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ kind: "home" });
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("recent");
  const [currentId, setCurrentId] = useState(null);
  const [queueIds, setQueueIds] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeat] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [volume, setVolume] = useState(0.78);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [addToPlaylistFor, setAddToPlaylistFor] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [onlineResults, setOnlineResults] = useState([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("spool-theme") || "dark");
  const mediaRef = useRef(null);
  const youtubeSeekRef = useRef(null);
  const lyricsRef = useRef(null);
  const libRef = useRef(null);
  const storageWriteRef = useRef(Promise.resolve());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("spool-theme", theme);
  }, [theme]);

  const bootRef = useRef(false);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      try {
        let serverValue = null;
        try {
          const res = await window.storage.get(STORAGE_KEY, false);
          if (res?.value) serverValue = JSON.parse(res.value);
        } catch {}

        let localValue = null;
        try {
          const browserBackup = localStorage.getItem(STORAGE_KEY);
          if (browserBackup) localValue = JSON.parse(browserBackup);
        } catch {}

        const merged = mergeLibraries(localValue, serverValue);
        const cleanedSongs = (merged.songs || [])
          .map(normalizeSongRecord)
          .filter((song) => song?.source !== "online-preview")
          .filter((song) => song?.audioUrl || song?.sourceUrl);
        const cleanedIds = new Set(cleanedSongs.map((song) => song.id));
        const cleanedPlaylists = (merged.playlists || [])
          .map((p) => ({ ...p, songIds: Array.isArray(p.songIds) ? p.songIds.filter((id) => cleanedIds.has(id)) : [] }))
          .filter((p) => p.name !== 'Night Drive');
        const nextLibrary = {
          ...merged,
          songs: cleanedSongs,
          playlists: cleanedPlaylists,
          playHistory: merged.playHistory || {},
          deletedSongIds: Array.isArray(merged.deletedSongIds) ? merged.deletedSongIds : [],
          _version: 2,
          _updatedAt: Math.max(libraryUpdatedAt(merged), Date.now()),
        };

        libRef.current = nextLibrary;
        setLib(nextLibrary);
        const serialized = JSON.stringify(nextLibrary);
        try { localStorage.setItem(STORAGE_KEY, serialized); } catch {}
        storageWriteRef.current = storageWriteRef.current
          .catch(() => {})
          .then(() => window.storage.set(STORAGE_KEY, serialized, false))
          .catch(() => {});
      } catch {
        const fallback = seedLibrary();
        libRef.current = fallback;
        setLib(fallback);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback)); } catch {}
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (lib) libRef.current = lib;
  }, [lib]);

  const persist = useCallback((nextOrUpdater) => {
    const previous = libRef.current || seedLibrary();
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(previous) : nextOrUpdater;
    if (!next) return previous;

    const stamped = {
      ...next,
      _version: 2,
      _updatedAt: Date.now(),
    };
    libRef.current = stamped;
    setLib(stamped);

    const serialized = JSON.stringify(stamped);
    // Keep a browser backup as well as SQLite. This prevents a temporary
    // server/network failure from making library changes appear to vanish.
    try { localStorage.setItem(STORAGE_KEY, serialized); } catch {}
    storageWriteRef.current = storageWriteRef.current
      .catch(() => {})
      .then(() => window.storage.set(STORAGE_KEY, serialized, false))
      .catch(() => {});
    return next;
  }, []);

  const currentSong = useMemo(() => lib?.songs.find((song) => song.id === currentId) || null, [lib, currentId]);
  const currentLyrics = useMemo(() => parseLyrics(currentSong?.lyrics, duration || currentSong?.duration, currentSong?.lyricsDuration), [currentSong?.lyrics, currentSong?.duration, currentSong?.lyricsDuration, duration]);
  const activeLyricIndex = useMemo(() => {
    let active = -1;
    for (let i = 0; i < currentLyrics.length; i += 1) if (elapsed + 0.15 >= currentLyrics[i].time) active = i;
    return active;
  }, [currentLyrics, elapsed]);

  useEffect(() => {
    const el = lyricsRef.current?.querySelector(`[data-line="${activeLyricIndex}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLyricIndex]);

  const registerPlay = useCallback((songId) => {
    persist((prev) => {
      const day = todayStr();
      const playHistory = { ...prev.playHistory, [songId]: { ...(prev.playHistory?.[songId] || {}), [day]: ((prev.playHistory?.[songId] || {})[day] || 0) + 1 } };
      const songs = prev.songs.map((s) => s.id === songId ? { ...s, playCount: (s.playCount || 0) + 1 } : s);
      return { ...prev, songs, playHistory };
    });
  }, [persist]);

  const playSong = useCallback((songId, ctx = null) => {
    if (!lib) return;
    const song = lib.songs.find((s) => s.id === songId);
    if (!song?.audioUrl && !isYouTubeSong(song)) {
      setToast("This track has no playable media. Add an MP3, MP4 or YouTube link.");
      return;
    }
    setQueueIds(ctx?.length ? ctx : lib.songs.map((s) => s.id));
    if (currentId !== songId) {
      setCurrentId(songId);
      setElapsed(0);
      registerPlay(songId);
    }
    setPlaying(true);
    if (isVideoFile(song)) setVideoOpen(true);
  }, [lib, currentId, registerPlay]);

  const advance = useCallback((direction) => {
    if (!lib?.songs.length) return;
    const playable = (queueIds.length ? queueIds : lib.songs.map((s) => s.id))
      .filter((id) => { const song = lib.songs.find((s) => s.id === id); return song?.audioUrl || isYouTubeSong(song); });
    const pool = playable;
    if (!pool.length) return;
    let nextId;
    if (shuffle && pool.length > 1) {
      const choices = pool.filter((id) => id !== currentId);
      nextId = choices[Math.floor(Math.random() * choices.length)];
    } else {
      const idx = Math.max(0, pool.indexOf(currentId));
      nextId = pool[(idx + direction + pool.length) % pool.length];
    }
    setCurrentId(nextId);
    setElapsed(0);
    setPlaying(true);
    registerPlay(nextId);
    const nextSong = lib.songs.find((s) => s.id === nextId);
    if (isVideoFile(nextSong)) setVideoOpen(true);
  }, [lib, queueIds, currentId, shuffle, registerPlay]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    media.volume = volume;
    if (!currentSong?.audioUrl) {
      media.pause();
      media.removeAttribute("src");
      media.load();
      return;
    }
    if (media.getAttribute("src") !== currentSong.audioUrl) {
      media.src = currentSong.audioUrl;
      media.currentTime = 0;
      media.load();
    }
    if (playing) media.play().catch(() => setPlaying(false));
    else media.pause();
  }, [currentSong?.id, currentSong?.audioUrl, playing, volume]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media) media.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (videoOpen) setVideoOpen(false);
      if (lyricsOpen) setLyricsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [videoOpen, lyricsOpen]);

  const downloadSong = useCallback(async (song) => {
    if (!song) return;
    if (isYouTubeSong(song)) {
      setToast("Full downloads are not available for YouTube sources. Use a direct media link or upload the file.");
      return;
    }
    const source = song.sourceUrl && isRemoteUrl(song.sourceUrl) ? song.sourceUrl : song.audioUrl;
    if (!source) {
      setToast("This track has no downloadable media source.");
      return;
    }
    try {
      const extMatch = String(source).match(/\.(mp4|mp3|m4a|aac|flac|wav|ogg)(?:[?#]|$)/i);
      const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : (isVideoFile(song) ? ".mp4" : ".mp3");
      if (String(source).startsWith("/media/")) {
        const a = document.createElement("a");
        a.href = source;
        a.download = `${song.name} - ${song.singer}${ext}`.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 140);
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        await downloadRemoteMedia(source, `${song.name} - ${song.singer}${ext}`);
      }
      setToast(`Downloaded “${song.name}”`);
    } catch (error) {
      setToast(error.message || "Download failed.");
    }
  }, []);

  const toggleFavorite = (songId) => persist((prev) => ({
    ...prev,
    songs: prev.songs.map((s) => s.id === songId ? { ...s, favorite: !s.favorite, _updatedAt: Date.now() } : s),
  }));
  const deleteSong = (songId) => {
    persist((prev) => ({
      ...prev,
      songs: prev.songs.filter((s) => s.id !== songId),
      deletedSongIds: [...new Set([...(prev.deletedSongIds || []), songId])],
      playlists: prev.playlists.map((p) => ({ ...p, songIds: p.songIds.filter((id) => id !== songId) })),
    }));
    if (currentId === songId) { setCurrentId(null); setPlaying(false); setVideoOpen(false); }
  };
  const addSong = (data, autoPlay = false) => {
    const now = Date.now();
    const song = { id: uid(), playCount: 0, favorite: false, addedAt: now, _updatedAt: now, mood: "Unknown", album: "Single", lyrics: "", ...data };
    if (song.sourceUrl && isRemoteUrl(song.sourceUrl)) song.audioUrl = remotePlaybackUrl(song.sourceUrl);
    persist((prev) => ({ ...prev, songs: [song, ...prev.songs] }));
    if (autoPlay) {
      setQueueIds([song.id]);
      setCurrentId(song.id);
      setElapsed(0);
      setPlaying(true);
      if (isVideoFile(song)) setVideoOpen(true);
    }
    setToast(`Added “${song.name}” to your library`);
    return song;
  };
  const createPlaylist = (name) => {
    const clean = name.trim();
    if (!clean) return;
    persist((prev) => ({ ...prev, playlists: [...prev.playlists, { id: uid(), name: clean, description: "Your custom mix", songIds: [] }] }));
  };
  const addSongToPlaylist = (playlistId, songId) => {
    persist((prev) => ({ ...prev, playlists: prev.playlists.map((p) => p.id === playlistId ? { ...p, songIds: p.songIds.includes(songId) ? p.songIds : [...p.songIds, songId] } : p) }));
    setAddToPlaylistFor(null);
    setToast("Added to playlist");
  };

  const addOnlineTrack = useCallback(async (track) => {
    const sourceUrl = track.sourceUrl || track.audioUrl || "";
    const youtube = isYouTubeUrl(sourceUrl);
    try {
      const detected = await enrichTrack({ name: track.name, singer: track.singer, album: track.album, duration: track.duration });
      addSong({
        ...track,
        ...detected,
        sourceUrl,
        audioUrl: youtube ? "" : (track.audioUrl || sourceUrl),
        mediaType: youtube ? "video/youtube" : (track.mediaType || "audio/mpeg"),
        coverUrl: detected.coverUrl || track.coverUrl || "",
      }, true);
    } catch {
      addSong({
        ...track,
        sourceUrl,
        audioUrl: youtube ? "" : (track.audioUrl || sourceUrl),
        mediaType: youtube ? "video/youtube" : (track.mediaType || "audio/mpeg"),
      }, true);
    }
  }, [addSong]);

  const searchOnline = useCallback(async (value) => {
    const term = value.trim();
    if (term.length < 2) { setOnlineResults([]); return; }
    setOnlineLoading(true);
    try {
      const res = await fetch(`/api/online-search?q=${encodeURIComponent(term)}`);
      const body = await res.json();
      setOnlineResults(res.ok ? body.results || [] : []);
    } catch { setOnlineResults([]); }
    finally { setOnlineLoading(false); }
  }, []);

  useEffect(() => {
    if (view.kind !== "search") return undefined;
    const timer = setTimeout(() => searchOnline(query), 450);
    return () => clearTimeout(timer);
  }, [query, view.kind, searchOnline]);

  const localSongs = useMemo(() => {
    if (!lib) return [];
    let songs = [...lib.songs];
    if (view.kind === "favorites") songs = songs.filter((s) => s.favorite);
    if (view.kind === "playlist") {
      const pl = lib.playlists.find((p) => p.id === view.id);
      songs = (pl?.songIds || []).map((id) => lib.songs.find((s) => s.id === id)).filter(Boolean);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      songs = songs.filter((s) => [s.name, s.singer, s.album, s.mood].some((v) => String(v || "").toLowerCase().includes(q)));
    }
    if (sortKey === "name") songs.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortKey === "artist") songs.sort((a, b) => a.singer.localeCompare(b.singer));
    else if (sortKey === "popular") songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    else songs.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return songs;
  }, [lib, view, query, sortKey]);

  const popular = useMemo(() => [...(lib?.songs || [])].sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 5), [lib]);
  const favourites = useMemo(() => (lib?.songs || []).filter((s) => s.favorite).slice(0, 6), [lib]);

  if (!loaded || !lib) return <Splash />;

  const playlist = view.kind === "playlist" ? lib.playlists.find((p) => p.id === view.id) : null;
  const pageTitle = view.kind === "favorites" ? "Liked Songs" : view.kind === "playlist" ? playlist?.name || "Playlist" : view.kind === "search" ? "Search" : view.kind === "library" ? "Your Library" : "Home";

  return (
    <div className={`spool-shell ${videoOpen ? "video-open" : ""} ${lyricsOpen ? "lyrics-open" : ""}`}>
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Disc3 size={22}/></div><div><strong>Spool</strong><span>music player</span></div></div>
        <nav className="side-nav">
          <NavItem icon={<Home/>} label="Home" active={view.kind === "home"} onClick={() => { setView({kind:"home"}); setMobileNav(false); }}/>
          <NavItem icon={<Search/>} label="Search" active={view.kind === "search"} onClick={() => { setView({kind:"search"}); setMobileNav(false); }}/>
          <NavItem icon={<Library/>} label="Your Library" active={view.kind === "library"} onClick={() => { setView({kind:"library"}); setMobileNav(false); }}/>
          <NavItem icon={<Heart/>} label="Liked Songs" active={view.kind === "favorites"} onClick={() => { setView({kind:"favorites"}); setMobileNav(false); }}/>
        </nav>
        <div className="side-section-head"><span>Playlists</span><button onClick={() => setPlaylistOpen(true)} title="Create playlist"><Plus size={16}/></button></div>
        <div className="playlist-nav">
          {lib.playlists.map((p) => <button key={p.id} className={view.kind === "playlist" && view.id === p.id ? "active" : ""} onClick={() => { setView({kind:"playlist", id:p.id}); setMobileNav(false); }}><ListMusic size={16}/><span>{p.name}</span><small>{p.songIds.length}</small></button>)}
        </div>
        <div className="sidebar-card">
          <div className="sidebar-card-icon"><Sparkles size={18}/></div>
          <strong>Your music. Your space.</strong>
          <p>Upload audio or video, sync lyrics, and keep your library local.</p>
          <button onClick={() => setAddOpen(true)}><Plus size={15}/> Add music</button>
        </div>
        <div className="profile-mini"><div className="avatar">S</div><div><strong>Spool Listener</strong><span>Local profile</span></div><MoreHorizontal size={18}/></div>
      </aside>
      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close menu"/>}

      <main className="main-area">
        <header className="topbar">
          <div className="top-left"><button className="icon-btn mobile-menu" onClick={() => setMobileNav(true)}><Menu/></button><button className="icon-btn"><ChevronLeft/></button><button className="icon-btn"><ChevronRight/></button></div>
          <div className="searchbox"><Search size={18}/><input value={query} onFocus={() => view.kind === "home" && setView({kind:"search"})} onChange={(e) => setQuery(e.target.value)} placeholder="Search songs, artists, albums…"/>{query && <button onClick={() => setQuery("")}><X size={16}/></button>}</div>
          <div className="top-actions"><button className="theme-toggle" onClick={() => setTheme((v) => v === "dark" ? "light" : "dark")} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <Sun size={17}/> : <Moon size={17}/>}</button><button className="soft-btn" onClick={() => setAddOpen(true)}><Plus size={17}/><span>Add music</span></button><div className="avatar">S</div></div>
        </header>

        <div className="content-scroll">
          {view.kind === "home" ? (
            <HomeView songs={lib.songs} popular={popular} favourites={favourites} onPlay={playSong} onFav={toggleFavorite} onOpenLibrary={() => setView({kind:"library"})}/>
          ) : view.kind === "search" ? (
            <SearchView query={query} localSongs={localSongs} onlineResults={onlineResults} loading={onlineLoading} onPlay={playSong} onFav={toggleFavorite} onAddOnline={addOnlineTrack} onPlaylist={(id) => setAddToPlaylistFor(id)}/>
          ) : (
            <LibraryView title={pageTitle} subtitle={playlist?.description || (view.kind === "favorites" ? `${localSongs.length} songs you love` : `${localSongs.length} songs in your collection`)} songs={localSongs} sortKey={sortKey} setSortKey={setSortKey} onPlay={playSong} onFav={toggleFavorite} onDelete={deleteSong} onPlaylist={(id) => setAddToPlaylistFor(id)} onAdd={() => setAddOpen(true)}/>
          )}
        </div>
      </main>

      <NowPlayingBar song={currentSong} playing={playing} elapsed={elapsed} duration={duration || currentSong?.duration || 0} volume={volume} repeat={repeat} shuffle={shuffle}
        onToggle={() => currentSong && setPlaying((p) => !p)} onPrev={() => advance(-1)} onNext={() => advance(1)} onRepeat={() => setRepeat((v) => !v)} onShuffle={() => setShuffle((v) => !v)} onVolume={setVolume}
        onSeek={(value) => { const media = mediaRef.current; if (isYouTubeSong(currentSong)) youtubeSeekRef.current?.(value); else if (media && Number.isFinite(media.duration)) media.currentTime = value; setElapsed(value); }}
        onFav={() => currentSong && toggleFavorite(currentSong.id)} onDownload={() => downloadSong(currentSong)} onLyrics={() => setLyricsOpen((v) => !v)} onVideo={() => setVideoOpen((v) => !v)} videoOpen={videoOpen}/>

      {currentSong && isYouTubeSong(currentSong) ? (
        <YouTubePlayer videoId={getYouTubeId(currentSong.sourceUrl || currentSong.audioUrl)} playing={playing} volume={volume} videoOpen={videoOpen} seekRef={youtubeSeekRef}
          onTimeUpdate={setElapsed} onDuration={(d) => setDuration(d || currentSong.duration || 0)}
          onPlayingChange={setPlaying} onEnded={() => { if (repeat) { youtubeSeekRef.current?.(0); setPlaying(true); } else advance(1); }} />
      ) : currentSong && isVideoFile(currentSong) ? (
        <video ref={mediaRef} className={videoOpen ? "video-stage-media" : "media-engine-hidden"} src={currentSong.audioUrl || undefined} playsInline
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime || 0)} onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration || currentSong.duration || 0); }}
          onEnded={() => { if (repeat) { eSafeRestart(mediaRef.current); } else advance(1); }} />
      ) : (
        <audio ref={mediaRef} className="media-engine-hidden" src={currentSong?.audioUrl || undefined}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime || 0)} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || currentSong?.duration || 0)}
          onEnded={() => { if (repeat) eSafeRestart(mediaRef.current); else advance(1); }} />
      )}

      {videoOpen && currentSong && isVideoFile(currentSong) && <VideoModal song={currentSong} playing={playing} onToggle={() => setPlaying((p) => !p)} onClose={() => setVideoOpen(false)} />}
      {lyricsOpen && <LyricsPanel song={currentSong} lyrics={currentLyrics} activeIndex={activeLyricIndex} refEl={lyricsRef} onClose={() => setLyricsOpen(false)} onJump={(t) => { if (isYouTubeSong(currentSong)) youtubeSeekRef.current?.(t); else if (mediaRef.current) mediaRef.current.currentTime = t; setElapsed(t); }}/>} 
      {addOpen && <AddMusicModal onClose={() => setAddOpen(false)} onAdd={addSong}/>} 
      {playlistOpen && <CreatePlaylistModal onClose={() => setPlaylistOpen(false)} onCreate={createPlaylist}/>} 
      {addToPlaylistFor && <PlaylistPicker playlists={lib.playlists} onClose={() => setAddToPlaylistFor(null)} onPick={(pid) => addSongToPlaylist(pid, addToPlaylistFor)} onCreate={() => { setAddToPlaylistFor(null); setPlaylistOpen(true); }}/>} 
      {toast && <div className="toast"><Sparkles size={16}/>{toast}</div>}
    </div>
  );
}

function eSafeRestart(media) { if (!media) return; media.currentTime = 0; media.play().catch(() => {}); }

function Splash() { return <div className="splash"><div className="brand-mark big"><Disc3/></div><strong>Spool</strong><span>Loading your sound…</span></div>; }
function NavItem({ icon, label, active, onClick }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>{React.cloneElement(icon, {size:19})}<span>{label}</span></button>; }

function HomeView({ songs, popular, favourites, onPlay, onFav, onOpenLibrary }) {
  const recent = [...songs].sort((a,b) => (b.addedAt||0)-(a.addedAt||0)).slice(0,6);
  return <div className="page home-page">
    <section className="hero">
      <div className="hero-copy"><span className="eyebrow"><Sparkles size={14}/> MADE FOR YOUR MOMENT</span><h1>Turn the room into<br/><em>your soundtrack.</em></h1><p>A private, beautiful player for your audio, music videos and time-synced lyrics.</p><div className="hero-actions"><button className="primary-btn" onClick={() => recent[0] && onPlay(recent[0].id, recent.map(s=>s.id))}><Play size={17} fill="currentColor"/>Play recent</button><button className="glass-btn" onClick={onOpenLibrary}><Library size={17}/>Open library</button></div></div>
      <div className="hero-visual"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="hero-disc"><div className="disc-grooves"/><Disc3 size={54}/></div><div className="hero-float one"><Music2 size={17}/><span>Lossless-ready player</span></div><div className="hero-float two"><Mic2 size={17}/><span>Synced lyrics</span></div></div>
    </section>
    <SectionHeader title="Recently added" subtitle="Back to what you added last" action="View library" onAction={onOpenLibrary}/>
    <div className="album-grid">{recent.map((song) => <AlbumCard key={song.id} song={song} onPlay={() => onPlay(song.id, recent.map(s=>s.id))} onFav={() => onFav(song.id)}/>)}</div>
    <div className="home-split">
      <section><SectionHeader title="Most played" subtitle="Your repeat-worthy tracks"/><div className="compact-list">{popular.map((song, i) => <CompactTrack key={song.id} song={song} index={i+1} onPlay={() => onPlay(song.id, popular.map(s=>s.id))}/>)}</div></section>
      <section><SectionHeader title="Liked collection" subtitle="Saved for later"/><div className="liked-panel">{favourites.length ? favourites.slice(0,4).map((song) => <CompactTrack key={song.id} song={song} onPlay={() => onPlay(song.id, favourites.map(s=>s.id))}/>) : <EmptyMini text="Like a song and it will appear here."/>}</div></section>
    </div>
  </div>;
}

function SearchView({ query, localSongs, onlineResults, loading, onPlay, onFav, onAddOnline, onPlaylist }) {
  return <div className="page search-page">
    <div className="page-head"><div><span className="eyebrow">DISCOVER</span><h2>{query ? `Results for “${query}”` : "Find your next track"}</h2><p>Search your library and the full-track online catalog. Select a result to play the available full version.</p></div></div>
    {!query.trim() ? <div className="search-empty"><div className="search-orb"><Search size={42}/></div><h3>Search without the clutter</h3><p>Type a song, artist or album above. Spool checks your library first and then finds full-track online results.</p></div> : <>
      <SectionHeader title="Your library" subtitle={`${localSongs.length} local result${localSongs.length === 1 ? "" : "s"}`}/>
      {localSongs.length ? <TrackTable songs={localSongs} onPlay={onPlay} onFav={onFav} onPlaylist={onPlaylist}/> : <EmptyMini text="No matching local tracks."/>}
      <SectionHeader title="Online results" subtitle="Full-track results from the online music search"/>
      {loading ? <div className="online-loader"><span/><span/><span/> Searching the catalog…</div> : onlineResults.length ? <div className="online-grid">{onlineResults.map((song) => <OnlineCard key={song.id} song={song} onPlay={() => onAddOnline(song)} onAdd={() => onAddOnline(song)}/>)}</div> : <EmptyMini text="No online catalog results found for this search."/>}
    </>}
  </div>;
}

function LibraryView({ title, subtitle, songs, sortKey, setSortKey, onPlay, onFav, onDelete, onPlaylist, onAdd }) {
  const [mediaFilter, setMediaFilter] = useState("all");
  const visibleSongs = songs.filter((song) => mediaFilter === "all" || (mediaFilter === "video" ? isVideoFile(song) : !isVideoFile(song)));
  return <div className="page library-page">
    <div className="page-head library-head"><div><span className="eyebrow">COLLECTION</span><h2>{title}</h2><p>{subtitle}</p></div><button className="primary-btn" onClick={onAdd}><Plus size={17}/>Add music</button></div>
    <div className="library-toolbar"><div className="pill-tabs"><button className={mediaFilter==="all"?"active":""} onClick={()=>setMediaFilter("all")}>All</button><button className={mediaFilter==="audio"?"active":""} onClick={()=>setMediaFilter("audio")}>Audio</button><button className={mediaFilter==="video"?"active":""} onClick={()=>setMediaFilter("video")}>Video</button></div><SortMenu value={sortKey} onChange={setSortKey}/></div>
    {visibleSongs.length ? <TrackTable songs={visibleSongs} onPlay={onPlay} onFav={onFav} onDelete={onDelete} onPlaylist={onPlaylist}/> : <div className="empty-library"><div><Music2 size={34}/></div><h3>Nothing here yet</h3><p>Add music, like a track or choose another playlist.</p><button className="primary-btn" onClick={onAdd}><Plus size={17}/>Add your first track</button></div>}
  </div>;
}

function TrackTable({ songs, onPlay, onFav, onDelete, onPlaylist }) {
  const ids = songs.map((s)=>s.id);
  return <div className="track-table"><div className="track-head"><span>#</span><span>Title</span><span>Album</span><span>Type</span><span><Clock3 size={15}/></span><span/></div>{songs.map((song, i) => <div className="track-row" key={song.id}><div className="track-index"><span>{i+1}</span><button onClick={() => onPlay(song.id, ids)}><Play size={15} fill="currentColor"/></button></div><div className="track-main"><Cover song={song}/><div><strong>{song.name}</strong><span>{song.singer}</span></div></div><span className="muted hide-small">{song.album || "Single"}</span><span className="type-chip hide-small">{isVideoFile(song) ? <><Video size={13}/>Video</> : <><Music2 size={13}/>Audio</>}</span><span className="muted duration-cell">{fmtTime(song.duration)}</span><div className="row-actions"><button className={song.favorite ? "liked" : ""} onClick={() => onFav(song.id)}><Heart size={17} fill={song.favorite ? "currentColor" : "none"}/></button>{onPlaylist && <button onClick={() => onPlaylist(song.id)} title="Add to playlist"><ListPlus size={17}/></button>}{onDelete && <button onClick={() => onDelete(song.id)} title="Delete"><Trash2 size={17}/></button>}</div></div>)}</div>;
}

function AlbumCard({ song, onPlay, onFav }) { return <article className="album-card"><div className="album-cover"><Cover song={song} large/><button className="card-play" onClick={onPlay}><Play size={20} fill="currentColor"/></button><button className={`card-like ${song.favorite ? "liked" : ""}`} onClick={onFav}><Heart size={17} fill={song.favorite ? "currentColor" : "none"}/></button>{isVideoFile(song) && <span className="video-badge"><Video size={12}/>MV</span>}</div><strong>{song.name}</strong><span>{song.singer}</span></article>; }
function CompactTrack({ song, index, onPlay }) { return <button className={`compact-track ${index ? "has-index" : "no-index"}`} onClick={onPlay}>{index ? <span className="compact-index">{index}</span> : null}<Cover song={song}/><div><strong>{song.name}</strong><span>{song.singer}</span></div><span className="compact-time">{fmtTime(song.duration)}</span><Play className="compact-play" size={16} fill="currentColor"/></button>; }
function OnlineCard({ song, onPlay, onAdd }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setAdding(true); setError("");
    try { await onAdd(); } catch (e) { setError(e.message || "Could not add track."); }
    finally { setAdding(false); }
  };
  return <article className="online-card">
    <div className="online-card-cover"><Cover song={song} large/><button className="online-card-play" onClick={add} title="Play full track"><Play size={18} fill="currentColor"/></button></div>
    <div className="online-card-copy"><strong title={song.name}>{song.name}</strong><span title={song.singer}>{song.singer}</span><small>{song.album || "Single"}{song.duration ? ` · ${fmtTime(song.duration)}` : ""}</small>{error && <em className="download-error">{error}</em>}</div>
    <div className="online-card-actions"><button className="glass-btn small online-play-btn" onClick={add} disabled={adding} title="Play full track"><Play size={14} fill="currentColor"/>{adding ? "Loading…" : "Play"}</button><button className="primary-btn small online-add-btn" onClick={add} disabled={adding} title="Add to your library and play"><Plus size={14}/>{adding ? "Adding…" : "Add & play"}</button></div>
  </article>;
}

function SortMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const options = [
    ["recent", "Recently added"],
    ["popular", "Most played"],
    ["name", "Title A–Z"],
    ["artist", "Artist A–Z"],
  ];
  useEffect(() => {
    const close = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const esc = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, []);
  const label = options.find(([key]) => key === value)?.[1] || "Sort";
  return <div className={`sort-menu ${open ? "open" : ""}`} ref={ref}>
    <button className="sort-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}><ArrowDownUp size={15}/><span>{label}</span><ChevronRight size={14} className="sort-chevron"/></button>
    {open && <div className="sort-options">{options.map(([key, text]) => <button key={key} className={value === key ? "active" : ""} onClick={() => { onChange(key); setOpen(false); }}>{value === key && <span className="sort-check">✓</span>}<span>{text}</span></button>)}</div>}
  </div>;
}
function Cover({ song, large=false }) { const [bad,setBad]=useState(false); const src = !bad && (song.coverUrl || defaultCover(song)); return src ? <img className={`cover ${large ? "large" : ""}`} src={src} alt="" onError={() => setBad(true)}/> : <div className={`cover fallback ${large ? "large" : ""}`}>{textAvatar(song.name)}</div>; }
function SectionHeader({ title, subtitle, action, onAction }) { return <div className="section-head"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>{action && <button onClick={onAction}>{action}<ChevronRight size={16}/></button>}</div>; }
function EmptyMini({ text }) { return <div className="empty-mini"><Music2 size={20}/><span>{text}</span></div>; }

function NowPlayingBar({ song, playing, elapsed, duration, volume, repeat, shuffle, onToggle, onPrev, onNext, onRepeat, onShuffle, onVolume, onSeek, onFav, onDownload, onLyrics, onVideo, videoOpen }) {
  return <footer className={`player-bar ${song ? "has-song" : ""}`}>
    <div className="player-song">{song ? <><Cover song={song}/><div><strong>{song.name}</strong><span>{song.singer}</span></div><button className={song.favorite ? "liked" : ""} onClick={onFav}><Heart size={17} fill={song.favorite ? "currentColor" : "none"}/></button></> : <><div className="cover fallback"><Music2 size={18}/></div><div><strong>Nothing playing</strong><span>Choose a track</span></div></>}</div>
    <div className="player-center"><div className="transport"><button className={shuffle ? "active" : ""} onClick={onShuffle}><Shuffle size={17}/></button><button onClick={onPrev}><SkipBack size={19} fill="currentColor"/></button><button className="play-main" onClick={onToggle}>{playing ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button><button onClick={onNext}><SkipForward size={19} fill="currentColor"/></button><button className={repeat ? "active" : ""} onClick={onRepeat}><Repeat size={17}/></button></div><div className="timeline"><span>{fmtTime(elapsed)}</span><input type="range" min="0" max={Math.max(duration,1)} step="0.1" value={Math.min(elapsed, Math.max(duration,1))} onChange={(e)=>onSeek(Number(e.target.value))}/><span>{fmtTime(duration)}</span></div></div>
    <div className="player-tools">{song && !isYouTubeSong(song) && <button onClick={onDownload} title="Download full track"><Download size={18}/></button>}{song && isVideoFile(song) && <button onClick={onVideo} title={videoOpen ? "Close video" : "Open video"}>{videoOpen ? <X size={18}/> : <Video size={18}/>}</button>}<button onClick={onLyrics} title="Lyrics"><Mic2 size={18}/></button><VolumeIcon volume={volume}/><input className="volume-range" type="range" min="0" max="1" step="0.01" value={volume} onChange={(e)=>onVolume(Number(e.target.value))}/></div>
  </footer>;
}
function VolumeIcon({volume}) { if (volume===0) return <VolumeX size={18}/>; if (volume<.45) return <Volume1 size={18}/>; return <Volume2 size={18}/>; }

function YouTubePlayer({ videoId, playing, volume, videoOpen, seekRef, onTimeUpdate, onDuration, onPlayingChange, onEnded }) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    if (!videoId) return undefined;
    setError("");
    loadYouTubeApi().then((YT) => {
      if (!alive || !hostRef.current) return;
      playerRef.current?.destroy?.();
      playerRef.current = new YT.Player(hostRef.current, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: (event) => {
            event.target.setVolume(Math.round(volume * 100));
            onDuration(event.target.getDuration?.() || 0);
            if (playing) event.target.playVideo();
          },
          onStateChange: (event) => {
            const state = event.data;
            if (state === YT.PlayerState.PLAYING) onPlayingChange(true);
            if (state === YT.PlayerState.PAUSED) onPlayingChange(false);
            if (state === YT.PlayerState.ENDED) { onPlayingChange(false); onEnded(); }
          },
          onError: () => setError("This YouTube video cannot be embedded or played here.")
        }
      });
    }).catch((e) => setError(e.message || "YouTube player unavailable."));
    return () => { alive = false; playerRef.current?.destroy?.(); playerRef.current = null; };
  }, [videoId]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p?.getPlayerState) return;
    try {
      p.setVolume(Math.round(volume * 100));
      if (playing) p.playVideo(); else p.pauseVideo();
    } catch {}
  }, [playing, volume]);

  useEffect(() => {
    if (!seekRef) return undefined;
    seekRef.current = (time) => { try { playerRef.current?.seekTo?.(Number(time) || 0, true); } catch {} };
    return () => { seekRef.current = null; };
  }, [seekRef, videoId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      try { onTimeUpdate(p.getCurrentTime() || 0); onDuration(p.getDuration() || 0); } catch {}
    }, 250);
    return () => window.clearInterval(timer);
  }, [onTimeUpdate, onDuration]);

  return <div className={`youtube-stage-media ${videoOpen ? "" : "youtube-audio-hidden"} ${error ? "has-error" : ""}`}><div ref={hostRef} className="youtube-player-host"/>{error && <div className="youtube-error"><Video size={24}/><strong>Playback unavailable</strong><span>{error}</span></div>}</div>;
}

function LyricsPanel({ song, lyrics, activeIndex, refEl, onClose, onJump }) {
  return <aside className="lyrics-panel">
    <div className="lyrics-head">
      <div className="lyrics-title-wrap">
        <span className="eyebrow"><Mic2 size={13}/> LIVE LYRICS</span>
        <h3 title={song?.name || "Lyrics"}>{song?.name || "Lyrics"}</h3>
        <p title={song?.singer || "Play a track to begin"}>{song?.singer || "Play a track to begin"}</p>
      </div>
      <button className="icon-btn" onClick={onClose}><X/></button>
    </div>
    <div className="lyrics-scroll" ref={refEl}>
      {song ? (lyrics.length ? lyrics.map((line, i) => (
        <button data-line={i} key={`${line.time}-${i}`} className={i===activeIndex ? "active" : i<activeIndex ? "past" : ""} onClick={()=>onJump(line.time)}>
          <small>{fmtTime(line.time)}</small><span>{line.text}</span>
        </button>
      )) : <div className="lyrics-placeholder"><Mic2 size={35}/><h4>No lyrics found</h4><p>Spool will automatically look for synced lyrics when metadata is available.</p></div>) : <div className="lyrics-placeholder"><Disc3 size={35}/><h4>Start a song</h4><p>Synced lyrics will follow the music here.</p></div>}
    </div>
  </aside>;
}


function VideoModal({ song, playing, onToggle, onClose }) {
  return <div className="video-modal">
    <div className="video-modal-top">
      <div><span>NOW PLAYING</span><strong title={`${song.name} — ${song.singer}`}>{song.name} — {song.singer}</strong></div>
      <div><button onClick={onToggle}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button><button onClick={onClose} title="Close video"><X size={20}/></button></div>
    </div>
    <div className="video-stage-placeholder"><div className="video-glow"/><div className="video-note"><Video size={30}/><span>Video playback is active</span><small>Use the player controls below to seek and control volume.</small></div></div>
  </div>;
}


function AddMusicModal({ onClose, onAdd }) {
  const [mode,setMode]=useState("file");
  const [file,setFile]=useState(null);
  const [busy,setBusy]=useState(false);
  const [detecting,setDetecting]=useState(false);
  const [error,setError]=useState("");
  const [editLyrics,setEditLyrics]=useState(false);
  const [form,setForm]=useState({name:"", singer:"", album:"", mood:"Chill", duration:"", lyrics:"", url:"", coverUrl:"", lyricsMode:"", lyricsDuration:0});
  const set = (key,val)=>setForm((f)=>({...f,[key]:val}));

  const applyDetected = async (base) => {
    setDetecting(true); setError("");
    try {
      const detected = await enrichTrack(base);
      setForm((f)=>({
        ...f,
        name: detected.name || f.name,
        singer: detected.singer || f.singer,
        album: detected.album || f.album,
        duration: detected.duration || f.duration,
        lyrics: detected.lyrics || f.lyrics,
        coverUrl: detected.coverUrl || f.coverUrl,
        lyricsMode: detected.lyricsMode || f.lyricsMode,
        lyricsDuration: detected.lyricsDuration || f.lyricsDuration,
      }));
    } catch (e) { setError(e.message || "Automatic detection failed. You can still add the track."); }
    finally { setDetecting(false); }
  };

  const chooseFile = async (nextFile) => {
    setFile(nextFile); setError("");
    if (!nextFile) return;
    const parsed = parseFilename(nextFile.name);
    const localDuration = await readLocalMediaMeta(nextFile);
    setForm((f)=>({ ...f, name: parsed.name, singer: parsed.singer, duration: localDuration || f.duration }));
    await applyDetected({ name: parsed.name, singer: parsed.singer, duration: localDuration });
  };

  useEffect(() => {
    if (mode !== "url" || !/^https?:\/\//i.test(form.url.trim())) return undefined;
    const timer = setTimeout(() => detectUrl(), 700);
    return () => clearTimeout(timer);
  }, [form.url, mode]);

  const detectUrl = async () => {
    const url = form.url.trim();
    if (!/^https?:\/\//i.test(url)) { setError("Paste a YouTube link or a public direct MP3/MP4/media URL."); return; }
    setDetecting(true); setError("");
    try {
      const res = await fetch(`/api/remote-info?url=${encodeURIComponent(url)}`);
      const body = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(body.error || "Could not inspect this URL.");
      setForm((f)=>({ ...f, name: body.name || f.name, singer: body.singer || f.singer, album: body.album || f.album, duration: body.duration || f.duration, lyrics: body.lyrics || f.lyrics, coverUrl: body.coverUrl || f.coverUrl, lyricsMode: body.lyricsMode || f.lyricsMode }));
    } catch(e) { setError(e.message || "Could not detect the online track."); }
    finally { setDetecting(false); }
  };

  const submit=async(e)=>{
    e.preventDefault(); setError(""); setBusy(true);
    try {
      let audioUrl=form.url.trim(), mediaType="";
      if(mode==="file"){
        if(!file) throw new Error("Choose an MP3, MP4 or another supported media file.");
        const uploaded=await uploadMediaFile(file); audioUrl=uploaded.url; mediaType=uploaded.mimeType || file.type;
      } else {
        if(!/^https?:\/\//i.test(audioUrl)) throw new Error("Paste a YouTube link or a public direct MP3/MP4/media URL.");
        mediaType=isYouTubeUrl(audioUrl) ? "video/youtube" : (/\.mp4(?:$|[?#])/i.test(audioUrl) ? "video/mp4" : "audio/mpeg");
      }
      onAdd({
        name:form.name.trim() || parseFilename(file?.name || "").name,
        singer:form.singer.trim() || "Unknown artist",
        album:form.album.trim() || "Single",
        mood:form.mood,
        duration:Number(form.duration)||0,
        lyrics:form.lyrics,
        lyricsMode:form.lyricsMode,
        lyricsDuration:Number(form.lyricsDuration)||0,
        audioUrl: isYouTubeUrl(audioUrl) ? "" : audioUrl,
        sourceUrl: mode === "url" ? audioUrl : "",
        mediaType,
        coverUrl:form.coverUrl.trim()
      }, true);
      onClose();
    } catch(err){setError(err.message||"Could not add media.");}
    finally{setBusy(false);}
  };

  return <Modal title="Add music" subtitle="Pick a file or paste a public media link. Spool fills the details for you." onClose={onClose}>
    <form className="add-form" onSubmit={submit}>
      <div className="mode-switch"><button type="button" className={mode==="file"?"active":""} onClick={()=>{setMode("file");setError("")}}><Upload size={16}/>Upload file</button><button type="button" className={mode==="url"?"active":""} onClick={()=>{setMode("url");setError("")}}><Radio size={16}/>Online link</button></div>
      {mode==="file" ? <label className={`drop-zone ${file?"selected":""}`}><input type="file" accept="audio/*,video/mp4,.mp3,.mp4,.wav,.ogg,.m4a,.aac,.flac" onChange={(e)=>chooseFile(e.target.files?.[0]||null)}/><div><Upload size={26}/><strong>{file ? file.name : "Choose audio or MP4 video"}</strong><span>{file ? `${(file.size/1024/1024).toFixed(1)} MB · details auto-detected` : "MP3, MP4, WAV, OGG, M4A, AAC, FLAC · up to 100 MB"}</span></div></label> : <div className="url-detect-row"><Field label="Public direct media URL"><input value={form.url} onChange={(e)=>set("url",e.target.value)} onBlur={detectUrl} placeholder="https://example.com/artist - song.mp3"/></Field><button type="button" className="glass-btn detect-btn" onClick={detectUrl} disabled={detecting}>{detecting ? "Detecting…" : "Auto detect"}</button></div>}
      {detecting && <div className="detecting-pill"><span className="spinner"/> Detecting title, artist, artwork and lyrics…</div>}
      <div className="metadata-banner"><div className="metadata-cover">{form.coverUrl ? <img src={form.coverUrl} alt=""/> : <Music2 size={20}/>}</div><div><strong>{form.name || "Track details will appear here"}</strong><span>{form.singer || "Artist"}{form.album ? ` · ${form.album}` : ""}</span></div><small>{form.lyricsMode === "synced" ? "SYNCED LYRICS FOUND" : form.lyrics ? "LYRICS FOUND" : "AUTO DETECT READY"}</small></div>
      <div className="form-grid"><Field label="Track title"><input value={form.name} onChange={(e)=>set("name",e.target.value)} placeholder="Auto detected"/></Field><Field label="Artist"><input value={form.singer} onChange={(e)=>set("singer",e.target.value)} placeholder="Auto detected"/></Field><Field label="Album"><input value={form.album} onChange={(e)=>set("album",e.target.value)} placeholder="Auto detected"/></Field><Field label="Mood"><select value={form.mood} onChange={(e)=>set("mood",e.target.value)}>{["Chill","Focus","Happy","Sad","Workout","Party","Rainy","Love"].map(x=><option key={x}>{x}</option>)}</select></Field><Field label="Duration (seconds)"><input type="number" min="0" value={form.duration} onChange={(e)=>set("duration",e.target.value)} placeholder="Auto detected"/></Field><Field label="Cover image URL"><input value={form.coverUrl} onChange={(e)=>set("coverUrl",e.target.value)} placeholder="Auto detected"/></Field></div>
      <div className="lyrics-editor-head"><div><strong>Lyrics</strong><span>{form.lyricsMode === "synced" ? "Synced lyrics found automatically" : form.lyrics ? "Lyrics found automatically" : "No lyrics detected yet"}</span></div><button type="button" className="glass-btn small" onClick={()=>setEditLyrics(v=>!v)}>{editLyrics ? "Hide editor" : "Edit lyrics"}</button></div>
      {editLyrics ? <Field label="Lyrics editor"><textarea value={form.lyrics} onChange={(e)=>set("lyrics",e.target.value)} placeholder={'Lyrics are optional. LRC timestamps are supported:\n[00:12.50] First line\n[00:18.00] Next line'}/></Field> : <div className="lyrics-preview">{form.lyrics ? parseLyrics(form.lyrics, Number(form.duration)||0, Number(form.lyricsDuration)||0).slice(0,5).map((x,i)=><div key={i}><span>{fmtTime(x.time)}</span><p>{x.text}</p></div>) : <span>Spool will search automatically when the track title and artist can be identified.</span>}</div>}
      {error&&<div className="form-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="glass-btn" onClick={onClose}>Cancel</button><button className="primary-btn" disabled={busy || detecting}>{busy?<><span className="spinner dark"/>Adding…</>:<><Plus size={17}/>Add to library</>}</button></div>
    </form>
  </Modal>;
}

function CreatePlaylistModal({onClose,onCreate}) { const [name,setName]=useState(""); return <Modal title="Create playlist" subtitle="Start a new collection for any mood." onClose={onClose}><form onSubmit={(e)=>{e.preventDefault(); if(name.trim()){onCreate(name); onClose();}}}><Field label="Playlist name"><input autoFocus value={name} onChange={(e)=>setName(e.target.value)} placeholder="e.g. Midnight Drive"/></Field><div className="modal-actions"><button type="button" className="glass-btn" onClick={onClose}>Cancel</button><button className="primary-btn"><ListPlus size={17}/>Create playlist</button></div></form></Modal>; }
function PlaylistPicker({playlists,onClose,onPick,onCreate}) { return <Modal title="Add to playlist" subtitle="Choose where this track should live." onClose={onClose}><div className="picker-list">{playlists.map(p=><button key={p.id} onClick={()=>onPick(p.id)}><div><ListMusic size={18}/></div><span><strong>{p.name}</strong><small>{p.songIds.length} tracks</small></span><ChevronRight size={17}/></button>)}<button onClick={onCreate}><div><Plus size={18}/></div><span><strong>New playlist</strong><small>Create another collection</small></span><ChevronRight size={17}/></button></div></Modal>; }
function Modal({title,subtitle,onClose,children}) { return <div className="modal-backdrop" onMouseDown={(e)=>e.target===e.currentTarget&&onClose()}><div className="modal"><div className="modal-head"><div><h3>{title}</h3><p>{subtitle}</p></div><button className="icon-btn" onClick={onClose}><X/></button></div>{children}</div></div>; }
function Field({label,children}) { return <label className="field"><span>{label}</span>{children}</label>; }

# Spool Music Player

A responsive React/Vite music player with a local Node.js + SQLite backend.

## What is included

- Professional responsive desktop/tablet/mobile interface
- Real MP3, WAV, OGG, M4A, AAC and FLAC audio playback
- Real MP4 music-video playback in a dedicated cinema-style stage
- YouTube watch / youtu.be / Shorts / YouTube Music links via the official embedded player
- YouTube metadata + artwork detection through the public oEmbed endpoint
- Seek, volume, previous/next, shuffle and repeat controls
- Separate lyrics panel with time-synced highlighting
- Lyrics and video can stay open together without covering each other; desktop uses side-by-side space and mobile reserves a dedicated lyrics area
- LRC timestamp support (`[00:12.50] lyric`) plus automatic line distribution for plain lyrics
- Favourites / liked songs
- Custom playlists
- Library search by song, artist, album and mood
- Audio/video filters and sorting
- Local media uploads up to 100 MB using raw binary uploads (no base64 expansion)
- Direct online audio/video URL support
- URL inspection falls back from HEAD to a small ranged GET, so more media hosts work even when HEAD is blocked
- Optional online catalog search that imports playable preview URLs into the library
- SQLite persistence in `data/spool.db`
- Uploaded media stored in `data/uploads/`
- HTTP byte-range support for smoother media seeking
- Dark / light theme with persistent preference
- Fresh installs start with an empty library; old non-playable showcase/demo records are automatically removed

## Requirements

Use a recent Node.js version with the built-in `node:sqlite` module. Node 22+ is recommended.

## Run in IntelliJ / Windows Terminal

```cmd
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

The development command starts both:

- Vite frontend: `http://localhost:5173`
- Spool API: `http://127.0.0.1:3001`

## Production build

```cmd
npm run build
npm start
```

Then open `http://127.0.0.1:3001`.

## Synced lyrics

Spool prefers LRCLIB line-synced lyrics when they are available. The player follows the media clock rather than a fixed animation. LRC timestamps such as `[00:12.50]` are supported. If only plain lyrics exist, Spool marks them as plain lyrics and distributes them across the detected duration as a fallback; they are not treated as true word-level synchronization.

LRCLIB recommends supplying the track title, artist, album and duration because duration improves matching precision. urlLRCLIB API documentationhttps://lrclib.net/docs


## Online preview downloads

Search results can be downloaded through the built-in `/api/download` proxy when the source provides a downloadable preview. The player does not transcode or artificially increase quality: downloads preserve the quality supplied by the source. For video, the original source resolution/bitrate is preserved; for audio, the source audio encoding is preserved. Use downloads only for media you are authorized to save.


## Automatic metadata & lyrics

When adding a track, Spool can automatically look up title, artist, album, artwork, duration and lyrics. Synced LRC lyrics are preferred; plain lyrics are supported as a fallback and are distributed across the track for readable auto-following. Metadata/lyrics lookup uses iTunes Search and LRCLIB. LRCLIB's API supports timestamped synced lyrics and plain lyrics without an API key.

Online links support public direct MP3/MP4/audio/video URLs and YouTube watch, youtu.be, Shorts and YouTube Music URLs. YouTube playback uses the embedded player, while direct media files use Spool's byte-range proxy. Not every arbitrary webpage can expose a playable media stream; those links are rejected with a clear message.

## Full-track playback and downloads

Spool supports full playback and downloads for media that the app is actually given access to: uploaded MP3/MP4 files and public direct media URLs. The player now has a Download control for the current full track when a downloadable source exists.

The built-in catalog search uses Apple's catalog preview URLs, so those results are previews rather than full-track files. Apple's APIs expose preview assets for catalog playback; they do not provide a general full-song download URL for commercial tracks. For a full track inside Spool, use **Add music → Online link** with a public direct MP3/MP4 URL or a supported YouTube link for full in-app video playback. YouTube downloads are intentionally not offered.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const mediaDir = path.join(dataDir, 'uploads');
const distDir = path.join(__dirname, 'dist');
fs.mkdirSync(mediaDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'spool.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_state (
    storage_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const getState = db.prepare('SELECT value_json FROM app_state WHERE storage_key = ?');
const setState = db.prepare(`
  INSERT INTO app_state(storage_key, value_json, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(storage_key) DO UPDATE SET value_json=excluded.value_json, updated_at=CURRENT_TIMESTAMP
`);
const deleteState = db.prepare('DELETE FROM app_state WHERE storage_key = ?');
const addMedia = db.prepare('INSERT INTO media_files(id, original_name, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?)');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.mp4': 'video/mp4'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readJson(req, maxBytes = 5 * 1024 * 1024) {
  return readBuffer(req, maxBytes).then((buffer) => {
    try { return JSON.parse(buffer.toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
  });
}

function readBuffer(req, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeExt(name = '', type = '') {
  const ext = path.extname(name).toLowerCase();
  const allowed = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4']);
  if (allowed.has(ext)) return ext;
  if (type.includes('mpeg')) return '.mp3';
  if (type.includes('wav')) return '.wav';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('video/mp4')) return '.mp4';
  if (type.includes('audio/mp4')) return '.m4a';
  if (type.includes('aac')) return '.aac';
  if (type.includes('flac')) return '.flac';
  return '.mp3';
}

function isSupportedMedia(name, type) {
  return String(type).startsWith('audio/') || type === 'video/mp4' || /\.(mp3|wav|ogg|m4a|aac|flac|mp4)$/i.test(name);
}

function serveFile(res, filePath, req = null) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const baseHeaders = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': filePath.startsWith(mediaDir) ? 'public, max-age=3600' : 'no-cache'
  };
  const range = req?.headers?.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2] || 0));
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start <= end && start < total && end < total) {
        const chunk = end - start + 1;
        res.writeHead(206, { ...baseHeaders, 'Content-Length': chunk, 'Content-Range': `bytes ${start}-${end}/${total}` });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return true;
      }
    }
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` });
    res.end();
    return true;
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
  fs.createReadStream(filePath).pipe(res);
  return true;
}


function isSafeRemoteUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return false;
    if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch { return false; }
}

async function proxyDownload(res, rawUrl) {
  if (!isSafeRemoteUrl(rawUrl)) return send(res, 400, { error: 'Only public http/https media URLs are supported.' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(rawUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'SpoolMusicPlayer/3.0' } });
    if (!response.ok || !response.body) return send(res, 502, { error: `Remote media request failed (${response.status}).` });
    const type = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    const dispositionName = path.basename(new URL(rawUrl).pathname) || 'spool-download';
    const safeName = dispositionName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'spool-download';
    const length = response.headers.get('content-length');
    const headers = {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
      'X-Spool-Source-Url': rawUrl,
    };
    if (length) headers['Content-Length'] = length;
    res.writeHead(200, headers);
    for await (const chunk of response.body) res.write(Buffer.from(chunk));
    res.end();
  } catch (error) {
    if (!res.headersSent) send(res, 502, { error: error.name === 'AbortError' ? 'Download timed out.' : 'Could not download the remote media.' });
    else res.destroy(error);
  } finally { clearTimeout(timer); }
}


function cleanSearchText(value = '') {
  return String(value)
    .replace(/\.(mp3|mp4|wav|ogg|m4a|aac|flac)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFilenameMetadata(filename = '') {
  const base = cleanSearchText(path.basename(filename));
  const match = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (match) return { singer: match[1].trim(), name: match[2].trim() };
  return { singer: '', name: base || 'Untitled' };
}

async function fetchJson(url, timeoutMs = 8000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) return null;
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function enrichTrack({ name = '', singer = '', album = '', duration = 0 } = {}) {
  const trackName = cleanSearchText(name);
  const artistName = cleanSearchText(singer);
  if (!trackName || trackName === 'Untitled') return { name: trackName || 'Untitled', singer: artistName, album, duration, lyrics: '', coverUrl: '' };

  let metadata = {};
  try {
    const itunes = new URL('https://itunes.apple.com/search');
    itunes.searchParams.set('term', [artistName, trackName].filter(Boolean).join(' '));
    itunes.searchParams.set('media', 'music');
    itunes.searchParams.set('entity', 'song');
    itunes.searchParams.set('limit', '8');
    itunes.searchParams.set('country', 'US');
    const body = await fetchJson(itunes, 8000, { 'User-Agent': 'SpoolMusicPlayer/4.0' });
    const candidates = body?.results || [];
    const best = candidates.find((item) =>
      item.trackName && item.previewUrl &&
      (!artistName || String(item.artistName).toLowerCase().includes(artistName.toLowerCase()))
    ) || candidates.find((item) => item.trackName) || null;
    if (best) {
      metadata = {
        name: best.trackName || trackName,
        singer: best.artistName || artistName,
        album: best.collectionName || album || 'Single',
        duration: duration || (best.trackTimeMillis ? Math.round(best.trackTimeMillis / 1000) : 0),
        coverUrl: String(best.artworkUrl100 || '').replace('100x100bb', '600x600bb')
      };
    }
  } catch {}

  const finalName = metadata.name || trackName;
  const finalArtist = metadata.singer || artistName;
  const finalAlbum = metadata.album || album || 'Single';
  const finalDuration = Number(duration || metadata.duration || 0);
  let lyrics = '';
  let lyricsMode = '';
  let lyricsDuration = 0;
  try {
    const lrclib = new URL('https://lrclib.net/api/get');
    lrclib.searchParams.set('track_name', finalName);
    if (finalArtist) lrclib.searchParams.set('artist_name', finalArtist);
    if (finalAlbum) lrclib.searchParams.set('album_name', finalAlbum);
    if (finalDuration > 0) lrclib.searchParams.set('duration', String(Math.round(finalDuration)));
    let result = await fetchJson(lrclib, 9000, {
      'User-Agent': 'SpoolMusicPlayer/4.0 (local music player)'
    });
    // If duration differs by more than LRCLIB's strict /api/get matching
    // window, fall back to its search endpoint and choose the closest title/artist.
    if (!result) {
      const search = new URL('https://lrclib.net/api/search');
      search.searchParams.set('track_name', finalName);
      if (finalArtist) search.searchParams.set('artist_name', finalArtist);
      const candidates = await fetchJson(search, 9000, {
        'User-Agent': 'SpoolMusicPlayer/4.0 (local music player)'
      });
      const list = Array.isArray(candidates) ? candidates : [];
      const norm = (value) => cleanSearchText(value).toLowerCase();
      const targetTitle = norm(finalName);
      const targetArtist = norm(finalArtist);
      const targetAlbum = norm(finalAlbum);
      result = list.sort((a, b) => {
        const score = (item) => {
          const title = norm(item.trackName || item.name);
          const artist = norm(item.artistName);
          const album = norm(item.albumName);
          const durationDiff = Math.abs(Number(item.duration || 0) - finalDuration);
          return (title === targetTitle ? 0 : title.includes(targetTitle) || targetTitle.includes(title) ? 2 : 8)
            + (artist === targetArtist ? 0 : artist.includes(targetArtist) || targetArtist.includes(artist) ? 1 : 5)
            + (targetAlbum && album === targetAlbum ? 0 : targetAlbum ? 1 : 0)
            + durationDiff * 0.25
            + (item.syncedLyrics ? -2 : 0);
        };
        return score(a) - score(b);
      })[0] || null;
    }
    if (result) {
      lyrics = result.syncedLyrics || result.plainLyrics || '';
      lyricsMode = result.syncedLyrics ? 'synced' : (result.plainLyrics ? 'plain' : '');
      lyricsDuration = Number(result.duration || 0);
    }
  } catch {}

  return {
    name: finalName,
    singer: finalArtist || 'Unknown artist',
    album: finalAlbum,
    duration: finalDuration,
    lyrics,
    lyricsMode,
    lyricsDuration,
    coverUrl: metadata.coverUrl || ''
  };
}

function isYouTubeUrl(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host);
  } catch { return false; }
}

function youtubeVideoId(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2] || '';
    return u.searchParams.get('v') || '';
  } catch { return ''; }
}

async function youtubeMediaInfo(rawUrl) {
  if (!isSafeRemoteUrl(rawUrl) || !isYouTubeUrl(rawUrl)) throw Object.assign(new Error('Invalid YouTube URL.'), { statusCode: 400 });
  const videoId = youtubeVideoId(rawUrl);
  if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw Object.assign(new Error('Could not read the YouTube video ID from this link.'), { statusCode: 400 });

  let name = 'Online video';
  let singer = 'Online source';
  let coverUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  try {
    const endpoint = new URL('https://www.youtube.com/oembed');
    endpoint.searchParams.set('url', rawUrl);
    endpoint.searchParams.set('format', 'json');
    const body = await fetchJson(endpoint, 8000, { 'User-Agent': 'SpoolMusicPlayer/4.0' });
    if (body?.title) name = String(body.title).trim();
    if (body?.author_name) singer = String(body.author_name).trim();
    if (body?.thumbnail_url) coverUrl = body.thumbnail_url;
  } catch {}

  const enriched = await enrichTrack({ name, singer });
  return {
    name: enriched.name || name,
    singer: enriched.singer || singer,
    album: enriched.album || 'Online',
    duration: enriched.duration || 0,
    lyrics: enriched.lyrics || '',
    lyricsMode: enriched.lyricsMode || '',
    coverUrl: enriched.coverUrl || coverUrl,
    mediaType: 'video/youtube',
    sourceUrl: rawUrl,
    audioUrl: '',
    videoId,
  };
}

async function remoteMediaInfo(rawUrl) {
  if (!isSafeRemoteUrl(rawUrl)) throw Object.assign(new Error('Only public http/https media URLs are supported.'), { statusCode: 400 });
  if (isYouTubeUrl(rawUrl)) return youtubeMediaInfo(rawUrl);
  const u = new URL(rawUrl);
  const filename = decodeURIComponent(path.basename(u.pathname)) || 'online-track';
  const guessed = parseFilenameMetadata(filename);
  let type = '';
  let size = 0;

  // HEAD first (fast), then a tiny ranged GET for servers that do not support HEAD.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(rawUrl, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'SpoolMusicPlayer/4.0' } });
    clearTimeout(timer);
    if (response.ok) {
      type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      size = Number(response.headers.get('content-length') || 0);
    }
  } catch {}

  if (!type) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(rawUrl, {
        method: 'GET', redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'SpoolMusicPlayer/4.0', Range: 'bytes=0-1' }
      });
      type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      size = Number(response.headers.get('content-length') || 0);
      response.body?.cancel?.().catch?.(() => {});
      clearTimeout(timer);
    } catch {}
  }

  const extensionGuess = /\.mp4(?:$|[?#])/i.test(rawUrl) ? 'video/mp4' :
    /\.(mp3|m4a|aac|wav|ogg|flac)(?:$|[?#])/i.test(rawUrl) ? 'audio/mpeg' : '';
  const mediaType = type || extensionGuess;
  if (!mediaType) throw Object.assign(new Error('This link does not expose a playable MP3/MP4/media file. Paste a direct media URL or a YouTube video link.'), { statusCode: 415 });
  if (!mediaType.startsWith('audio/') && mediaType !== 'video/mp4') {
    throw Object.assign(new Error('This link is a webpage, not a playable media file. Use a direct MP3/MP4/media link or a YouTube link.'), { statusCode: 415 });
  }

  const enriched = await enrichTrack(guessed);
  return { ...guessed, ...enriched, mediaType, audioUrl: rawUrl, sourceUrl: rawUrl, size };
}

async function proxyMedia(res, rawUrl, req) {
  if (!isSafeRemoteUrl(rawUrl)) return send(res, 400, { error: 'Only public http/https media URLs are supported.' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = { 'User-Agent': 'SpoolMusicPlayer/4.0' };
    if (req.headers.range) headers.Range = req.headers.range;
    const response = await fetch(rawUrl, { signal: controller.signal, redirect: 'follow', headers });
    if (!response.ok || !response.body) return send(res, 502, { error: `Remote media request failed (${response.status}).` });
    const out = {
      'Content-Type': String(response.headers.get('content-type') || 'application/octet-stream'),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    };
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const contentDisposition = response.headers.get('content-disposition');
    if (contentLength) out['Content-Length'] = contentLength;
    if (contentRange) out['Content-Range'] = contentRange;
    if (contentDisposition) out['Content-Disposition'] = contentDisposition;
    res.writeHead(response.status, out);
    for await (const chunk of response.body) res.write(Buffer.from(chunk));
    res.end();
  } catch (error) {
    if (!res.headersSent) send(res, 502, { error: error.name === 'AbortError' ? 'Remote media request timed out.' : 'Could not stream the remote media.' });
    else res.destroy(error);
  } finally { clearTimeout(timer); }
}

function extractJsonObject(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const braceStart = text.indexOf('{', start + marker.length);
  if (braceStart < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

function textFromRuns(value) {
  if (!value) return '';
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map((run) => run?.text || '').join('').trim();
  return '';
}

function parseYouTubeDuration(value = '') {
  const parts = String(value).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

async function youtubeSearch(term) {
  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (apiKey) {
    const api = new URL('https://www.googleapis.com/youtube/v3/search');
    api.searchParams.set('part', 'snippet');
    api.searchParams.set('q', `${term} official audio`);
    api.searchParams.set('type', 'video');
    api.searchParams.set('videoEmbeddable', 'true');
    api.searchParams.set('videoSyndicated', 'true');
    api.searchParams.set('maxResults', '15');
    api.searchParams.set('key', apiKey);
    const response = await fetch(api, { signal: AbortSignal.timeout(9000) });
    if (!response.ok) throw new Error(`YouTube search failed (${response.status})`);
    const body = await response.json();
    return (body.items || []).map((item) => {
      const id = item.id?.videoId || '';
      return {
        id: `youtube-${id}`,
        name: item.snippet?.title || 'Unknown track',
        singer: item.snippet?.channelTitle || 'Online source',
        album: 'Online',
        duration: 0,
        mood: 'Online',
        lyrics: '',
        audioUrl: '',
        sourceUrl: `https://www.youtube.com/watch?v=${id}`,
        mediaType: 'video/youtube',
        coverUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        source: 'online-full',
        playCount: 0,
        favorite: false,
        addedAt: Date.now(),
      };
    }).filter((item) => item.sourceUrl && item.name && item.id !== 'youtube-');
  }
  const query = `${term} official audio`;
  const endpoint = new URL('https://www.youtube.com/results');
  endpoint.searchParams.set('search_query', query);
  endpoint.searchParams.set('hl', 'en');
  endpoint.searchParams.set('gl', 'US');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let response;
  try {
    response = await fetch(endpoint, {
      redirect: 'follow', signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`Online search failed (${response.status})`);
  const html = await response.text();
  const raw = extractJsonObject(html, 'ytInitialData');
  if (!raw) throw new Error('Online full-track search data was not available.');
  const data = JSON.parse(raw);
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || out.length >= 15) return;
    if (node.videoRenderer?.videoId) {
      const item = node.videoRenderer;
      const id = String(item.videoId);
      if (!seen.has(id)) {
        seen.add(id);
        const title = textFromRuns(item.title);
        const channel = textFromRuns(item.ownerText) || textFromRuns(item.shortBylineText) || 'Online source';
        const duration = parseYouTubeDuration(item.lengthText?.simpleText || textFromRuns(item.lengthText));
        const thumb = item.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        if (title) out.push({
          id: `youtube-${id}`,
          name: title,
          singer: channel,
          album: 'Online',
          duration,
          mood: 'Online',
          lyrics: '',
          audioUrl: '',
          sourceUrl: `https://www.youtube.com/watch?v=${id}`,
          mediaType: 'video/youtube',
          coverUrl: thumb,
          source: 'online-full',
          playCount: 0,
          favorite: false,
          addedAt: Date.now(),
        });
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return out;
}

async function onlineSearch(term) {
  try {
    const results = await youtubeSearch(term);
    if (results.length) return results;
  } catch (error) {
    console.warn(`Full online search unavailable: ${error.message}`);
  }
  return [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, database: 'sqlite', service: 'spool-api', version: 2 });
    }

    if (url.pathname === '/api/download' && req.method === 'GET') {
      const remoteUrl = String(url.searchParams.get('url') || '').trim();
      if (!remoteUrl) return send(res, 400, { error: 'A media URL is required.' });
      return proxyDownload(res, remoteUrl);
    }

    if (url.pathname === '/api/enrich' && req.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').slice(0, 180);
      const singer = String(url.searchParams.get('artist') || '').slice(0, 180);
      const album = String(url.searchParams.get('album') || '').slice(0, 180);
      const duration = Number(url.searchParams.get('duration') || 0);
      if (!name) return send(res, 400, { error: 'Track name is required.' });
      return send(res, 200, await enrichTrack({ name, singer, album, duration }), { 'Cache-Control': 'public, max-age=300' });
    }

    if (url.pathname === '/api/remote-info' && req.method === 'GET') {
      const remoteUrl = String(url.searchParams.get('url') || '').trim();
      if (!remoteUrl) return send(res, 400, { error: 'A media URL is required.' });
      try { return send(res, 200, await remoteMediaInfo(remoteUrl), { 'Cache-Control': 'public, max-age=300' }); }
      catch (error) { return send(res, error.statusCode || 502, { error: error.message || 'Could not inspect the remote media.' }); }
    }

    if (url.pathname === '/api/media-proxy' && req.method === 'GET') {
      const remoteUrl = String(url.searchParams.get('url') || '').trim();
      if (!remoteUrl) return send(res, 400, { error: 'A media URL is required.' });
      return proxyMedia(res, remoteUrl, req);
    }

    if (url.pathname === '/api/online-search' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (q.length < 2) return send(res, 200, { results: [] });
      try { return send(res, 200, { results: await onlineSearch(q) }, { 'Cache-Control': 'public, max-age=120' }); }
      catch (error) { return send(res, 502, { error: 'Online music search is temporarily unavailable', details: error.message }); }
    }

    if (url.pathname.startsWith('/api/storage/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/storage/'.length));
      if (!key) return send(res, 400, { error: 'Storage key is required' });
      if (req.method === 'GET') {
        const row = getState.get(key);
        return send(res, 200, row ? { key, value: row.value_json } : null);
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (typeof body.value !== 'string') return send(res, 400, { error: 'value must be a string' });
        setState.run(key, body.value);
        return send(res, 200, { key, saved: true });
      }
      if (req.method === 'DELETE') {
        deleteState.run(key);
        return send(res, 200, { key, deleted: true });
      }
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'upload'));
      const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      if (!isSupportedMedia(name, type)) return send(res, 415, { error: 'Only MP3, MP4, WAV, OGG, M4A, AAC and FLAC files are supported' });
      const buffer = await readBuffer(req, 100 * 1024 * 1024);
      if (!buffer.length) return send(res, 400, { error: 'The media file is empty' });
      const id = crypto.randomUUID();
      const ext = safeExt(name, type);
      const storedName = `${id}${ext}`;
      fs.writeFileSync(path.join(mediaDir, storedName), buffer);
      addMedia.run(id, String(name).slice(0, 255), storedName, String(type).slice(0, 120), buffer.length);
      return send(res, 201, { id, url: `/media/${storedName}`, size: buffer.length, mimeType: type });
    }

    if (url.pathname.startsWith('/media/') && req.method === 'GET') {
      const base = path.basename(url.pathname);
      if (serveFile(res, path.join(mediaDir, base), req)) return;
      return send(res, 404, { error: 'Media not found' });
    }

    if (req.method === 'GET' && fs.existsSync(distDir)) {
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const candidate = path.normalize(path.join(distDir, requested));
      if (candidate.startsWith(distDir) && serveFile(res, candidate, req)) return;
      if (serveFile(res, path.join(distDir, 'index.html'), req)) return;
    }

    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Spool API running at http://127.0.0.1:${PORT}`);
  console.log(`SQLite database: ${path.join(dataDir, 'spool.db')}`);
});

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    frame: false, titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    },
    show: false
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); });
ipcMain.handle('window-close', () => mainWindow.close());

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select Media Folders to Scan'
  });
  return result.canceled ? null : result.filePaths;
});

// ─── Constants ────────────────────────────────────────────
const VIDEO_EXT = new Set([
  '.mkv','.mp4','.avi','.mov','.wmv','.flv','.webm',
  '.m4v','.mpg','.mpeg','.ts','.m2ts','.vob','.iso',
  '.divx','.xvid','.3gp','.rmvb','.ogv'
]);

// ─── Junk file filter ─────────────────────────────────────
const DEFAULT_JUNK_KEYWORDS = [
  'sample','trailer','teaser','featurette','behind.the.scenes',
  'deleted.scene','interview','making.of','extra','bonus',
  'short','readme','nfo'
];
const DEFAULT_MIN_SIZE_MB = 50;

function isJunkFile(filename, sizeBytes, userSettings, filePath) {
  const keywords = (userSettings && userSettings.junkKeywords) || DEFAULT_JUNK_KEYWORDS;
  const minSizeMb = (userSettings && userSettings.minFileSizeMb) != null
    ? userSettings.minFileSizeMb : DEFAULT_MIN_SIZE_MB;
  const lower = filename.toLowerCase();
  // Check filename AND folder path for junk keywords
  const pathLower = (filePath || '').toLowerCase().replace(/\\/g, '/');
  const checkStr = lower + '|' + pathLower;
  if (keywords.some(k => checkStr.includes(k.toLowerCase()))) return true;
  // Global minimum size
  if (minSizeMb > 0 && sizeBytes < minSizeMb * 1024 * 1024) return true;
  return false;
}

// Folder-aware junk detection: given all video files in a folder,
// returns a Set of filenames that should be excluded because they are
// much smaller than the dominant file (likely samples/extras).
// Rule: if there is a "main" file >= minSizeMb, any file that is
// less than 20% of the largest file's size is treated as junk.
function getFolderJunkFiles(videoEntries, userSettings) {
  if (videoEntries.length <= 1) return new Set();
  const minSizeMb = (userSettings && userSettings.minFileSizeMb) != null
    ? userSettings.minFileSizeMb : DEFAULT_MIN_SIZE_MB;
  const minSizeBytes = minSizeMb * 1024 * 1024;
  
  const sizes = videoEntries.map(e => e.size);
  const maxSize = Math.max(...sizes);
  
  // Only apply rule if the largest file itself qualifies as a real movie/episode
  if (maxSize < minSizeBytes) return new Set();
  
  const threshold = maxSize * 0.20; // 20% of largest file
  const junk = new Set();
  videoEntries.forEach(e => {
    if (e.size < threshold) junk.add(e.name);
  });
  return junk;
}

function humanSize(bytes) {
  const u = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function cleanTitle(raw) {
  return raw
    // Strip parenthesised codec/format/language tags FIRST e.g. (Xvid), (x264), (Eng)
    .replace(/\([^)]{1,20}\)/g, ' ')
    // Quality / codec / source / language tags
    .replace(/\b(2160p|1080p|720p|480p|4K|UHD|BluRay|BRRip|HDRip|WEBRip|WEB-DL|WEBDL|HDTV|x264|x265|HEVC|H264|H265|AAC|AC3|DTS|PROPER|REPACK|EXTENDED|DIRECTORS|CUT|UNRATED|THEATRICAL|IMAX|3D|HDR|SDR|REMUX|DOLBY|ATMOS|AMZN|NF|DSNP|HULU|HBO|YIFY|YTS|RARBG|10bit|8bit|DD5|DD2|h265|h264|ws|ntsc|pal|dvd|dvdrip|bdrip|hdrip|webrip|hdtv|pdtv|fs|fullscreen|widescreen|internal|limited|retail|proper|readnfo|nfofix|ac3d|dubbed|subbed|multi|dual|trueHD|dovi|doVi|HDR10|hdr10|atmos|xvid|divx|eng|english|french|german|spanish|italian|portuguese|dutch|swedish|danish|finnish|norwegian|estonian|eur|usa|uk)\b/gi, '')
    // Release group tag at end: "-GroupName" pattern (word chars 2-12 long after final dash)
    .replace(/[-_][A-Za-z0-9]{2,12}$/, '')
    // Dots, underscores, remaining dashes → spaces
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Episode number extraction ────────────────────────────
function extractEpisodeInfo(filename) {
  let name = filename.replace(/\.[^/.]+$/, '');

  // Strip codec/quality tags FIRST so their digits don't trigger episode matching.
  // Examples that would otherwise false-match:
  //   H.264  → "E264" → episode 264
  //   DDP2.0 → "P2" near digits
  //   x265   → nothing but prevents confusion
  //   DD5.1  → "5" near "1" could confuse NxNN pattern
  name = name
    .replace(/\bH[._]?26[45]\b/gi, '')      // H.264, H265, H.265
    .replace(/\bx26[45]\b/gi, '')            // x264, x265
    .replace(/\bHEVC\b/gi, '')
    .replace(/\bDDP?\d[._]\d\b/gi, '')     // DD5.1, DDP2.0, DD2.0
    .replace(/\bAAC\d[._]\d\b/gi, '')      // AAC2.0, AAC5.1
    .replace(/\bAVC\b/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')          // 1080p, 720p, 2160p
    .replace(/\b4K\b/gi, '')
    .replace(/\bUHD\b/gi, '');

  let m = name.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  m = name.match(/(?:^|[^0-9])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  m = name.match(/[Ee](\d{2,3})(?:[^0-9]|$)/);
  if (m) {
    const ep = parseInt(m[1]);
    if (ep > 99) return { season: Math.floor(ep / 100), episode: ep % 100 };
    return { season: 1, episode: ep };
  }
  m = name.match(/(?:^|[\s._-])[Ee]p(?:isode)?[\s._-]*(\d{1,3})/i);
  if (m) return { season: 1, episode: parseInt(m[1]) };
  return null;
}

// ─── Extract show title from a messy folder/filename ─────
function extractShowTitle(name) {
  // Strip episode/season patterns and EVERYTHING after the first one found.
  // This is the primary grouping key — must be aggressive so that:
  //   "Gold.Rush.S16E06.The.Weasel"  → "Gold Rush"
  //   "Gold.Rush.S16E07.1080p"        → "Gold Rush"
  //   "Stargate.SG1.S08E01"           → "Stargate SG1"  (SG1 has no year, keep it)
  //   "Jeremiah.S01E01"               → "Jeremiah"
  let t = name
    // Remove SxxExx and everything after (most common)
    .replace(/[._\s\-][Ss]\d{1,2}[Ee]\d{1,3}.*/i, '')
    .replace(/[Ss]\d{1,2}[Ee]\d{1,3}.*/i, '')
    // Remove NxNN format
    .replace(/\d{1,2}x\d{2,3}.*/i, '')
    // Remove Ep/Episode N and everything after
    .replace(/[._\s\-][Ee]p(?:isode)?[\s._-]*\d{1,3}.*/i, '')
    // Remove Exx standalone
    .replace(/[._\s][Ee]\d{2,3}(?:[^0-9]|$).*/i, '')
    // Remove Season N and everything after
    .replace(/[._\s\-][Ss]eason[\s._-]?\d+.*/i, '')
    .replace(/[Ss]eason[\s._-]?\d+.*/i, '')
    // Remove year and everything after (years in show names are rare)
    .replace(/\b(19|20)\d{2}\b.*/i, '');
  const cleaned = cleanTitle(t);
  // If cleaning wiped everything, fall back to the original cleaned name
  return cleaned || cleanTitle(name.replace(/[._\-]+/g,' ').trim());
}


// ─── Movie name parser ────────────────────────────────────
// Walks up the folder chain to find the deepest folder containing a year.
// Falls back to parsing the filename itself.
function parseMovieName(filename, filePath) {
  let name = filename.replace(/\.[^/.]+$/, '');

  // If filename has episode pattern it should have been caught already,
  // but double-check and return a safe fallback
  const tvM = name.match(/[Ss](\d{1,2})[Ee](\d{1,3})/i);
  if (tvM) {
    return { type:'tv_episode', title: cleanTitle(extractShowTitle(name)),
             displayTitle: cleanTitle(extractShowTitle(name)), year: null,
             season: parseInt(tvM[1]), episode: parseInt(tvM[2]) };
  }

  // Walk up folder chain — deepest folder with year wins
  let bestTitle = null, bestYear = null;
  if (filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 2; i >= Math.max(0, parts.length - 5); i--) {
      const fn = parts[i];
      const fm = fn.match(/^(.*?)[\s._\-]*(\(?(?:19|20)\d{2}\)?)[\s._\-]/);
      if (fm) {
        const yr = parseInt(fm[2].replace(/[()]/g,''));
        if (yr >= 1880 && yr <= 2030) {
          bestTitle = cleanTitle(fm[1]);
          bestYear  = String(yr);
          break;
        }
      }
    }
  }

  if (!bestTitle) {
    const mm = name.match(/^(.*?)[\s._\-]*(\(?\d{4}\)?)[\s._\-]*(.*)?$/);
    let title = name, year = null;
    if (mm && mm[2]) {
      const yr = parseInt(mm[2].replace(/[()]/g,''));
      if (yr >= 1880 && yr <= 2030) { title = mm[1]; year = String(yr); }
    }
    bestTitle = cleanTitle(title) || cleanTitle(name);
    bestYear  = year;
  }

  return { type:'movie', title: bestTitle, displayTitle: bestTitle, year: bestYear };
}

// ═══════════════════════════════════════════════════════════
// SCANNER — completely rewritten with a simple, reliable model
//
// Core philosophy:
//   scanDirectory(rootPath) is called once per user-added folder.
//   It does NOT try to auto-detect whether the folder is "TV" or "Movies".
//   Instead it recursively walks EVERYTHING and classifies each video file
//   individually based on whether its name/path contains episode patterns.
//
//   TV episode   → SxxExx, NxNN, Exx patterns in filename
//   Movie        → everything else that passes junk filter
//
//   Shows are grouped by extracting the show title from the episode filename.
//   This means pack folders, season folders, flat folders all just work.
// ═══════════════════════════════════════════════════════════

function scanDirectory(rootPath, excludedPaths, userSettings) {
  const excluded = new Set((excludedPaths || []).map(p => p.toLowerCase()));
  function isExcluded(p) {
    const pl = p.toLowerCase();
    for (const ex of excluded) {
      if (pl === ex || pl.startsWith(ex + path.sep)) return true;
    }
    return false;
  }

  // Accumulators
  const movieMap  = new Map();  // filePath → movie object
  const showMap   = new Map();  // normalisedShowTitle → { title, episodes[] }

  // Walk every file recursively — no folder-type analysis
  function walk(dirPath) {
    if (isExcluded(dirPath)) return;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }

    // Collect video files at this level for folder-junk detection
    const dirVideos = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;
      try {
        const s = fs.statSync(path.join(dirPath, e.name));
        dirVideos.push({ name: e.name, size: s.size });
      } catch {}
    }
    const folderJunk = getFolderJunkFiles(dirVideos, userSettings);

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'System Volume Information') continue;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!isExcluded(fullPath)) walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;

      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      if (isJunkFile(entry.name, stat.size, userSettings, fullPath)) continue;
      if (folderJunk.has(entry.name)) continue;

      const epInfo = extractEpisodeInfo(entry.name);

      if (epInfo) {
        // ── TV episode ────────────────────────────────────────
        const dirBase = path.basename(dirPath);

        // Detect if we're inside a season folder and extract its number
        const seasonFolderMatch =
          /^season[\s._-]?(\d+)/i.exec(dirBase) ||
          /^s(\d{1,2})(?:\b|[\s._-]|$)/i.exec(dirBase) ||
          /\bseason[\s._-]?(\d+)/i.exec(dirBase) ||
          /\bs(\d{1,2})\b/i.exec(dirBase);
        const isSeasonDir = !!seasonFolderMatch;
        // If filename doesn't specify a season, inherit from the season folder
        const effectiveSeason = (epInfo.season !== 1 || !isSeasonDir)
          ? epInfo.season
          : (seasonFolderMatch ? parseInt(seasonFolderMatch[1]) : epInfo.season);

        // Extract show title from filename first
        let showTitle = extractShowTitle(entry.name);
        if (!showTitle) {
          if (isSeasonDir) {
            // Use grandparent folder (the actual show folder)
            const grandparent = path.basename(path.dirname(dirPath));
            showTitle = extractShowTitle(grandparent) || cleanTitle(grandparent);
          } else {
            showTitle = extractShowTitle(dirBase) || cleanTitle(dirBase);
          }
        }
        if (!showTitle) showTitle = 'Unknown Show';

        const norm = showTitle.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!showMap.has(norm)) showMap.set(norm, { title: showTitle, episodes: [] });

        showMap.get(norm).episodes.push({
          id: Buffer.from(fullPath).toString('base64')
                .replace(/[^a-zA-Z0-9]/g,'').substring(0,20) + '_' + stat.mtimeMs,
          path: fullPath,
          filename: entry.name,
          extension: ext,
          size: stat.size,
          sizeHuman: humanSize(stat.size),
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          season: effectiveSeason,
          episode: epInfo.episode,
        });
      } else {
        // ── Movie ─────────────────────────────────────────────
        // Parse title from folder chain (deepest folder with year wins)
        const parsed = parseMovieName(entry.name, fullPath);
        if (movieMap.has(fullPath)) continue; // dedup by path
        movieMap.set(fullPath, {
          id: Buffer.from(fullPath).toString('base64')
                .replace(/[^a-zA-Z0-9]/g,'').substring(0,20) + '_' + stat.mtimeMs,
          type: 'movie',
          path: fullPath,
          filename: entry.name,
          extension: ext,
          size: stat.size,
          sizeHuman: humanSize(stat.size),
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          title: parsed.title,
          displayTitle: parsed.title,
          year: parsed.year,
          metadata: null,
          posterPath: null,
          status: 'pending',
        });
      }
    }
  }

  walk(rootPath);

  // ── Merge multi-part movies (Cd1/Cd2, Part1/Part2, Disc1/Disc2) ────────────
  // Pattern: same base title + year, suffix differs only by part indicator
  const PART_RE = /[\s._\-]*(cd|disc|disk|part|pt)[\s._\-]*(\d+)$/i;
  const mergedMovies = new Map(); // mergeKey → lead movie entry
  for (const [filePath, movie] of movieMap) {
    const rawTitle = (movie.title || '').trim();
    const partM = rawTitle.match(PART_RE);
    if (partM) {
      const baseTitle = rawTitle.replace(PART_RE, '').trim();
      const mergeKey  = (baseTitle + '_' + (movie.year || '')).toLowerCase();
      if (mergedMovies.has(mergeKey)) {
        // Append this part to the existing entry
        const lead = mergedMovies.get(mergeKey);
        if (!lead.parts) lead.parts = [{ path: lead.path, filename: lead.filename, size: lead.size, sizeHuman: lead.sizeHuman }];
        lead.parts.push({ path: movie.path, filename: movie.filename, size: movie.size, sizeHuman: movie.sizeHuman });
        lead.size += movie.size;
        lead.sizeHuman = humanSize(lead.size);
        lead.filename = `${lead.parts.length} parts`;
      } else {
        // First part seen — normalise title, store as lead
        const lead = { ...movie, title: baseTitle, displayTitle: baseTitle };
        mergedMovies.set(mergeKey, lead);
      }
    } else {
      // No part suffix — store as-is using file path as key
      mergedMovies.set(filePath, movie);
    }
  }

  // Convert showMap to TV show objects
  const tvShows = [];
  for (const [norm, group] of showMap) {
    const eps = group.episodes.sort(
      (a,b) => (a.season*10000 + a.episode) - (b.season*10000 + b.episode)
    );
    const totalSize = eps.reduce((s,e) => s + e.size, 0);
    const seasons   = new Set(eps.map(e => e.season));
    // Use the deepest common ancestor path as the show root (stable regardless of episode order)
    const allDirs = eps.map(e => path.dirname(e.path));
    const showRootPath = allDirs.reduce((common, dir) => {
      let c = common;
      while (c && !dir.startsWith(c)) c = path.dirname(c);
      return c || common;
    }, allDirs[0]);
    tvShows.push({
      // ID based only on normalised title — stable across rescans and path changes
      id: 'tv_' + Buffer.from(
            (group.title || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '')
          ).toString('base64').replace(/[^a-zA-Z0-9]/g,'').substring(0,24),
      type: 'tv',
      path: showRootPath,
      title: group.title,
      displayTitle: group.title,
      episodes: eps,
      episodeCount: eps.length,
      seasonCount: seasons.size,
      size: totalSize,
      sizeHuman: humanSize(totalSize),
      createdAt: eps[0].createdAt,
      filename: `${eps.length} episodes`,
      metadata: null,
      posterPath: null,
      status: 'pending',
      year: null,
    });
  }

  return { movies: [...mergedMovies.values()], tvShows };
}


ipcMain.handle('save-file', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('read-file', async (event, { filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('clear-item-cache', async (event, ids) => {
  // Delete cached metadata and poster files for the given item IDs
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const id of (ids || [])) {
      const safeId = (id || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
      const prefix = `id_${safeId}`;
      files.filter(f => f.startsWith(prefix)).forEach(f => {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {}
      });
    }
  } catch {}
  return { ok: true };
});

ipcMain.handle('check-files-exist', async (event, { movies, tvShows }) => {
  // Returns lists of IDs for items whose files no longer exist on disk
  const missingMovieIds = [];
  const missingTVIds    = [];

  for (const movie of (movies || [])) {
    if (movie.path && !fs.existsSync(movie.path)) {
      missingMovieIds.push(movie.id);
    }
  }

  for (const show of (tvShows || [])) {
    // A show is missing if ALL its episodes are gone
    const eps = show.episodes || [];
    if (eps.length > 0 && eps.every(e => e.path && !fs.existsSync(e.path))) {
      missingTVIds.push(show.id);
    }
    // Partially missing — remove individual episodes
    // (returned separately so renderer can prune episodes without removing the whole show)
  }

  return { missingMovieIds, missingTVIds };
});

ipcMain.handle('scan-folders', async (event, folderPaths, excludedPaths, userSettings) => {
  const allMovies  = [];
  const allTVShows = [];
  const seenTVIds  = new Set();
  for (const folder of folderPaths) {
    const result = scanDirectory(folder, excludedPaths, userSettings);
    allMovies.push(...result.movies);
    for (const show of result.tvShows) {
      if (!seenTVIds.has(show.id)) { seenTVIds.add(show.id); allTVShows.push(show); }
    }
  }
  return { movies: allMovies, tvShows: allTVShows };
});

// ─── Cache ────────────────────────────────────────────────
const CACHE_DIR = path.join(os.homedir(), '.mediavault', 'cache');
const DB_PATH   = path.join(os.homedir(), '.mediavault', 'library.json');
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}
function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); downloadImage(res.headers.location, dest).then(resolve).catch(reject); return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'MediaVault/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

// ─── Metadata fetching ────────────────────────────────────
ipcMain.handle('fetch-metadata', async (event, item, tmdbKey, omdbKey) => {
  ensureCacheDir();
  // Use item.id (file-path hash) as the primary cache key — unique per file,
  // never collides between different titles. Fall back to title+year only if id missing.
  const itemId  = (item.id || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 40);
  const safeName = (item.title || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const cacheKey = itemId
    ? `id_${itemId}`
    : (item.type === 'tv' ? `tv_${safeName}` : `mv_${safeName}_${item.year || ''}`);
  const metaCachePath   = path.join(CACHE_DIR, `${cacheKey}_meta.json`);
  const posterCachePath = path.join(CACHE_DIR, `${cacheKey}_poster.jpg`);
  if (fs.existsSync(metaCachePath)) {
    const cached = JSON.parse(fs.readFileSync(metaCachePath, 'utf8'));
    cached.posterPath = fs.existsSync(posterCachePath) ? posterCachePath : null;
    return cached;
  }
  let meta = {};
  try {
    if (tmdbKey) {
      const searchType = item.type === 'tv' ? 'tv' : 'movie';
      const query = encodeURIComponent(item.title);
      const yearParam = item.year ? `&year=${item.year}` : '';
      const searchResult = await httpsGet(`https://api.themoviedb.org/3/search/${searchType}?api_key=${tmdbKey}&query=${query}${yearParam}`);
      if (searchResult.results && searchResult.results.length > 0) {
        const tmdbId = searchResult.results[0].id;
        if (item.type === 'movie') {
          const d = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`);
          meta.tmdbId = tmdbId; meta.overview = d.overview; meta.tagline = d.tagline;
          meta.releaseDate = d.release_date;
          meta.year = d.release_date ? d.release_date.substring(0, 4) : item.year;
          meta.runtime = d.runtime; meta.genres = (d.genres || []).map(g => g.name);
          meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
          if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
          if (d.backdrop_path) meta.backdropPath = d.backdrop_path;
          try {
            const credits = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${tmdbKey}`);
            meta.castFull = (credits.cast || []).slice(0, 15).map(p => ({ name: p.name, character: p.character, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null, order: p.order }));
            meta.crewFull = (credits.crew || []).filter(p => ['Director','Screenplay','Writer','Story'].includes(p.job)).slice(0, 6).map(p => ({ name: p.name, job: p.job, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
          } catch {}
        } else {
          const d = await httpsGet(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`);
          meta.tmdbId = tmdbId; meta.overview = d.overview; meta.firstAirDate = d.first_air_date;
          meta.year = d.first_air_date ? d.first_air_date.substring(0, 4) : null;
          meta.genres = (d.genres || []).map(g => g.name);
          meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
          meta.numberOfSeasons = d.number_of_seasons; meta.numberOfEpisodes = d.number_of_episodes;
          meta.status = d.status; meta.networks = (d.networks || []).map(n => n.name);
          if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
          if (d.backdrop_path) meta.backdropPath = d.backdrop_path;
          try {
            const credits = await httpsGet(`https://api.themoviedb.org/3/tv/${tmdbId}/aggregate_credits?api_key=${tmdbKey}`);
            meta.castFull = (credits.cast || []).slice(0, 15).map(p => ({ name: p.name, character: (p.roles && p.roles[0]) ? p.roles[0].character : '', profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null, order: p.order }));
            meta.crewFull = (credits.crew || []).filter(p => p.jobs && p.jobs.some(j => ['Director','Executive Producer','Creator','Writer'].includes(j.job))).slice(0, 6).map(p => ({ name: p.name, job: p.jobs[0]?.job || 'Creator', profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
          } catch {}
        }
      }
    }
    if (omdbKey) {
      const query = encodeURIComponent(item.title);
      const yearParam = item.year ? `&y=${item.year}` : '';
      const type = item.type === 'tv' ? '&type=series' : '&type=movie';
      const omdbSearch = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&s=${query}${yearParam}${type}`);
      if (omdbSearch.Search && omdbSearch.Search.length > 0) {
        const detail = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&i=${omdbSearch.Search[0].imdbID}`);
        meta.imdbId = omdbSearch.Search[0].imdbID;
        meta.imdbRating = detail.imdbRating !== 'N/A' ? detail.imdbRating : null;
        meta.imdbVotes  = detail.imdbVotes  !== 'N/A' ? detail.imdbVotes  : null;
        meta.rated      = detail.Rated      !== 'N/A' ? detail.Rated      : null;
        meta.director   = detail.Director   !== 'N/A' ? detail.Director   : null;
        meta.actors     = detail.Actors     !== 'N/A' ? detail.Actors     : null;
        meta.awards     = detail.Awards     !== 'N/A' ? detail.Awards     : null;
        if (!meta.posterUrl && detail.Poster && detail.Poster !== 'N/A') meta.posterUrl = detail.Poster;
      }
    }
    if (meta.posterUrl) {
      try { await downloadImage(meta.posterUrl, posterCachePath); meta.posterPath = posterCachePath; } catch {}
    }
    fs.writeFileSync(metaCachePath, JSON.stringify(meta, null, 2));
    return meta;
  } catch (err) { return { error: err.message }; }
});

// ─── Persistence ──────────────────────────────────────────
ipcMain.handle('save-library', async (event, library) => {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(library, null, 2));
  return true;
});
ipcMain.handle('load-library', async () => {
  if (fs.existsSync(DB_PATH)) { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return null; } }
  return null;
});
ipcMain.handle('open-file',   async (e, p) => shell.openPath(p));
ipcMain.handle('reveal-file', async (e, p) => shell.showItemInFolder(p));
ipcMain.handle('get-platform', () => process.platform);

// ─── Headshots ────────────────────────────────────────────
ipcMain.handle('fetch-headshots', async (event, castFull, crewFull) => {
  ensureCacheDir();
  const headshotDir = path.join(CACHE_DIR, 'headshots');
  if (!fs.existsSync(headshotDir)) fs.mkdirSync(headshotDir, { recursive: true });
  async function getHeadshot(person) {
    if (!person.profilePath) return null;
    const dest = path.join(headshotDir, `${person.name.replace(/[^a-zA-Z0-9]/g,'_').substring(0,30)}.jpg`);
    if (fs.existsSync(dest)) return dest;
    try { await downloadImage(person.profilePath, dest); return dest; } catch { return null; }
  }
  const allPeople = [...(castFull || []), ...(crewFull || [])];
  const results = {};
  for (let i = 0; i < Math.min(allPeople.length, 12); i += 4) {
    const batch = allPeople.slice(i, i + 4);
    const paths = await Promise.all(batch.map(p => getHeadshot(p)));
    batch.forEach((p, j) => { if (paths[j]) results[p.name] = paths[j]; });
  }
  return results;
});

// ─── Actor search ─────────────────────────────────────────
ipcMain.handle('search-person', async (event, name, tmdbKey) => {
  if (!tmdbKey) return { error: 'No TMDB key' };
  try {
    const result = await httpsGet(`https://api.themoviedb.org/3/search/person?api_key=${tmdbKey}&query=${encodeURIComponent(name)}`);
    if (!result.results || !result.results.length) return { error: 'Person not found' };
    const details = await httpsGet(`https://api.themoviedb.org/3/person/${result.results[0].id}?api_key=${tmdbKey}`);
    const credits = await httpsGet(`https://api.themoviedb.org/3/person/${result.results[0].id}/combined_credits?api_key=${tmdbKey}`);
    let profileLocalPath = null;
    if (details.profile_path) {
      ensureCacheDir();
      const headshotDir = path.join(CACHE_DIR, 'headshots');
      if (!fs.existsSync(headshotDir)) fs.mkdirSync(headshotDir, { recursive: true });
      const dest = path.join(headshotDir, `${details.name.replace(/[^a-zA-Z0-9]/g,'_').substring(0,30)}_profile.jpg`);
      if (!fs.existsSync(dest)) { try { await downloadImage(`https://image.tmdb.org/t/p/w500${details.profile_path}`, dest); } catch {} }
      if (fs.existsSync(dest)) profileLocalPath = dest;
    }
    const EXCLUDED_GENRE_IDS = new Set([10767, 10763, 10764, 10766]);
    const TALK_SHOW_KEYWORDS = /award|oscar|grammy|emmy|golden globe|kimmel|fallon|colbert|tonight show|late show|late night|daily show|snl|saturday night live|mtv movie|people's choice|critics choice|screen actors guild|sag award|bafta|cannes|sundance|aftershow|after show|reunion/i;
    function isLegitimateCredit(c) {
      if (c.media_type !== 'movie' && c.media_type !== 'tv') return false;
      if ((c.genre_ids || []).some(id => EXCLUDED_GENRE_IDS.has(id))) return false;
      if (TALK_SHOW_KEYWORDS.test(c.title || c.name || '')) return false;
      if (c.media_type === 'tv') {
        if ((c.episode_count || 0) <= 2 && (c.vote_count || 0) < 50) return false;
        if (!c.poster_path && (c.vote_count || 0) < 20) return false;
      }
      if (c.media_type === 'movie') {
        if ((c.vote_count || 0) < 5) return false;
        if ((c.order || 0) > 60 && (c.popularity || 0) < 2) return false;
      }
      return true;
    }
    const castCredits = (credits.cast || [])
      .filter(isLegitimateCredit)
      .filter((c, idx, arr) => arr.findIndex(x => x.id === c.id) === idx)
      .sort((a, b) => {
        const da = a.release_date || a.first_air_date || '0';
        const db = b.release_date || b.first_air_date || '0';
        return da !== db ? db.localeCompare(da) : (b.popularity || 0) - (a.popularity || 0);
      })
      .slice(0, 80)
      .map(c => ({
        tmdbId: c.id, mediaType: c.media_type, title: c.title || c.name,
        character: c.character, year: (c.release_date || c.first_air_date || '').substring(0, 4),
        releaseDate: c.release_date || c.first_air_date || '',
        posterPath: c.poster_path ? `https://image.tmdb.org/t/p/w185${c.poster_path}` : null,
        voteAverage: c.vote_average ? c.vote_average.toFixed(1) : null,
        episodeCount: c.episode_count || null,
      }));
    // Also extract directing/writing crew credits for library cross-reference
    // These are returned separately so the UI can match local files against them
    const CREW_JOBS = new Set(['Director','Creator','Writer','Screenplay','Story','Producer']);
    const crewCredits = (credits.crew || [])
      .filter(c => CREW_JOBS.has(c.job))
      .filter(isLegitimateCredit)
      .filter((c, idx, arr) => arr.findIndex(x => x.id === c.id) === idx)
      .sort((a, b) => {
        const da = a.release_date || a.first_air_date || '0';
        const db = b.release_date || b.first_air_date || '0';
        return da !== db ? db.localeCompare(da) : (b.popularity || 0) - (a.popularity || 0);
      })
      .slice(0, 60)
      .map(c => ({
        tmdbId: c.id, mediaType: c.media_type, title: c.title || c.name,
        character: c.job,
        year: (c.release_date || c.first_air_date || '').substring(0, 4),
        releaseDate: c.release_date || c.first_air_date || '',
        posterPath: c.poster_path ? `https://image.tmdb.org/t/p/w185${c.poster_path}` : null,
        voteAverage: c.vote_average ? c.vote_average.toFixed(1) : null,
      }));

    return {
      id: details.id, name: details.name, biography: details.biography,
      birthday: details.birthday, birthplace: details.place_of_birth,
      deathday: details.deathday, knownFor: details.known_for_department,
      profileUrl: details.profile_path ? `https://image.tmdb.org/t/p/w500${details.profile_path}` : null,
      profileLocalPath, filmography: castCredits, crewFilmography: crewCredits,
    };
  } catch (err) { return { error: err.message }; }
});

// ─── Watch providers ──────────────────────────────────────
ipcMain.handle('get-watch-providers', async (event, tmdbId, mediaType, tmdbKey, countryCode) => {
  if (!tmdbKey) return {};
  try {
    const result = await httpsGet(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${tmdbKey}`);
    const region = (result.results || {})[countryCode] || (result.results || {})['US'] || {};
    return {
      flatrate: (region.flatrate || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null, providerId: p.provider_id })),
      rent:     (region.rent     || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null, providerId: p.provider_id })),
      buy:      (region.buy      || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null, providerId: p.provider_id })),
      link: region.link || null,
    };
  } catch { return {}; }
});

// ─── Film posters ─────────────────────────────────────────
ipcMain.handle('fetch-film-posters', async (event, films) => {
  ensureCacheDir();
  const posterDir = path.join(CACHE_DIR, 'filmography');
  if (!fs.existsSync(posterDir)) fs.mkdirSync(posterDir, { recursive: true });
  const results = {};
  const toFetch = films.filter(f => f.posterPath).slice(0, 20);
  for (let i = 0; i < toFetch.length; i += 4) {
    const batch = toFetch.slice(i, i + 4);
    await Promise.all(batch.map(async film => {
      const dest = path.join(posterDir, `${film.mediaType}_${film.tmdbId}.jpg`);
      if (fs.existsSync(dest)) { results[film.tmdbId] = dest; return; }
      try { await downloadImage(film.posterPath, dest); results[film.tmdbId] = dest; } catch {}
    }));
  }
  return results;
});

// ─── Remap search ─────────────────────────────────────────
ipcMain.handle('remap-search', async (event, query, mediaType, tmdbKey) => {
  if (!tmdbKey) return { error: 'No TMDB key' };
  try {
    let directId = null; let directType = mediaType;
    const urlMatch = query.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    if (urlMatch) { directType = urlMatch[1]; directId = urlMatch[2]; }
    const idMatch = query.match(/^tmdb:(?:(movie|tv):)?(\d+)$/i);
    if (idMatch) { if (idMatch[1]) directType = idMatch[1]; directId = idMatch[2]; }
    if (!directId && query.match(/^\d{1,8}$/)) directId = query.trim();
    if (directId) {
      const type = directType || 'movie';
      const d = await httpsGet(`https://api.themoviedb.org/3/${type}/${directId}?api_key=${tmdbKey}`);
      if (d.id) return { results: [{ tmdbId: d.id, mediaType: type, title: d.title || d.name, year: (d.release_date || d.first_air_date || '').substring(0, 4), overview: d.overview, poster: d.poster_path ? `https://image.tmdb.org/t/p/w185${d.poster_path}` : null, rating: d.vote_average ? d.vote_average.toFixed(1) : null }] };
    }
    const searchTypes = (!mediaType || mediaType === 'unknown') ? ['movie', 'tv'] : [mediaType];
    const allResults = [];
    for (const st of searchTypes) {
      const r = await httpsGet(`https://api.themoviedb.org/3/search/${st}?api_key=${tmdbKey}&query=${encodeURIComponent(query)}&page=1`);
      (r.results || []).slice(0, 5).forEach(item => allResults.push({ tmdbId: item.id, mediaType: st, title: item.title || item.name, year: (item.release_date || item.first_air_date || '').substring(0, 4), overview: item.overview, poster: item.poster_path ? `https://image.tmdb.org/t/p/w185${item.poster_path}` : null, rating: item.vote_average ? item.vote_average.toFixed(1) : null }));
    }
    return { results: allResults.slice(0, 8) };
  } catch (err) { return { error: err.message }; }
});

// ─── Remap apply ──────────────────────────────────────────
ipcMain.handle('remap-apply', async (event, item, tmdbId, mediaType, tmdbKey, omdbKey) => {
  ensureCacheDir();
  const safeName = (item.title || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
  const oldKey = item.type === 'tv' ? `tv_${safeName}` : `mv_${safeName}_${item.year || ''}`;
  try { fs.unlinkSync(path.join(CACHE_DIR, `${oldKey}_meta.json`)); } catch {}
  const preview = await httpsGet(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${tmdbKey}`).catch(() => null);
  if (!preview) return { error: 'Could not fetch title details' };
  const newTitle = preview.title || preview.name || item.title;
  const newYear  = (preview.release_date || preview.first_air_date || '').substring(0, 4);
  const newSafe  = newTitle.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
  const newKey   = mediaType === 'tv' ? `tv_${newSafe}` : `mv_${newSafe}_${newYear}`;
  const metaPath   = path.join(CACHE_DIR, `${newKey}_meta.json`);
  const posterPath = path.join(CACHE_DIR, `${newKey}_poster.jpg`);
  if (fs.existsSync(metaPath)) {
    const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    cached.posterPath = fs.existsSync(posterPath) ? posterPath : null;
    return { meta: cached, newTitle, newType: mediaType };
  }
  let meta = {};
  try {
    if (mediaType === 'movie') {
      const d = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`);
      meta.tmdbId = parseInt(tmdbId); meta.overview = d.overview; meta.tagline = d.tagline;
      meta.releaseDate = d.release_date; meta.year = d.release_date ? d.release_date.substring(0, 4) : newYear;
      meta.runtime = d.runtime; meta.genres = (d.genres || []).map(g => g.name);
      meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
      if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
      try {
        const cr = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${tmdbKey}`);
        meta.castFull = (cr.cast || []).slice(0, 15).map(p => ({ name: p.name, character: p.character, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null, order: p.order }));
        meta.crewFull = (cr.crew || []).filter(p => ['Director','Screenplay','Writer','Story'].includes(p.job)).slice(0, 6).map(p => ({ name: p.name, job: p.job, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
      } catch {}
    } else {
      const d = await httpsGet(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`);
      meta.tmdbId = parseInt(tmdbId); meta.overview = d.overview; meta.firstAirDate = d.first_air_date;
      meta.year = d.first_air_date ? d.first_air_date.substring(0, 4) : null;
      meta.genres = (d.genres || []).map(g => g.name); meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
      meta.numberOfSeasons = d.number_of_seasons; meta.numberOfEpisodes = d.number_of_episodes;
      meta.status = d.status; meta.networks = (d.networks || []).map(n => n.name);
      if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
    }
    if (omdbKey && newTitle) {
      try {
        const type = mediaType === 'tv' ? '&type=series' : '&type=movie';
        const sr = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&s=${encodeURIComponent(newTitle)}&y=${newYear}${type}`);
        if (sr.Search && sr.Search.length > 0) {
          const d = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&i=${sr.Search[0].imdbID}`);
          meta.imdbId = sr.Search[0].imdbID;
          if (d.imdbRating !== 'N/A') meta.imdbRating = d.imdbRating;
          if (d.Rated !== 'N/A') meta.rated = d.Rated;
        }
      } catch {}
    }
    if (meta.posterUrl) { try { await downloadImage(meta.posterUrl, posterPath); meta.posterPath = posterPath; } catch {} }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { meta, newTitle, newType: mediaType };
  } catch (err) { return { error: err.message }; }
});

// ─── TMDB title search (non-library content) ──────────────
ipcMain.handle('search-title', async (event, query, tmdbKey, omdbKey) => {
  if (!tmdbKey) return { error: 'No TMDB key' };
  try {
    // Search both movie and tv
    const [mRes, tRes] = await Promise.all([
      httpsGet(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${encodeURIComponent(query)}&page=1`),
      httpsGet(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${encodeURIComponent(query)}&page=1`),
    ]);
    const results = [
      ...(mRes.results || []).slice(0, 5).map(r => ({ ...r, media_type: 'movie' })),
      ...(tRes.results || []).slice(0, 5).map(r => ({ ...r, media_type: 'tv' })),
    ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 8);
    return { results: results.map(r => ({
      tmdbId: r.id, mediaType: r.media_type,
      title: r.title || r.name,
      year: (r.release_date || r.first_air_date || '').substring(0, 4),
      overview: r.overview,
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
      rating: r.vote_average ? r.vote_average.toFixed(1) : null,
      popularity: r.popularity,
    })) };
  } catch (err) { return { error: err.message }; }
});

// ─── Full title detail for TMDB search page ───────────────
ipcMain.handle('fetch-title-detail', async (event, tmdbId, mediaType, tmdbKey, omdbKey, countryCode) => {
  if (!tmdbKey) return { error: 'No TMDB key' };
  try {
    let meta = {};
    if (mediaType === 'movie') {
      const d = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`);
      meta.tmdbId = tmdbId; meta.overview = d.overview; meta.tagline = d.tagline;
      meta.releaseDate = d.release_date; meta.year = d.release_date ? d.release_date.substring(0, 4) : null;
      meta.runtime = d.runtime; meta.genres = (d.genres || []).map(g => g.name);
      meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
      meta.title = d.title; meta.mediaType = 'movie';
      if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
      try {
        const cr = await httpsGet(`https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${tmdbKey}`);
        meta.castFull = (cr.cast || []).slice(0, 15).map(p => ({ name: p.name, character: p.character, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
        meta.crewFull = (cr.crew || []).filter(p => ['Director','Screenplay','Writer'].includes(p.job)).slice(0, 6).map(p => ({ name: p.name, job: p.job, profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
      } catch {}
    } else {
      const d = await httpsGet(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`);
      meta.tmdbId = tmdbId; meta.overview = d.overview; meta.firstAirDate = d.first_air_date;
      meta.year = d.first_air_date ? d.first_air_date.substring(0, 4) : null;
      meta.genres = (d.genres || []).map(g => g.name);
      meta.tmdbRating = d.vote_average ? d.vote_average.toFixed(1) : null;
      meta.numberOfSeasons = d.number_of_seasons; meta.numberOfEpisodes = d.number_of_episodes;
      meta.status = d.status; meta.networks = (d.networks || []).map(n => n.name);
      meta.title = d.name; meta.mediaType = 'tv';
      if (d.poster_path) meta.posterUrl = `https://image.tmdb.org/t/p/w500${d.poster_path}`;
      try {
        const cr = await httpsGet(`https://api.themoviedb.org/3/tv/${tmdbId}/aggregate_credits?api_key=${tmdbKey}`);
        meta.castFull = (cr.cast || []).slice(0, 15).map(p => ({ name: p.name, character: (p.roles && p.roles[0]) ? p.roles[0].character : '', profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
        meta.crewFull = (cr.crew || []).filter(p => p.jobs && p.jobs.some(j => ['Creator','Executive Producer','Director'].includes(j.job))).slice(0, 6).map(p => ({ name: p.name, job: p.jobs[0]?.job || 'Creator', profilePath: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null }));
      } catch {}
    }
    if (omdbKey && meta.title) {
      try {
        const type = mediaType === 'tv' ? '&type=series' : '&type=movie';
        const sr = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&s=${encodeURIComponent(meta.title)}&y=${meta.year || ''}${type}`);
        if (sr.Search && sr.Search.length > 0) {
          const d = await httpsGet(`https://www.omdbapi.com/?apikey=${omdbKey}&i=${sr.Search[0].imdbID}`);
          if (d.imdbRating !== 'N/A') meta.imdbRating = d.imdbRating;
          if (d.Rated !== 'N/A') meta.rated = d.Rated;
          if (d.Awards !== 'N/A') meta.awards = d.Awards;
          meta.imdbId = sr.Search[0].imdbID;
        }
      } catch {}
    }
    // Fetch streaming providers
    try {
      const wp = await httpsGet(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${tmdbKey}`);
      const region = (wp.results || {})[countryCode || 'US'] || (wp.results || {})['US'] || {};
      meta.streamingProviders = {
        flatrate: (region.flatrate || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null, providerId: p.provider_id })),
        rent:     (region.rent     || []).map(p => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null, providerId: p.provider_id })),
        link: region.link || null,
      };
    } catch {}
    return meta;
  } catch (err) { return { error: err.message }; }
});

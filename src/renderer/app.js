/* ═══════════════════════════════════════════════════════
   MediaVault — app.js v3
   Fixes: detail panel close, play, show-in-folder,
          settings tabs, poster not cut off
   New:   hide item, hide folder, hidden folders settings tab
═══════════════════════════════════════════════════════ */

const api = window.electronAPI;

const state = {
  library: [],       // movies (flat files)
  tvShows: [],       // TV shows (one card per series)
  filteredLibrary: [],
  folders: [],
  hiddenFolders: [],
  hiddenItems: [],
  settings: {
    tmdbKey: '', omdbKey: '',  // Not stored here — kept only for legacy migration check on load
    autoFetch: true, dlPosters: true,
    theme: 'dark', accentColor: '#7c5cfc',
    fontFamily: 'Outfit', fontSize: 'medium',
    gridSize: 'medium', animationsEnabled: true,
    showFileSize: true,
    textContrast: 0,
    movieDetailView: 'minimal',  // 'minimal' | 'frosted' | 'focused' | 'cinematic'
    tvDetailView:    'minimal',  // 'minimal' | 'frosted' | 'focused' | 'cinematic'
    countryCode: '',
    subscribedServices: [],
    junkKeywords: [],
    minFileSizeMb: 50,
    excludedFolders: [],
  },
  currentView: 'library',
  viewMode: 'grid',
  sortBy: 'title-asc',
  searchQuery: '',
  filterType: 'all',
  activeItem: null,
  fetchQueue: [],
  fetchingNow: false,
  metadataFetched: new Set(),
  groupByYear: false,
  selectedItems: new Set(),
  actorProfile: null,
  actorFilmFilter: 'all',
  actorStreamingData: {},
  previousView: 'library',
  excludedFolders: [],
  watchlist: [],
  watchlistVisited: false,
  navStack: [],
  tvGuideNotifications: [],
  tvGuideDismissed: new Set(), // persisted IDs of dismissed entries
  tvGuideVisited: false,
};

// ─── Score balloon helper ───────────────────────────────
function scoreMeta(score) {
  const n = parseFloat(score);
  if (isNaN(n)) return null;
  const p = n * 10;
  if (p >= 80) return { label:'MIGHTY', color:'#2dd4bf' };
  if (p >= 65) return { label:'STRONG', color:'#22c55e' };
  if (p >= 50) return { label:'FAIR',   color:'#f59e0b' };
  if (p >= 35) return { label:'WEAK',   color:'#f97316' };
  return             { label:'POOR',   color:'#ef4444' };
}

function scoreBalloonHTML(imdb, tmdb) {
  const s = imdb || tmdb;
  if (!s) return '';
  const m = scoreMeta(s);
  if (!m) return '';
  return `<div class="score-balloon" style="--bc:${m.color}">
    <span class="sb-src">${imdb ? 'IMDB' : 'TMDB'}</span>
    <span class="sb-val">${s}</span>
    <span class="sb-lbl">${m.label}</span>
  </div>`;
}

// ─── Init ────────────────────────────────────────────────
async function init() {
  const platform = await api.getPlatform();
  document.body.classList.add(`platform-${platform}`);

  loadSettings();
  applyTheme();

  // Load API keys from encrypted storage into state for runtime guard checks.
  // These are never written back to library.json — they are runtime-only.
  const { tmdbKey, omdbKey } = await api.loadApiKeys().catch(() => ({ tmdbKey: '', omdbKey: '' }));
  state.settings.tmdbKey = tmdbKey;
  state.settings.omdbKey = omdbKey;

  // ══════════════════════════════════════════════════════
  // STEP 1 — Register ALL event listeners FIRST.
  // Nothing below this block can prevent UI from working.
  // Data loading happens in Step 2.
  // ══════════════════════════════════════════════════════

  // Window controls
  document.getElementById('btn-minimize').onclick = () => api.windowMinimize();
  document.getElementById('btn-maximize').onclick = () => api.windowMaximize();
  document.getElementById('btn-close').onclick    = () => api.windowClose();

  // Navigation
  document.querySelectorAll('.nav-item').forEach(btn =>
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      if (btn.dataset.view === 'watchlist') {
        state.watchlistVisited = true;
        renderWatchlist();
        if (state.settings.tmdbKey) checkWatchlistStreaming(false);
        if (state.settings.tmdbKey) checkWatchlistNewSeasons(false);
        initWatchlistSearch();
      }
      if (btn.dataset.view === 'tvguide') {
        state.tvGuideVisited = true;
        renderTVGuide();
        updateTVGuideBadge();
      }
    }));
  updateWatchlistBadge();

  // Scan
  document.getElementById('scan-btn').addEventListener('click', handleAddFolder);
  document.getElementById('rescan-btn').addEventListener('click', () => handleRescan(false));
  document.getElementById('watchlist-check-streaming')?.addEventListener('click', async () => {
    await checkWatchlistStreaming(true);
    await checkWatchlistNewSeasons(true);
  });
  document.getElementById('tvguide-refresh-btn')?.addEventListener('click', () => refreshTVGuide(true));
  document.getElementById('check-updates-btn')?.addEventListener('click', () => checkForUpdates(true));
  document.getElementById('tvguide-clear-btn')?.addEventListener('click', () => {
    if (confirm('Clear all TV Guide notifications?')) {
      state.tvGuideNotifications = [];
      saveLibrary();
      renderTVGuide();
      updateTVGuideBadge();
    }
  });
  document.getElementById('empty-scan-btn').addEventListener('click', handleAddFolder);

  // Toolbar
  document.getElementById('search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase();
    applyFiltersAndSort();
  });
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.value.trim().length < 2) return;
    const query = e.target.value.trim();
    if (!state.settings.tmdbKey) { showToast('Add a TMDB key in Settings to search', 'info'); return; }
    openPersonSearch(query);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.selectedItems.size > 0) clearSelection();
  });
  document.getElementById('sort-select').addEventListener('change', e => {
    state.sortBy = e.target.value;
    state.groupByYear = (e.target.value === 'year-grouped');
    applyFiltersAndSort();
  });
  document.getElementById('grid-view-btn').addEventListener('click', () => setViewMode('grid'));
  document.getElementById('list-view-btn').addEventListener('click', () => setViewMode('list'));

  // Titlesearch back button
  document.getElementById('titlesearch-back-btn')?.addEventListener('click', () => {
    const dest = state.navStack.pop() || state.previousView || 'library';
    switchView(dest);
  });

  // Detail panel
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', closeDetail);

  document.getElementById('detail-play').addEventListener('click', () => {
    if (state.activeItem) api.openFile(state.activeItem.path);
  });
  document.getElementById('detail-reveal').addEventListener('click', () => {
    if (state.activeItem) api.revealFile(state.activeItem.path);
  });
  document.getElementById('detail-hide-item').addEventListener('click', () => {
    if (state.activeItem) { closeDetail(); hideItem(state.activeItem); }
  });

  // Options dropdown
  const optBtn  = document.getElementById('detail-options-btn');
  const optMenu = document.getElementById('detail-options-menu');
  optBtn.addEventListener('click', e => {
    e.stopPropagation();
    optMenu.style.display = optMenu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', e => {
    // Don't close options menu if click is inside the detail panel itself
    const panel = document.getElementById('detail-panel');
    if (panel && panel.contains(e.target)) return;
    optMenu.style.display = 'none';
  });

  document.getElementById('detail-remap').addEventListener('click', () => {
    optMenu.style.display = 'none';
    toggleRemapPanel(true);
  });
  document.getElementById('detail-fetch-meta').addEventListener('click', () => {
    optMenu.style.display = 'none';
    if (state.activeItem) {
      state.metadataFetched.delete(state.activeItem.id);
      fetchMetadataForItem(state.activeItem);
    }
  });
  document.getElementById('detail-reset-item').addEventListener('click', () => {
    optMenu.style.display = 'none';
    if (state.activeItem) { closeDetail(); resetItems([state.activeItem.id]); }
  });
  document.getElementById('detail-hide-option').addEventListener('click', () => {
    optMenu.style.display = 'none';
    if (state.activeItem) { closeDetail(); hideItem(state.activeItem); }
  });

  document.getElementById('remap-close').addEventListener('click', () => toggleRemapPanel(false));
  document.getElementById('remap-search-btn').addEventListener('click', () => doRemapSearch());
  document.getElementById('remap-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doRemapSearch();
  });

  // Force detail panel closed — must be closed on every startup
  document.getElementById('detail-panel').classList.remove('active');
  document.getElementById('detail-overlay').classList.remove('active');
  state.activeItem = null;

  // Settings and customisation
  initSettings(tmdbKey, omdbKey);
  initCustomisation();

  // ══════════════════════════════════════════════════════
  // STEP 2 — Load library data. Wrapped in try/catch so
  // any error or bad data CANNOT affect the UI above.
  // ══════════════════════════════════════════════════════
  loadLibraryData();
}

async function loadLibraryData() {
  const sanitiseItem = (item) => {
    // Spread item first so explicit keys below override stale values
    const base = { ...item };
    base.id           = item.id           || ('id_' + Math.random().toString(36).slice(2));
    base.type         = item.type         || 'movie';
    base.path         = item.path         || '';
    base.filename     = item.filename     || '';
    base.title        = item.title        || item.displayTitle || 'Unknown';
    base.displayTitle = item.displayTitle || item.title        || 'Unknown';
    base.size         = item.size         || 0;
    base.sizeHuman    = item.sizeHuman    || '0 B';
    base.createdAt    = item.createdAt    || new Date().toISOString();
    base.status       = item.status       || 'pending';
    base.metadata     = item.metadata     || null;
    base.posterPath   = item.posterPath   || null;
    base.year         = item.year         || null;
    base.episodeCount = item.episodeCount || null;
    base.seasonCount  = item.seasonCount  || null;
    base.episodes     = Array.isArray(item.episodes) ? item.episodes : null;
    return base;
  };

  try {
    const saved = await api.loadLibrary();
    if (!saved) return;

    const savedVersion = saved._version || 0;

    // Only discard if library has no version at all (very old format pre-tvShows)
    if (savedVersion === 0 && !saved.tvShows && !saved.library) {
      state.folders = saved.folders || [];
      updateFolderList();
      showToast('Library format updated — please re-scan your folders.', 'info');
      return;
    }

    state.library       = (saved.library       || []).map(sanitiseItem);
    state.tvShows       = (saved.tvShows       || []).map(sanitiseItem);

    // Deduplicate episodes within each show on load (case-insensitive path comparison).
    // Cleans up any duplicates that may have been introduced by previous merges.
    state.tvShows.forEach(show => {
      if (!Array.isArray(show.episodes)) return;
      const seen = new Set();
      show.episodes = show.episodes.filter(e => {
        const key = (e.path || '').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      show.episodeCount = show.episodes.length;
      show.seasonCount  = new Set(show.episodes.map(e => e.season)).size;
    });
    state.folders       = saved.folders       || [];
    state.hiddenFolders = saved.hiddenFolders || [];
    state.hiddenItems   = saved.hiddenItems   || [];
    state.excludedFolders = saved.excludedFolders || [];
    state.settings.excludedFolders = state.excludedFolders;
    if (saved.subscribedServices) state.settings.subscribedServices = saved.subscribedServices;
    state.watchlist = saved.watchlist || [];
    state.tvGuideNotifications = saved.tvGuideNotifications || [];
    state.tvGuideDismissed = new Set(saved.tvGuideDismissed || []);
    // Restore full settings from library.json (more reliable than localStorage in Electron)
    if (saved.settings) {
      Object.assign(state.settings, saved.settings);
      // Always clear discovered providers — we now use a curated list only
      state.settings.discoveredProviders = [];
      // Purge any subscribed services not in the curated list
      const CURATED_IDS = [8, 119, 1899, 337, 350, 149];
      state.settings.subscribedServices = (state.settings.subscribedServices || [])
        .filter(id => CURATED_IDS.includes(id));
    }

    state.library.forEach(f  => { if (f.metadata) state.metadataFetched.add(f.id); });
    state.tvShows.forEach(tv => { if (tv.metadata) state.metadataFetched.add(tv.id); });

    applyFiltersAndSort();
    updateStats();
    updateFolderList();
    updateHiddenFolderList();

  } catch (err) {
    console.error('[MediaVault] loadLibraryData error:', err);
    showToast('Could not load library — please re-scan your folders.', 'error');
  }

  // Show first-launch welcome if no country has been set
  if (!state.settings.countryCode) {
    showWelcomeModal();
  }

  // Re-evaluate existing library entries against junk filter
  // Catches files added before junk detection was improved
  if (state.library.length > 0) {
    const DEFAULT_JUNK_KW = ['sample','trailer','teaser','featurette','behind.the.scenes',
      'deleted.scene','interview','making.of','extra','bonus','short','readme','nfo'];
    const junkKw = [...DEFAULT_JUNK_KW, ...(state.settings.junkKeywords || [])];
    const minSizeMb = state.settings.minFileSizeMb != null ? state.settings.minFileSizeMb : 50;
    const before = state.library.length;
    state.library = state.library.filter(item => {
      const fname = (item.filename || item.path || '').toLowerCase();
      const fpath = (item.path || '').toLowerCase().replace(/\\/g, '/');
      const check = fname + '|' + fpath;
      if (junkKw.some(k => check.includes(k.toLowerCase()))) return false;
      if (minSizeMb > 0 && item.size && item.size < minSizeMb * 1024 * 1024) return false;
      return true;
    });
    if (state.library.length < before) {
      console.log(`[Junk cleanup] Removed ${before - state.library.length} junk entries`);
      saveLibrary();
    }
  }

  // Prune deleted files immediately on startup — before first render
  if (state.folders.length > 0) {
    pruneDeletedFiles(true).then(() => {
      // Then do the full rescan after a short delay
      setTimeout(() => handleRescan(true), 1500);
    });
  }

  // Check for new/upcoming seasons on watchlist TV shows
  if (state.watchlist.some(w => w.mediaType === 'tv') && state.settings.tmdbKey) {
    setTimeout(() => checkWatchlistNewSeasons(true), 3000);
  }
  // Populate TV Guide on startup
  if (state.settings.tmdbKey) {
    setTimeout(() => refreshTVGuide(false), 4500);
  }
  updateTVGuideBadge();

  // Silent update check on startup
  setTimeout(() => checkForUpdates(false), 5000);
}

function showWelcomeModal() {
  const overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;
  // Use flex to show (centered), none to hide
  overlay.style.setProperty('display', 'flex', 'important');

  const input = document.getElementById('welcome-country');
  const detected = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || '';
  if (detected) input.placeholder = `e.g. ${detected}`;

  function close() { overlay.style.setProperty('display', 'none', 'important'); }

  document.getElementById('welcome-skip').addEventListener('click', close);
  document.getElementById('welcome-save').addEventListener('click', () => {
    const code = input.value.trim().toUpperCase().substring(0, 2);
    if (code.length === 2) {
      state.settings.countryCode = code;
      saveSettings();
      // Also update the country input in Settings tab
      const settingsInput = document.getElementById('country-code');
      if (settingsInput) settingsInput.value = code;
      showToast(`Country set to ${code}`, 'success');
    }
    close();
  });
  // Enter key submits
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('welcome-save').click();
  });
  setTimeout(() => input.focus(), 100);
}

// ─── Navigation ──────────────────────────────────────────
function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  state.currentView = view;

  const map = { library:'library', movies:'library', tv:'library', settings:'settings', actor:'actor', titlesearch:'titlesearch', watchlist:'watchlist', tvguide:'tvguide' };
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === `view-${map[view] || 'library'}`));

  if      (view === 'movies')  { state.filterType = 'movie'; document.getElementById('view-title').textContent = 'Movies'; }
  else if (view === 'tv')      { state.filterType = 'tv';    document.getElementById('view-title').textContent = 'TV Shows'; }
  else if (view === 'library') { state.filterType = 'all';   document.getElementById('view-title').textContent = 'All Media'; }

  if (view !== 'settings' && view !== 'actor') applyFiltersAndSort();
}

function setViewMode(mode) {
  state.viewMode = mode;
  document.getElementById('grid-view-btn').classList.toggle('active', mode === 'grid');
  document.getElementById('list-view-btn').classList.toggle('active', mode === 'list');
  renderLibrary();
}

// ─── Folder scanning ─────────────────────────────────────
async function handleAddFolder() {
  const paths = await api.selectFolder();
  if (!paths) return;
  const newFolders = paths.filter(p => !state.folders.includes(p));
  if (!newFolders.length) { showToast('Folders already in library', 'info'); return; }
  state.folders.push(...newFolders);
  updateFolderList();
  showProgress(true, 'Scanning…', 0);
  showToast(`Scanning ${newFolders.length} folder(s)…`, 'info');
  try {
    const scanSettings = { junkKeywords: state.settings.junkKeywords, minFileSizeMb: state.settings.minFileSizeMb };
    const result = await api.scanFolders(newFolders, state.settings.excludedFolders, scanSettings);
    const existingMoviePaths = new Set(state.library.map(f => f.path));
    const existingTVPaths    = new Set(state.tvShows.map(s => s.path));
    const normTitle = t => (t||'').toLowerCase().replace(/[^a-z0-9]/g,'').trim();

    const freshMovies = (result.movies || []).filter(f =>
      !existingMoviePaths.has(f.path) &&
      !state.hiddenItems.includes(f.id) &&
      !state.hiddenFolders.some(hf => f.path.startsWith(hf))
    );

    const freshTV = [];
    for (const s of (result.tvShows || [])) {
      if (state.hiddenFolders.some(hf => (s.path||'').startsWith(hf))) continue;

      const existing = state.tvShows.find(ex =>
        ex.id === s.id ||
        normTitle(ex.title) === normTitle(s.title) ||
        (s.metadata?.tmdbId && ex.metadata?.tmdbId &&
          String(ex.metadata.tmdbId) === String(s.metadata.tmdbId))
      );

      if (existing) {
        const knownPaths = new Set((existing.episodes || []).map(e => (e.path||'').toLowerCase()));
        const newEps = (s.episodes || []).filter(e => !knownPaths.has((e.path||'').toLowerCase()));
        if (newEps.length) {
          existing.episodes = [...(existing.episodes || []), ...newEps]
            .sort((a, b) => (a.season * 10000 + a.episode) - (b.season * 10000 + b.episode));
          existing.episodeCount = existing.episodes.length;
          existing.seasonCount  = new Set(existing.episodes.map(e => e.season)).size;
          existing.size         = existing.episodes.reduce((n, e) => n + (e.size || 0), 0);
          existing.sizeHuman    = existing.size > 1073741824
            ? (existing.size / 1073741824).toFixed(1) + ' GB'
            : (existing.size / 1048576).toFixed(0) + ' MB';
        }
      } else if (!existingTVPaths.has((s.path||'').toLowerCase())) {
        freshTV.push(s);
      }
    }
    state.library.push(...freshMovies);
    state.tvShows.push(...freshTV);
    applyFiltersAndSort(); updateStats(); saveLibrary();
    showToast(`Found ${freshMovies.length} movie${freshMovies.length!==1?'s':''} and ${freshTV.length} TV show${freshTV.length!==1?'s':''}`, 'success');
    showProgress(false);
    const toFetch = [
      ...freshMovies.filter(f => !state.metadataFetched.has(f.id)),
      ...freshTV.filter(s => !state.metadataFetched.has(s.id)),
    ];
    if (toFetch.length && state.settings.autoFetch && (state.settings.tmdbKey || state.settings.omdbKey)) {
      state.fetchQueue.push(...toFetch);
      processFetchQueue();
    }
  } catch (err) {
    showToast(`Scan failed: ${err.message}`, 'error');
    showProgress(false);
  }
}

// ─── Hide item ────────────────────────────────────────────
function hideItem(item) {
  if (!state.hiddenItems.includes(item.id)) state.hiddenItems.push(item.id);
  state.library = state.library.filter(f => f.id !== item.id);
  state.tvShows = state.tvShows.filter(s => s.id !== item.id);
  state.metadataFetched.delete(item.id);
  closeDetail();
  applyFiltersAndSort();
  updateStats();
  saveLibrary();
  showToast(`"${item.displayTitle || item.title}" hidden`, 'info');
}

// ─── Hide folder ──────────────────────────────────────────
function hideFolder(folderPath) {
  if (!state.hiddenFolders.includes(folderPath)) state.hiddenFolders.push(folderPath);
  // Remove items from that folder
  const before = state.library.length;
  state.library = state.library.filter(f => !f.path.startsWith(folderPath));
  // Remove from watched folders too
  state.folders = state.folders.filter(f => f !== folderPath);
  saveLibrary();
  applyFiltersAndSort();
  updateStats();
  updateFolderList();
  updateHiddenFolderList();
  showToast(`Folder hidden (${before - state.library.length} items removed)`, 'info');
}

// ─── Metadata queue ───────────────────────────────────────
async function processFetchQueue() {
  if (state.fetchingNow || !state.fetchQueue.length) return;
  if (!state.settings.tmdbKey && !state.settings.omdbKey) return;
  state.fetchingNow = true;
  const total = state.fetchQueue.length;
  let done = 0;
  showProgress(true, 'Fetching metadata…', 0);
  while (state.fetchQueue.length) {
    const item = state.fetchQueue.shift();
    if (state.metadataFetched.has(item.id)) { done++; continue; }
    const libIdx = state.library.findIndex(f => f.id === item.id);
    const tvIdx  = libIdx === -1 ? state.tvShows.findIndex(s => s.id === item.id) : -1;
    if (libIdx === -1 && tvIdx === -1) { done++; continue; }
    const arr = libIdx !== -1 ? state.library : state.tvShows;
    const idx = libIdx !== -1 ? libIdx : tvIdx;
    arr[idx].status = 'loading';
    updateCardStatus(item.id, 'loading');
    try {
      const meta = await api.fetchMetadata(item);
      arr[idx].metadata   = meta;
      arr[idx].posterPath = meta.posterPath || null;
      arr[idx].status     = 'done';
      state.metadataFetched.add(item.id);
      updateCardWithMeta(item.id);
      if (state.activeItem?.id === item.id) {
        state.activeItem = arr[idx];
        renderDetailPanel(state.activeItem);
      }
    } catch { arr[idx].status = 'error'; updateCardStatus(item.id, 'error'); }
    done++;
    showProgress(true, `Fetching metadata… (${done}/${total})`, Math.round(done / total * 100));
    await new Promise(r => setTimeout(r, 260));
  }
  state.fetchingNow = false;
  showProgress(false);
  saveLibrary();
  applyFiltersAndSort();
  showToast('Metadata sync complete', 'success');
}

async function fetchMetadataForItem(item) {
  if (!state.settings.tmdbKey && !state.settings.omdbKey) {
    showToast('Add API keys in Settings first', 'info'); return;
  }
  const libIdx = state.library.findIndex(f => f.id === item.id);
  const tvIdx  = libIdx === -1 ? state.tvShows.findIndex(s => s.id === item.id) : -1;
  if (libIdx === -1 && tvIdx === -1) return;
  const arr = libIdx !== -1 ? state.library : state.tvShows;
  const idx = libIdx !== -1 ? libIdx : tvIdx;
  arr[idx].status = 'loading';
  document.getElementById('detail-loading').style.display = 'flex';
  try {
    const meta = await api.fetchMetadata(item);
    arr[idx].metadata   = meta;
    arr[idx].posterPath = meta.posterPath || null;
    arr[idx].status     = 'done';
    state.metadataFetched.add(item.id);
    // Only update activeItem/panel if THIS item is still the one being viewed
    if (state.activeItem && state.activeItem.id === item.id) {
      state.activeItem = arr[idx];
      // Re-render the appropriate panel
      const mode = item.type === 'tv' ? state.settings.tvDetailView : state.settings.movieDetailView;
      if (mode === 'frosted' || mode === 'focused' || mode === 'cinematic') {
        renderCinematicOverlay(arr[idx], mode);
      } else {
        renderDetailPanel(arr[idx]);
      }
    }
    updateCardWithMeta(item.id);
    saveLibrary();
  } catch { arr[idx].status = 'error'; showToast('Failed to fetch metadata', 'error'); }
  document.getElementById('detail-loading').style.display = 'none';
}

function triggerFullMetadataRefresh() {
  const unfetched = [
    ...state.library.filter(f => !state.metadataFetched.has(f.id)),
    ...state.tvShows.filter(s => !state.metadataFetched.has(s.id)),
  ];
  if (!unfetched.length) { showToast('All items already have metadata', 'info'); return; }
  state.fetchQueue.push(...unfetched);
  showToast(`Queued ${unfetched.length} items for metadata fetch`, 'info');
  processFetchQueue();
}

// ─── Search ───────────────────────────────────────────────
function itemMatches(item, q) {
  if (!q) return true;
  const m = item.metadata || {};
  return [
    item.title, item.displayTitle, item.filename,
    m.overview, m.director, m.actors, m.country, m.language,
    m.episodeName, m.episodeOverview,
    String(m.year || item.year || ''),
    (m.genres || []).join(' '),
  ].some(s => s && s.toLowerCase().includes(q));
}

// ─── Filter + Sort ────────────────────────────────────────
function applyFiltersAndSort() {
  const all = [
    ...state.library.filter(x => !state.hiddenItems.includes(x.id)),
    ...state.tvShows.filter(x => !state.hiddenItems.includes(x.id)),
  ];
  let f = all;
  if (state.filterType === 'movie') f = f.filter(x => x.type === 'movie');
  if (state.filterType === 'tv')    f = f.filter(x => x.type === 'tv');
  if (state.searchQuery) f = f.filter(x => itemMatches(x, state.searchQuery));
  const [key, dir] = state.sortBy.split('-');
  f.sort((a, b) => {
    let av, bv;
    if      (key === 'title')  { av = (a.displayTitle||a.title).toLowerCase(); bv = (b.displayTitle||b.title).toLowerCase(); }
    else if (key === 'size')   { av = a.size;  bv = b.size; }
    else if (key === 'date')   { av = new Date(a.createdAt); bv = new Date(b.createdAt); }
    else if (key === 'imdb')   { av = parseFloat(a.metadata?.imdbRating)||0; bv = parseFloat(b.metadata?.imdbRating)||0; }
    else if (key === 'rating') { av = parseFloat(a.metadata?.tmdbRating)||0; bv = parseFloat(b.metadata?.tmdbRating)||0; }
    else if (key === 'year') {
      // Use full release date for within-year ordering
      const getReleaseStr = x => x.metadata?.releaseDate || x.metadata?.firstAirDate || String(x.metadata?.year || x.year || '0');
      av = getReleaseStr(a); bv = getReleaseStr(b);
    }
    const c = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'asc' ? c : -c;
  });
  state.filteredLibrary = f;
  document.getElementById('view-count').textContent = `${f.length} items`;
  renderLibrary();
}

// ─── Render library ───────────────────────────────────────
function getItemYear(item) {
  return item.metadata?.year || item.metadata?.releaseDate?.substring(0,4) ||
         item.metadata?.firstAirDate?.substring(0,4) || item.year || null;
}

function renderLibrary() {
  const container = document.getElementById('media-grid');
  const isList = state.viewMode === 'list';
  const isGrouped = state.groupByYear && !isList;

  // When not grouped, container IS the grid
  // When grouped, container holds year sections each with their own inner grid
  // Set grid layout via inline style — no CSS class dependency
  if (isGrouped) {
    container.className = 'media-grid-grouped';
    container.style.cssText = 'display:flex; flex-direction:column;';
  } else if (isList) {
    container.className = 'media-grid list-mode';
    container.style.cssText = 'display:grid; grid-template-columns:1fr;';
  } else {
    container.className = 'media-grid';
    const colW = getPosterWidth();
    const gap  = { small: 14, medium: 18, large: 22 }[state.settings.gridSize] || 18;
    container.style.cssText = [
      'display:grid',
      `grid-template-columns:repeat(auto-fill, ${colW}px)`,
      `gap:${gap}px`,
      'grid-auto-flow:row',
      'justify-content:start',
      'align-content:start',
    ].join(';') + ';';
  }

  const hasNoMovies = !state.library.length && !state.tvShows.length;
  if (hasNoMovies) {
    container.innerHTML = '';
    container.appendChild(buildEmptyState());
    document.getElementById('view-count').textContent = '0 items';
    return;
  }
  container.innerHTML = '';
  if (!state.filteredLibrary.length) {
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.innerHTML = `<div class="empty-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><h2>No results</h2><p>Try searching by title, actor, director, genre or year</p>`;
    container.appendChild(el);
    return;
  }

  if (isGrouped) {
    // Group items by release year, newest first
    const groups = {};
    state.filteredLibrary.forEach(item => {
      const yr = getItemYear(item) || 'Unknown';
      if (!groups[yr]) groups[yr] = [];
      groups[yr].push(item);
    });
    // Sort years: numeric desc, 'Unknown' at bottom
    const years = Object.keys(groups).sort((a, b) => {
      if (a === 'Unknown') return 1;
      if (b === 'Unknown') return -1;
      return parseInt(b) - parseInt(a);
    });

    years.forEach(yr => {
      const section = document.createElement('div');
      section.className = 'year-section';

      const header = document.createElement('div');
      header.className = 'year-header';
      header.innerHTML = `<span class="year-label">${yr}</span><span class="year-count">${groups[yr].length} title${groups[yr].length!==1?'s':''}</span><div class="year-divider"></div>`;
      section.appendChild(header);

      const innerGrid = document.createElement('div');
      innerGrid.className = 'year-grid';
      const ygColW = getPosterWidth();
      const ygGap  = { small: 14, medium: 18, large: 22 }[state.settings.gridSize] || 18;
      innerGrid.style.cssText = `display:grid; grid-template-columns:repeat(auto-fill,${ygColW}px); gap:${ygGap}px; justify-content:start; align-items:start; align-content:start; padding-top:4px;`;
      groups[yr].forEach((item, i) => innerGrid.appendChild(buildGridCard(item, i)));
      section.appendChild(innerGrid);
      container.appendChild(section);
    });
  } else {
    state.filteredLibrary.forEach((item, i) =>
      container.appendChild(isList ? buildListCard(item) : buildGridCard(item, i)));
  }
}

function buildEmptyState() {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `<div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></div><h2>No media found</h2><p>Add a folder to start building your library</p><button class="btn-primary" id="empty-scan-btn2"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>Add Folder</button>`;
  el.querySelector('#empty-scan-btn2').addEventListener('click', handleAddFolder);
  return el;
}

function pSvg() {
  return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/></svg>`;
}

function getPosterHeight() {
  const h = { small: 240, medium: 315, large: 405 };
  return h[state.settings.gridSize] || 315;
}

function getPosterWidth() {
  const w = { small: 160, medium: 210, large: 270 };
  return w[state.settings.gridSize] || 210;
}

function getCardHeight() {
  return getPosterHeight() + 52; // poster + info strip
}

function buildGridCard(item, idx) {
  const m    = item.metadata || {};
  const isTV = item.type === 'tv';
  const year = m.year || item.year || '';
  const sub  = isTV
    ? (() => {
        const total = item.episodeCount || 0;
        const watched = (item.episodes||[]).filter(e=>e.watched).length;
        const watchedStr = watched > 0 ? ` · ${watched}/${total} ✓` : '';
        return `${item.seasonCount||1} season${(item.seasonCount||1)!==1?'s':''} · ${total||'?'} eps${year?' · '+year:''}${watchedStr}`;
      })()
    : (item.parts ? `${item.parts.length} parts${year ? ' · '+year : ''}` : (year || item.sizeHuman));

  const pH = getPosterHeight();
  const pW = getPosterWidth();

  // ── Wrapper card ──────────────────────────────────────
  const card = document.createElement('div');
  card.dataset.id = item.id;
  if (item.status === 'loading') card.className = 'mv-card mv-card-shimmer';
  else card.className = 'mv-card';
  // Explicit dimensions on the card itself
  // Explicit height = poster + info strip. This is what the grid row sizes to.
  const cardH = pH + 52; // 52px = title (2 lines max ~32px) + subtitle (~12px) + padding
  card.style.cssText = `width:${pW}px; height:${cardH}px; display:flex; flex-direction:column; cursor:pointer; border-radius:10px; overflow:hidden; background:var(--bg-2); border:1px solid var(--border); position:relative; flex-shrink:0; transition:transform 0.16s ease, box-shadow 0.16s ease;`;
  if (state.settings.animationsEnabled) card.style.animationDelay = `${Math.min(idx*25,250)}ms`;

  // ── Poster container ──────────────────────────────────
  const poster = document.createElement('div');
  poster.style.cssText = `width:${pW}px; height:${pH}px; position:relative; overflow:hidden; background:var(--bg-3); display:block;`;

  // Image or placeholder
  if (item.posterPath) {
    const img = document.createElement('img');
    img.src = toMediaUrl(item.posterPath);
    img.alt = item.title || '';
    img.loading = 'lazy';
    img.style.cssText = `width:100%; height:100%; object-fit:cover; object-position:center top; display:block; transition:transform 0.4s ease;`;
    const ph = document.createElement('div');
    ph.style.cssText = `display:none; width:100%; height:100%; align-items:center; justify-content:center; color:var(--t2);`;
    ph.innerHTML = pSvg();
    img.onerror = () => { img.style.display='none'; ph.style.display='flex'; };
    poster.appendChild(img);
    poster.appendChild(ph);
  } else {
    const ph = document.createElement('div');
    ph.style.cssText = `display:flex; width:100%; height:100%; align-items:center; justify-content:center; color:var(--t2);`;
    ph.innerHTML = pSvg();
    poster.appendChild(ph);
  }

  // Gradient overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:absolute; inset:0; background:linear-gradient(to top,rgba(0,0,0,.75) 0%,transparent 55%); opacity:0; transition:opacity 0.16s ease; pointer-events:none;`;
  poster.appendChild(overlay);

  // Play button
  const play = document.createElement('button');
  play.style.cssText = `position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) scale(0.8); width:42px; height:42px; border-radius:50%; background:rgba(255,255,255,0.9); border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#111; opacity:0; transition:opacity 0.16s ease, transform 0.16s ease; backdrop-filter:blur(4px);`;
  play.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>`;
  poster.appendChild(play);


  // Score balloon
  const score = m.imdbRating || m.tmdbRating;
  if (score) {
    const sm = scoreMeta(score);
    if (sm) {
      const balloon = document.createElement('div');
      balloon.style.cssText = `position:absolute; bottom:10px; right:10px; display:flex; flex-direction:column; align-items:center; min-width:44px; padding:4px 7px 3px; border-radius:7px; border:1.5px solid ${sm.color}; background:rgba(0,0,0,.78); backdrop-filter:blur(6px); line-height:1; gap:1px;`;
      balloon.innerHTML = `<span style="font-size:7px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${sm.color};opacity:.85;">${m.imdbRating ? 'IMDB' : 'TMDB'}</span><span style="font-size:15px;font-weight:900;color:${sm.color};font-family:'DM Mono',monospace;line-height:1.15;">${score}</span><span style="font-size:6.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${sm.color};opacity:.85;">${sm.label}</span>`;
      poster.appendChild(balloon);
    }
  }

  // Status dot removed — metadata state is obvious from poster/rating presence

  // ── Info strip ────────────────────────────────────────
  const info = document.createElement('div');
  info.style.cssText = `padding:9px 10px 11px;`;

  const title = document.createElement('div');
  title.textContent = item.displayTitle || item.title || '';
  title.style.cssText = `font-size:12px; font-weight:600; line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; margin-bottom:3px; color:var(--t0);`;

  const subEl = document.createElement('div');
  subEl.textContent = sub;
  subEl.style.cssText = `font-size:10px; color:var(--t2); font-family:'DM Mono',monospace;`;

  info.appendChild(title);
  info.appendChild(subEl);

  // ── Assemble ──────────────────────────────────────────
  card.appendChild(poster);
  card.appendChild(info);

  // ── Hover effects ─────────────────────────────────────
  card.addEventListener('mouseenter', () => {
    card.style.transform = 'translateY(-3px)';
    card.style.boxShadow = '0 8px 32px rgba(0,0,0,.5)';
    overlay.style.opacity = '1';
    play.style.opacity = '1';
    play.style.transform = 'translate(-50%,-50%) scale(1)';
    const img = poster.querySelector('img');
    if (img) img.style.transform = 'scale(1.04)';
  });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.boxShadow = '';
    overlay.style.opacity = '0';
    play.style.opacity = '0';
    play.style.transform = 'translate(-50%,-50%) scale(0.8)';
    const img = poster.querySelector('img');
    if (img) img.style.transform = '';
  });

  // ── Click handlers ────────────────────────────────────
  card.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleCardSelection(item, card);
    } else if (state.selectedItems.size > 0) {
      // Any click when selection is active extends/removes selection
      toggleCardSelection(item, card);
    } else {
      openDetail(item);
    }
  });
  play.addEventListener('click', e => {
    e.stopPropagation();
    if (item.type === 'tv') {
      // TV shows: open the detail panel (folder access is in the detail panel already)
      openDetail(item);
    } else {
      api.openFile(item.path);
    }
  });



  return card;
}

function buildListCard(item) {
  const card = document.createElement('div');
  card.className = 'media-card-list';
  card.dataset.id = item.id;
  const m = item.metadata || {};
  const isTV = item.type === 'tv';
  const year = m.year || item.year || '—';
  const score = m.imdbRating || m.tmdbRating;
  const sm = score ? scoreMeta(score) : null;
  const ep = isTV
    ? `${item.seasonCount||1} season${(item.seasonCount||1)!==1?'s':''} · ${item.episodeCount||'?'} eps`
    : year;
  const date = new Date(item.createdAt).toLocaleDateString('en-GB', {year:'numeric',month:'short',day:'numeric'});

  card.innerHTML = `
    <div class="list-thumb">${item.posterPath ? `<img src="${esc(toMediaUrl(item.posterPath))}" loading="lazy" onerror="this.style.display='none'">` : `<div class="list-thumb-placeholder">${pSvg()}</div>`}</div>
    <div class="list-info">
      <div class="list-title">${esc(item.displayTitle||item.title)}</div>
      <div class="list-sub">
        <span>${esc(ep)}</span>
        ${m.genres?.length ? `<span>·</span><span>${m.genres.slice(0,2).map(esc).join(', ')}</span>` : ''}
        ${m.director ? `<span>·</span><span>${esc(m.director.split(',')[0])}</span>` : ''}
      </div>
    </div>
    <div class="list-meta">
      <span class="list-type-badge ${isTV ? 'badge-tv' : 'badge-movie'}">${isTV ? 'TV' : 'Movie'}</span>
      ${sm ? `<div class="list-score-pill" style="--bc:${sm.color}"><span class="lsp-val">${score}</span><span class="lsp-lbl">${sm.label}</span></div>` : '<span style="color:var(--t2);font-size:11px">—</span>'}
      ${state.settings.showFileSize ? `<span class="list-size">${item.sizeHuman}</span>` : ''}
      <span class="list-date">${date}</span>
    </div>`;
  card.addEventListener('click', () => openDetail(item));
  return card;
}

function updateCardStatus(id, status) {
  const card = document.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const dot = card.querySelector('.card-meta-dot');
  if (dot) dot.className = `card-meta-dot status-${status}`;
  card.classList.toggle('card-shimmer', status === 'loading');
}

function updateCardWithMeta(id) {
  const item = state.library.find(f => f.id === id) || state.tvShows.find(s => s.id === id);
  const card = document.querySelector(`[data-id="${id}"]`);
  if (!item || !card) return;
  const newCard = state.viewMode === 'grid' ? buildGridCard(item, 0) : buildListCard(item);
  if (state.selectedItems.has(id)) applySelectionStyle(newCard, true);
  card.replaceWith(newCard);
}

// ─── Detail panel ─────────────────────────────────────────
function openDetail(item) {
  state.activeItem = item;
  const mode = item.type === 'tv' ? state.settings.tvDetailView : state.settings.movieDetailView;
  if (mode === 'frosted' || mode === 'focused' || mode === 'cinematic' || mode === 'detailed') {
    openDetailedOverlay(item, mode);
  } else {
    renderDetailPanel(item);
    document.getElementById('detail-panel').classList.add('active');
    document.getElementById('detail-overlay').classList.add('active');
    document.getElementById('detail-loading').style.display = 'none';
    if (!state.metadataFetched.has(item.id) && (state.settings.tmdbKey || state.settings.omdbKey))
      fetchMetadataForItem(item);
  }
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('active');
  document.getElementById('detail-overlay').classList.remove('active');
  toggleRemapPanel(false);
  state.activeItem = null;
}

function renderDetailPanel(item) {
  const m = item.metadata || {};

  const posterEl = document.getElementById('detail-poster');
  const placeholderEl = document.getElementById('detail-poster-placeholder');
  if (item.posterPath) {
    posterEl.src = toMediaUrl(item.posterPath);
    posterEl.onload  = () => { posterEl.classList.add('loaded'); placeholderEl.style.display = 'none'; };
    posterEl.onerror = () => { posterEl.classList.remove('loaded'); placeholderEl.style.display = 'flex'; };
  } else {
    posterEl.classList.remove('loaded');
    posterEl.src = '';
    placeholderEl.style.display = 'flex';
  }

  document.getElementById('detail-badges').innerHTML = [
    item.type === 'tv' ? '<span class="badge badge-tv">TV Series</span>' : '',
    (m.year || item.year) ? `<span class="badge badge-year">${m.year || item.year}</span>` : '',
    m.rated ? `<span class="badge badge-rated">${m.rated}</span>` : '',
    ...(m.genres || []).slice(0,3).map(g => `<span class="badge badge-genre">${g}</span>`),
  ].join('');

  document.getElementById('detail-title').textContent = item.displayTitle || item.title;

  const epLabel = document.getElementById('detail-episode');
  if (item.type === 'tv') {
    const totalEps = item.episodeCount || (item.episodes ? item.episodes.length : 0);
    const seasons  = item.seasonCount  || (item.episodes ? new Set(item.episodes.map(e=>e.season)).size : 1);
    epLabel.textContent = `${seasons} Season${seasons!==1?'s':''} · ${totalEps} Episode${totalEps!==1?'s':''}`;

    const box = document.getElementById('detail-episode-info');
    if (item.episodes && item.episodes.length > 0) {
      box.style.display = 'block';
      const epCont = document.getElementById('detail-ep-overview');
      epCont.innerHTML = '';
      renderTVEpisodePanel(item, m, epCont);
    } else {
      box.style.display = 'none';
    }
  } else {
    epLabel.textContent = '';
    document.getElementById('detail-episode-info').style.display = 'none';
  }

  const ratings = document.getElementById('detail-ratings');
  // Show IMDB preferably, fall back to TMDB — avoid showing both
  const ratingScore = m.imdbRating || m.tmdbRating;
  const ratingSource = m.imdbRating ? 'IMDB' : 'TMDB';
  if (ratingScore) {
    const sm = scoreMeta(ratingScore);
    ratings.innerHTML = `<div class="detail-score-balloon" style="--bc:${sm?.color||'#888'}">
      <span class="dsb-source">${ratingSource}</span>
      <span class="dsb-value">${ratingScore}</span>
      <span class="dsb-label">${sm?.label||''}</span>
    </div>`;
  } else {
    ratings.innerHTML = '';
  }

  document.getElementById('detail-overview').textContent = m.overview || 'No description available.';

  // Show/hide Play button for TV shows (no single file to open)
  const playBtn   = document.getElementById('detail-play');
  const revealBtn = document.getElementById('detail-reveal');
  if (item.type === 'tv') {
    if (playBtn)   playBtn.style.display   = 'none';
    if (revealBtn) revealBtn.style.display = 'flex';
  } else {
    if (playBtn)   playBtn.style.display   = item.path ? 'inline-flex' : 'none';
    if (revealBtn) revealBtn.style.display = item.path ? 'flex'        : 'none';
  }

  // Streaming banner — inline next to rating
  const streamingWrap = document.getElementById('detail-streaming-banner');
  if (streamingWrap) streamingWrap.innerHTML = '';
  if (m.tmdbId && state.settings.tmdbKey) {
    const country = state.settings.countryCode ||
      Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';
    api.getWatchProviders(m.tmdbId, item.type === 'tv' ? 'tv' : 'movie', country)
      .then(providers => {
        const el = document.getElementById('detail-streaming-banner');
        if (el && providers) el.innerHTML = buildStreamingBanner(providers);
      }).catch(() => {});
  }

  // File info collapsible
  const fiSection = document.getElementById('detail-fileinfo');
  const fiRows    = document.getElementById('detail-fileinfo-rows');
  const fiToggle  = document.getElementById('detail-fileinfo-toggle');
  if (fiSection && fiRows && fiToggle) {
    const rows = [];
    if (item.filename)  rows.push(['File',    item.filename]);
    if (item.sizeHuman) rows.push(['Size',    item.sizeHuman]);
    if (item.createdAt) rows.push(['Added',   new Date(item.createdAt).toLocaleDateString()]);
    if (m.awards)       rows.push(['Awards',  m.awards]);
    if (m.imdbId)       rows.push(['IMDB ID', m.imdbId]);
    if (item.path)      rows.push(['Path',    item.path]);
    if (rows.length) {
      fiSection.style.display = 'flex';
      fiRows.innerHTML = rows.map(([l,v]) =>
        `<div class="detail-fileinfo-row"><span class="detail-fileinfo-label">${esc(l)}</span><span class="detail-fileinfo-value">${esc(String(v))}</span></div>`
      ).join('');
      const newToggle = fiToggle.cloneNode(true);
      fiToggle.parentNode.replaceChild(newToggle, fiToggle);
      let fiOpen = false;
      newToggle.addEventListener('click', () => {
        fiOpen = !fiOpen;
        fiRows.style.display = fiOpen ? 'flex' : 'none';
        newToggle.querySelector('svg').style.transform = fiOpen ? 'rotate(90deg)' : '';
      });
    } else {
      fiSection.style.display = 'none';
    }
  }

  // ── Divider + cast panel ───────────────────────────────────
  const infoGrid = document.getElementById('detail-info-grid');
  infoGrid.innerHTML = '';
  const dividerEl = document.createElement('div');
  dividerEl.style.cssText = 'height:1px;background:var(--border);margin:8px 0 16px;';
  infoGrid.appendChild(dividerEl);

  // Render whatever cast data we have immediately (may be chip-only from OMDB)
  function renderCastFromCSV(label, csvString, isDirector) {
    if (!csvString) return;
    const people = csvString.split(',').map(s => s.trim()).filter(Boolean).slice(0, isDirector ? 3 : 10);
    if (!people.length) return;
    const section = document.createElement('div');
    section.className = 'people-section';
    section.innerHTML = '<div class="people-label">' + label + '</div><div class="people-chips">' +
      people.map(p => '<button class="person-chip' + (isDirector ? ' director-chip' : '') +
        '" data-person="' + esc(p) + '">' + esc(p) + '</button>').join('') + '</div>';
    section.querySelectorAll('.person-chip').forEach(chip => bindPersonChip(chip));
    infoGrid.appendChild(section);
  }

  function bindPersonChip(chip) {
    chip.addEventListener('click', () => {
      closeDetail();
      openActorProfile(chip.dataset.person);
    });
  }

  function renderCastRows(label, people, headshots) {
    if (!people || !people.length) return;
    const section = document.createElement('div');
    section.className = 'cast-section';
    section.innerHTML = '<div class="cast-section-label">' + label + '</div>';
    const list = document.createElement('div');
    list.className = 'cast-list';
    people.forEach(person => {
      const row = document.createElement('button');
      row.className = 'cast-row';
      row.dataset.person = person.name;
      const imgSrc = headshots && headshots[person.name]
        ? toMediaUrl(headshots[person.name])
        : '';
      const avatarHtml = imgSrc
        ? `<img class="cast-avatar" src="${imgSrc}" alt="${esc(person.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
      const initials = person.name.split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
      row.innerHTML = `
        ${avatarHtml}
        <div class="cast-avatar-placeholder" style="display:${imgSrc?'none':'flex'}">${initials}</div>
        <div class="cast-info">
          <span class="cast-name">${esc(person.name)}</span>
          <span class="cast-role">${esc(person.character || person.job || '')}</span>
        </div>
        <svg class="cast-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
      row.addEventListener('click', () => {
        closeDetail();
        openActorProfile(person.name);
      });
      list.appendChild(row);
    });
    section.appendChild(list);
    infoGrid.appendChild(section);
  }

  // Start with OMDB fallback chips (available immediately)
  if (!m.castFull && !m.crewFull) {
    if (m.director) renderCastFromCSV('Director', m.director, true);
    if (m.actors)   renderCastFromCSV('Cast', m.actors, false);
  } else {
    // We have full TMDB credits — render IMDB-style rows
    // First render without headshots, then fetch and update
    if (m.crewFull && m.crewFull.length) renderCastRows('Creative Team', m.crewFull, null);
    if (m.castFull && m.castFull.length) renderCastRows('Cast', m.castFull, null);

    // Lazy-fetch headshots only if not already cached on the metadata
    if (!m.headshotsFetched && (m.castFull?.length || m.crewFull?.length)) {
      api.fetchHeadshots(m.castFull || [], m.crewFull || []).then(headshots => {
        if (!headshots || !Object.keys(headshots).length) return;
        // Update avatar images in the already-rendered rows
        infoGrid.querySelectorAll('.cast-row').forEach(row => {
          const name = row.dataset.person;
          if (headshots[name]) {
            const img = row.querySelector('.cast-avatar');
            const placeholder = row.querySelector('.cast-avatar-placeholder');
            if (img) {
              img.src = toMediaUrl(headshots[name]);
              img.style.display = '';
              if (placeholder) placeholder.style.display = 'none';
            } else {
              // Create img element
              const newImg = document.createElement('img');
              newImg.className = 'cast-avatar';
              newImg.src = toMediaUrl(headshots[name]);
              newImg.alt = name;
              newImg.loading = 'lazy';
              if (placeholder) placeholder.style.display = 'none';
              row.insertBefore(newImg, row.firstChild);
            }
          }
        });
        // Cache that we've fetched headshots so we don't re-fetch
        const libIdx = state.library.findIndex(f => f.id === state.activeItem?.id);
        const tvIdx  = state.tvShows.findIndex(s => s.id === state.activeItem?.id);
        const arr = libIdx !== -1 ? state.library : (tvIdx !== -1 ? state.tvShows : null);
        const idx = libIdx !== -1 ? libIdx : tvIdx;
        if (arr && idx !== -1 && arr[idx].metadata) {
          arr[idx].metadata.headshotsFetched = true;
          arr[idx].metadata.headshots = headshots;
        }
      }).catch(() => {});
    } else if (m.headshots) {
      // Re-render with cached headshots
      infoGrid.innerHTML = '';
      if (m.crewFull && m.crewFull.length) renderCastRows('Creative Team', m.crewFull, m.headshots);
      if (m.castFull && m.castFull.length) renderCastRows('Cast', m.castFull, m.headshots);
    }
  }

  // Remaining metadata rows
  const rows = [
    ['File',   item.filename],
    ['Size',   item.sizeHuman],
    ['Added',  new Date(item.createdAt).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'numeric'})],
    ...(m.runtime      ? [['Runtime',  m.runtime + ' min']] : []),
    ...(m.country      ? [['Country',  m.country]] : []),
    ...(m.language     ? [['Language', m.language]] : []),
    ...(m.awards && m.awards !== 'N/A' ? [['Awards', m.awards]] : []),
    ...(item.type==='tv'&&m.numberOfSeasons ? [['Seasons', String(m.numberOfSeasons)]] : []),
    ...(m.networks && m.networks.length ? [['Network', m.networks.join(', ')]] : []),
    ...(m.imdbId       ? [['IMDB ID',  m.imdbId]] : []),
  ];
  if (rows.length) {
    const gridEl = document.createElement('div');
    gridEl.className = 'detail-meta-rows';
    gridEl.innerHTML = rows.map(function(rv) {
      return '<span class="info-label">' + esc(rv[0]) + '</span><span class="info-value">' + esc(String(rv[1])) + '</span>';
    }).join('');
    infoGrid.appendChild(gridEl);
  }
}

// ─── Settings ─────────────────────────────────────────────
function initSettings(tmdbKey, omdbKey) {
  const tmdbIn = document.getElementById('tmdb-key');
  const omdbIn = document.getElementById('omdb-key');
  // Keys already loaded in init() — populate inputs and dataset immediately,
  // no async gap during which a Save click could wipe the other key.
  if (tmdbKey) tmdbIn.value = tmdbKey;
  if (omdbKey) omdbIn.value = omdbKey;
  tmdbIn.dataset.saved = tmdbKey || '';
  omdbIn.dataset.saved = omdbKey || '';
  document.getElementById('auto-fetch').checked  = state.settings.autoFetch;
  document.getElementById('dl-posters').checked  = state.settings.dlPosters;

  document.getElementById('save-tmdb').addEventListener('click', async () => {
    const nk = tmdbIn.value.trim();
    const isNew = nk && nk !== tmdbIn.dataset.saved;
    await api.saveApiKeys({ tmdbKey: nk, omdbKey: omdbIn.dataset.saved || '' });
    tmdbIn.dataset.saved = nk;
    state.settings.tmdbKey = nk;
    showToast('TMDB key saved', 'success');
    if (isNew) triggerFullMetadataRefresh();
  });
  document.getElementById('save-omdb').addEventListener('click', async () => {
    const nk = omdbIn.value.trim();
    const isNew = nk && nk !== omdbIn.dataset.saved;
    await api.saveApiKeys({ tmdbKey: tmdbIn.dataset.saved || '', omdbKey: nk });
    omdbIn.dataset.saved = nk;
    state.settings.omdbKey = nk;
    showToast('OMDB key saved', 'success');
    if (isNew) triggerFullMetadataRefresh();
  });

  document.getElementById('auto-fetch').addEventListener('change',  e => { state.settings.autoFetch  = e.target.checked; saveSettings(); });
  document.getElementById('dl-posters').addEventListener('change',  e => { state.settings.dlPosters  = e.target.checked; saveSettings(); });
  document.getElementById('settings-add-folder').addEventListener('click', handleAddFolder);

  document.getElementById('export-watchlist').addEventListener('click', exportWatchlist);
  document.getElementById('import-watchlist').addEventListener('click', importWatchlist);
  document.getElementById('export-tv-progress').addEventListener('click', exportTVProgress);
  document.getElementById('import-tv-progress').addEventListener('click', importTVProgress);

  document.getElementById('refresh-all-meta').addEventListener('click', () => {
    state.metadataFetched.clear();
    state.library.forEach(f => { f.metadata = null; f.posterPath = null; f.status = 'pending'; });
    saveLibrary(); renderLibrary(); triggerFullMetadataRefresh();
  });

  // Country code (now in Streaming tab)
  const countryIn = document.getElementById('country-code');
  if (countryIn) {
    if (state.settings.countryCode) countryIn.value = state.settings.countryCode;
    const detected = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';
    countryIn.placeholder = `e.g. ${detected}`;
    document.getElementById('save-country')?.addEventListener('click', () => {
      state.settings.countryCode = countryIn.value.trim().toUpperCase().substring(0, 2);
      saveSettings();
      showToast(`Country set to ${state.settings.countryCode || 'auto-detect'}`, 'success');
      renderStreamingServicesList();
    });
  }

  // Excluded folders
  document.getElementById('add-excluded-folder')?.addEventListener('click', async () => {
    const paths = await api.selectFolder();
    if (!paths) return;
    paths.forEach(p => {
      if (!state.excludedFolders.includes(p)) {
        state.excludedFolders.push(p);
        state.settings.excludedFolders = state.excludedFolders;
        // Remove any already-scanned items from that path
        state.library = state.library.filter(f => !f.path.startsWith(p));
        state.tvShows = state.tvShows.filter(s => !s.path.startsWith(p));
      }
    });
    saveLibrary();
    applyFiltersAndSort();
    updateStats();
    renderExcludedFolderList();
    showToast(`${paths.length} folder(s) excluded`, 'info');
  });
  renderExcludedFolderList();
  renderStreamingServicesList();

  // Scan filter settings
  const minSizeEl = document.getElementById('min-file-size');
  const junkKwEl  = document.getElementById('junk-keywords');
  if (minSizeEl) minSizeEl.value = state.settings.minFileSizeMb ?? 50;
  if (junkKwEl)  junkKwEl.value  = (state.settings.junkKeywords || []).join(', ');
  document.getElementById('save-scan-filters')?.addEventListener('click', () => {
    const val = parseInt(minSizeEl?.value);
    state.settings.minFileSizeMb = isNaN(val) ? 50 : Math.max(0, val);
    saveSettings();
    showToast('Scan filter saved — re-scan to apply', 'info');
  });
  document.getElementById('save-junk-keywords')?.addEventListener('click', () => {
    const raw = junkKwEl?.value || '';
    state.settings.junkKeywords = raw.split(',').map(s => s.trim()).filter(Boolean);
    saveSettings();
    showToast('Junk keywords saved — re-scan to apply', 'info');
  });

  document.getElementById('clear-library').addEventListener('click', () => {
    if (!confirm('Clear all files and metadata from the library?')) return;
    state.library = []; state.filteredLibrary = []; state.metadataFetched.clear();
    saveLibrary(); renderLibrary(); updateStats();
    showToast('Library cleared', 'info');
  });

  // Tab switching — bind once, use document.getElementById to find panes
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`stab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
    });
  });
}

// ─── Customisation ────────────────────────────────────────
function initCustomisation() {
  const s = state.settings;

  // Theme
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === s.theme);
    btn.addEventListener('click', () => {
      s.theme = btn.dataset.theme;
      document.querySelectorAll('.theme-option').forEach(b => b.classList.toggle('active', b.dataset.theme === s.theme));
      applyTheme(); saveSettings();
    });
  });

  // Accent colour
  const accentIn = document.getElementById('accent-color');
  if (accentIn) {
    accentIn.value = s.accentColor;
    accentIn.addEventListener('input', e => { s.accentColor = e.target.value; applyTheme(); saveSettings(); });
  }
  document.querySelectorAll('.color-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      s.accentColor = btn.dataset.color;
      if (accentIn) accentIn.value = s.accentColor;
      applyTheme(); saveSettings();
    });
  });

  // Font family
  const fontSel = document.getElementById('font-family');
  if (fontSel) {
    fontSel.value = s.fontFamily;
    fontSel.addEventListener('change', e => { s.fontFamily = e.target.value; applyTheme(); saveSettings(); });
  }

  // Font size
  document.querySelectorAll('.fontsize-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === s.fontSize);
    btn.addEventListener('click', () => {
      s.fontSize = btn.dataset.size;
      document.querySelectorAll('.fontsize-option').forEach(b => b.classList.toggle('active', b.dataset.size === s.fontSize));
      applyTheme(); saveSettings();
    });
  });

  // Grid size
  document.querySelectorAll('.gridsize-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === s.gridSize);
    btn.addEventListener('click', () => {
      s.gridSize = btn.dataset.size;
      document.querySelectorAll('.gridsize-option').forEach(b => b.classList.toggle('active', b.dataset.size === s.gridSize));
      saveSettings(); if (state.viewMode === 'grid') renderLibrary();
    });
  });

  // Animations
  const animT = document.getElementById('animations-toggle');
  if (animT) {
    animT.checked = s.animationsEnabled;
    animT.addEventListener('change', e => {
      s.animationsEnabled = e.target.checked;
      document.body.classList.toggle('no-animations', !e.target.checked);
      saveSettings();
    });
    document.body.classList.toggle('no-animations', !s.animationsEnabled);
  }

  // Show file size
  const fsT = document.getElementById('show-filesize');
  if (fsT) {
    fsT.checked = s.showFileSize;
    fsT.addEventListener('change', e => { s.showFileSize = e.target.checked; saveSettings(); renderLibrary(); });
  }

  // Detail view mode buttons
  document.querySelectorAll('.detail-view-option').forEach(btn => {
    const type = btn.dataset.type; // 'movie' or 'tv'
    const key  = type === 'tv' ? 'tvDetailView' : 'movieDetailView';
    btn.classList.toggle('active', s[key] === btn.dataset.mode);
    btn.addEventListener('click', () => {
      s[key] = btn.dataset.mode;
      document.querySelectorAll(`.detail-view-option[data-type="${type}"]`)
        .forEach(b => b.classList.toggle('active', b.dataset.mode === s[key]));
      saveSettings();
    });
  });

  // Secondary text contrast slider
  const contrastSlider = document.getElementById('text-contrast-slider');
  const contrastLabel  = document.getElementById('text-contrast-label');
  if (contrastSlider) {
    contrastSlider.value = s.textContrast || 0;
    if (contrastLabel) contrastLabel.textContent = (s.textContrast || 0) > 0 ? `+${s.textContrast}` : String(s.textContrast || 0);
    contrastSlider.addEventListener('input', e => {
      s.textContrast = parseInt(e.target.value);
      if (contrastLabel) contrastLabel.textContent = s.textContrast > 0 ? `+${s.textContrast}` : String(s.textContrast);
      applyTheme();
      saveSettings();
    });
  }
}

// ─── Theme application ────────────────────────────────────
function applyTheme() {
  const s = state.settings;
  document.body.classList.toggle('theme-light', s.theme === 'light');
  document.body.classList.toggle('theme-dark',  s.theme === 'dark');
  const root = document.documentElement;
  root.style.setProperty('--accent',       s.accentColor);
  root.style.setProperty('--accent-soft',  s.accentColor + '25');
  root.style.setProperty('--accent-glow',  s.accentColor + '55');
  root.style.setProperty('--accent-hover', hexLighten(s.accentColor, 25));
  root.style.setProperty('--text-accent',  hexLighten(s.accentColor, 55));
  const fontMap = {
    'Outfit':"'Outfit',sans-serif", 'Inter':"'Inter',system-ui,sans-serif",
    'DM Sans':"'DM Sans',sans-serif", 'Syne':"'Syne',sans-serif",
    'Space Grotesk':"'Space Grotesk',sans-serif", 'System':'system-ui,sans-serif',
  };
  root.style.setProperty('--font-body', fontMap[s.fontFamily] || fontMap['Outfit']);
  root.style.setProperty('--base-font-size', {small:'12px',medium:'14px',large:'16px'}[s.fontSize] || '14px');
  loadGoogleFont(s.fontFamily);
  const isDark = s.theme !== 'light';
  const baseL  = isDark ? 55 : 65;
  const newL   = Math.max(30, Math.min(90, baseL + (s.textContrast || 0)));
  document.body.style.setProperty('--t2', `hsl(240,15%,${newL}%)`);
}

function loadGoogleFont(name) {
  if (name === 'System') return;
  const id = `gf-${name.replace(/\s+/g,'-')}`;
  if (document.getElementById(id)) return;
  const l = document.createElement('link');
  l.id = id; l.rel = 'stylesheet';
  l.href = `https://fonts.googleapis.com/css2?family=${name.replace(/\s+/g,'+')}:wght@300;400;500;600;700;900&display=swap`;
  document.head.appendChild(l);
}

function hexLighten(hex, a) {
  try {
    const n = parseInt(hex.replace('#',''), 16);
    return '#' + ((1<<24)|(Math.min(255,(n>>16)+a)<<16)|(Math.min(255,((n>>8)&255)+a)<<8)|Math.min(255,(n&255)+a)).toString(16).slice(1);
  } catch { return hex; }
}

// ─── Folder lists ─────────────────────────────────────────
function updateFolderList() {
  const list = document.getElementById('folder-list');
  const hint = document.getElementById('watched-folders-hint');
  if (!list) return;
  hint.textContent = state.folders.length ? `${state.folders.length} folder(s) monitored` : 'No folders added yet';
  list.innerHTML = state.folders.map((f, i) => `
    <div class="folder-item">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span title="${esc(f)}">${esc(f)}</span>
      <button class="folder-unhide" data-folder="${esc(f)}" title="Hide this folder">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>
      <button class="folder-remove" data-index="${i}" title="Remove folder">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');

  list.querySelectorAll('.folder-remove').forEach(btn =>
    btn.addEventListener('click', () => {
      state.folders.splice(parseInt(btn.dataset.index), 1);
      updateFolderList(); saveLibrary();
    }));
  list.querySelectorAll('.folder-unhide').forEach(btn =>
    btn.addEventListener('click', () => hideFolder(btn.dataset.folder)));
}

function updateHiddenFolderList() {
  const emptyMsg = document.getElementById('hidden-empty');
  if (emptyMsg) emptyMsg.style.display = state.hiddenFolders.length ? 'none' : 'flex';
  renderCollapsibleFolderList(
    'hidden-folder-list',
    state.hiddenFolders,
    (fp) => {
      state.hiddenFolders = state.hiddenFolders.filter(f => f !== fp);
      saveLibrary();
      updateHiddenFolderList();
      showToast('Folder un-hidden — re-scan to restore', 'info');
    },
    'No hidden folders'
  );
}

// ─── Persistence ──────────────────────────────────────────
function deduplicateLibrary() {
  // Pass 1: deduplicate by tmdbId — keep item with metadata
  function dedupByTmdb(arr) {
    const seen = new Map();
    return arr.filter(item => {
      const tid = item.metadata?.tmdbId;
      if (!tid) return true;
      const key = String(tid);
      if (!seen.has(key)) { seen.set(key, true); return true; }
      return false;
    });
  }
  // Pass 2: deduplicate movies by exact file path only
  // TV shows are NOT deduped by path since multiple shows can share a folder (packs)
  function dedupMoviesByPath(arr) {
    const seen = new Map();
    return arr.filter(item => {
      // Only apply to movies with a direct file path (not folders)
      if (item.type === 'tv') return true;
      const p = (item.path || '').toLowerCase();
      if (!p) return true;
      if (!seen.has(p)) { seen.set(p, true); return true; }
      return false;
    });
  }
  state.library = dedupMoviesByPath(dedupByTmdb(state.library));
  state.tvShows = dedupByTmdb(state.tvShows); // TV: only dedup by tmdbId, never by path
}

function saveLibrary() {
  deduplicateLibrary();
  api.saveLibrary({
    _version: 6,
    library: state.library,
    tvShows: state.tvShows,
    folders: state.folders,
    hiddenFolders: state.hiddenFolders,
    hiddenItems: state.hiddenItems,
    excludedFolders: state.excludedFolders,
    subscribedServices: state.settings.subscribedServices,
    watchlist: state.watchlist,
    tvGuideNotifications: state.tvGuideNotifications,
    tvGuideDismissed: [...state.tvGuideDismissed],
    settings: state.settings, // persist ALL settings to library.json
  });
}
function saveSettings() {
  saveLibrary(); // persist to library.json (keys are excluded server-side)
}
function loadSettings() {
  try {
    const s = localStorage.getItem('mv_s3') || localStorage.getItem('mv_settings_v2') || localStorage.getItem('mv_settings');
    if (s) {
      const parsed = JSON.parse(s);
      // Never restore API keys from localStorage — they are loaded
      // from encrypted storage separately in init().
      delete parsed.tmdbKey;
      delete parsed.omdbKey;
      Object.assign(state.settings, parsed);
    }
  } catch {}
}
function updateStats() {
  const movies = state.library.length;
  const shows  = state.tvShows.length;
  const eps    = state.tvShows.reduce((n, s) => n + (s.episodeCount || 0), 0);
  const parts  = [];
  if (movies) parts.push(`${movies} movie${movies!==1?'s':''}`);
  if (shows)  parts.push(`${shows} show${shows!==1?'s':''}`);
  document.getElementById('stat-total').textContent = parts.join(' · ') || '0 files';
}

// ─── Progress ─────────────────────────────────────────────
function showProgress(visible, label = '', pct = 0) {
  const c = document.getElementById('progress-container');
  if (!visible) { c.style.display = 'none'; return; }
  c.style.display = 'block';
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-pct').textContent = `${pct}%`;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

// ─── Toast ────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = {
    success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>`,
    info:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/></svg>`,
  };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `${icons[type]||''}<span>${esc(msg)}</span>`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0'; t.style.transform = 'translateX(110%)'; t.style.transition = '.3s ease';
    setTimeout(() => t.remove(), 320);
  }, 3500);
}

// Convert an absolute local cache path to a media:// URL served by the
// custom protocol in main.js. This replaces all file:// usages so that
// webSecurity:true can remain enabled.
function toMediaUrl(absPath) {
  if (!absPath) return null;
  // Strip everything up to and including the 'cache' directory segment,
  // then use the remainder as the relative path within media://local/
  const norm = absPath.replace(/\\/g, '/');
  const idx  = norm.lastIndexOf('/cache/');
  return idx !== -1 ? 'media://local/' + norm.slice(idx + 7) : 'media://local/' + norm;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

init();

// ═══════════════════════════════════════════════════════
// ACTOR PROFILE
// ═══════════════════════════════════════════════════════

async function openActorProfile(nameOrId) {
  if (!state.settings.tmdbKey) {
    showToast('TMDB API key required for Actor Profiles', 'info');
    return;
  }

  // Remember where we came from for the back button
  if (state.currentView !== 'actor') state.navStack.push(state.currentView);
  state.previousView = state.currentView !== 'actor' ? state.currentView : (state.previousView || 'library');

  switchView('actor');
  setActorLoading(true, `Searching for "${nameOrId}"…`);
  resetActorView();

  try {
    const person = await api.searchPerson(nameOrId);
    if (person.error) {
      setActorLoading(false);
      showToast(`Person not found: ${person.error}`, 'error');
      return;
    }

    state.actorProfile = person;
    state.actorStreamingData = {};
    setActorLoading(false);

    renderActorHero(person);
    await renderActorFilmography(person);

  } catch (err) {
    setActorLoading(false);
    showToast(`Failed to load profile: ${err.message}`, 'error');
  }
}

function resetActorView() {
  document.getElementById('actor-name').textContent = 'Loading…';
  document.getElementById('actor-bio').textContent = '';
  document.getElementById('actor-meta-row').innerHTML = '';
  document.getElementById('actor-stats').innerHTML = '';
  document.getElementById('actor-known-for').textContent = '';
  document.getElementById('local-films').innerHTML = '';
  document.getElementById('streaming-films').innerHTML = '';
  document.getElementById('all-films').innerHTML = '';
  document.getElementById('section-local').style.display = 'none';
  document.getElementById('section-streaming').style.display = 'none';
  const photo = document.getElementById('actor-photo');
  photo.classList.remove('loaded');
  photo.src = '';
  document.getElementById('actor-photo-placeholder').style.display = 'flex';
}

function setActorLoading(visible, msg = '') {
  const el = document.getElementById('actor-loading');
  const wrap = document.getElementById('actor-profile-wrap');
  el.style.display = visible ? 'flex' : 'none';
  wrap.style.display = visible ? 'none' : 'flex';
  if (msg) document.getElementById('actor-loading-msg').textContent = msg;
}

function renderActorHero(person) {
  // Name and known-for
  document.getElementById('actor-name').textContent = person.name;
  document.getElementById('actor-known-for').textContent = person.knownFor || 'Actor';

  // Photo
  const photoEl = document.getElementById('actor-photo');
  const placeholderEl = document.getElementById('actor-photo-placeholder');
  if (person.profileLocalPath) {
    photoEl.src = toMediaUrl(person.profileLocalPath);
    photoEl.onload = () => { photoEl.classList.add('loaded'); placeholderEl.style.display = 'none'; };
    photoEl.onerror = () => { placeholderEl.style.display = 'flex'; };
  }

  // Meta row — born, birthplace, age
  const meta = [];
  if (person.birthday) {
    const born = new Date(person.birthday);
    const age = person.deathday
      ? Math.floor((new Date(person.deathday) - born) / (365.25 * 24 * 3600 * 1000))
      : Math.floor((Date.now() - born) / (365.25 * 24 * 3600 * 1000));
    meta.push(`<span>🎂 Born ${born.toLocaleDateString('en-GB', {year:'numeric', month:'long', day:'numeric'})}${person.deathday ? '' : ` (age ${age})`}</span>`);
  }
  if (person.deathday) {
    meta.push(`<span>✝ ${new Date(person.deathday).toLocaleDateString('en-GB', {year:'numeric', month:'long', day:'numeric'})}</span>`);
  }
  if (person.birthplace) meta.push(`<span>📍 ${esc(person.birthplace)}</span>`);
  document.getElementById('actor-meta-row').innerHTML = meta.join('');

  // Bio — truncated with expand on click
  const bioEl = document.getElementById('actor-bio');
  bioEl.textContent = person.biography || 'No biography available.';
  bioEl.addEventListener('click', () => bioEl.classList.toggle('expanded'));

  // Stats
  const allCredits  = [...(person.filmography||[]), ...(person.crewFilmography||[]).filter(c =>
    !(person.filmography||[]).find(f => f.tmdbId === c.tmdbId))];
  const localCount  = countLocalTitles(allCredits);
  const filmCount   = allCredits.filter(f => f.mediaType === 'movie').length;
  const tvCount     = allCredits.filter(f => f.mediaType === 'tv').length;
  document.getElementById('actor-stats').innerHTML = `
    <div class="actor-stat"><span class="actor-stat-value">${filmCount}</span><span class="actor-stat-label">Movies</span></div>
    <div class="actor-stat"><span class="actor-stat-value">${tvCount}</span><span class="actor-stat-label">TV Shows</span></div>
    <div class="actor-stat"><span class="actor-stat-value" style="color:var(--green)">${localCount}</span><span class="actor-stat-label">In Library</span></div>
  `;

  // Back button
  document.getElementById('actor-back-btn').onclick = () => {
    const dest = state.navStack.pop() || state.previousView || 'library';
    switchView(dest);
  };
}

// ── Library matching helpers ──────────────────────────────
//
// IMPORTANT: Always match by TMDB ID first.
// Title-based matching is only used as a last resort for items
// that haven't had metadata fetched yet, and must be an EXACT
// case-insensitive match — never substring/contains.
//
// "The Way" must NOT match "Avatar: The Way of Water".
// "Ma" must NOT match "Ma Rainey's Black Bottom".

function findInLocalLibrary(tmdbId, filmTitle) {
  const allItems = [...state.library, ...state.tvShows];

  // ── Pass 1: exact TMDB ID match (most reliable) ──────────
  if (tmdbId) {
    const byId = allItems.find(item => {
      const itemTmdbId = item.metadata?.tmdbId;
      return itemTmdbId && String(itemTmdbId) === String(tmdbId);
    });
    if (byId) return byId;
  }

  // ── Pass 2: exact title match (no metadata yet) ──────────
  // Only for items without metadata — they haven't been ID'd yet
  // so title is the only thing we have. But it must be exact.
  if (filmTitle) {
    const q = filmTitle.trim().toLowerCase();
    // Require reasonable title length to avoid short false matches
    if (q.length >= 4) {
      const byTitle = allItems.find(item => {
        if (item.metadata?.tmdbId) return false; // skip items with metadata (already checked above)
        const t = (item.displayTitle || item.title || '').trim().toLowerCase();
        return t === q;
      });
      if (byTitle) return byTitle;
    }
  }

  return null;
}

function isInLocalLibrary(tmdbId, filmTitle) {
  return findInLocalLibrary(tmdbId, filmTitle) !== null;
}

function countLocalTitles(filmography) {
  if (!filmography) return 0;
  return filmography.filter(film => isInLocalLibrary(film.tmdbId, film.title)).length;
}

async function renderActorFilmography(person) {
  const films = person.filmography || [];

  // ── Fix 3: Cross-reference by TMDB ID against BOTH cast AND crew ──
  // person.filmography is cast credits; person.crewFilmography is directing/writing credits
  const crewFilms   = person.crewFilmography || [];
  const allCredits  = [...films, ...crewFilms.filter(c => !films.find(f => f.tmdbId === c.tmdbId))];
  const localFilms  = allCredits.filter(f => isInLocalLibrary(f.tmdbId, f.title));

  // ── Fix 2: Only fetch posters for local films immediately ──
  // Full filmography posters are lazy-loaded on expand
  const localPosterIds = localFilms.filter(f => f.posterPath).slice(0, 12);
  const postersMap = localPosterIds.length
    ? await api.fetchFilmPosters(localPosterIds).catch(() => ({}))
    : {};

  // ── Local Library Section ──────────────────────────────
  const sectionLocal = document.getElementById('section-local');
  if (localFilms.length) {
    sectionLocal.style.display = 'block';
    document.getElementById('local-count').textContent = `${localFilms.length} title${localFilms.length!==1?'s':''}`;
    const row = document.getElementById('local-films');
    row.innerHTML = '';
    localFilms.forEach(film => row.appendChild(buildFilmCard(film, postersMap, 'local')));
  } else {
    sectionLocal.style.display = 'none';
  }

  // ── Fix 1: Streaming Section — subscribed services only ──
  const subs = state.settings.subscribedServices || [];
  if (state.settings.tmdbKey && subs.length) {
    const country = state.settings.countryCode ||
      Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';
    const nonLocalFilms = allCredits.filter(f => !isInLocalLibrary(f.tmdbId, f.title));

    const streamingFilms = [];
    for (let i = 0; i < nonLocalFilms.length; i += 8) {
      const batch = nonLocalFilms.slice(i, i + 8);
      await Promise.all(batch.map(async film => {
        try {
          const providers = await api.getWatchProviders(
            film.tmdbId, film.mediaType, country);
          // Only include films available on subscribed services
          const myServices = (providers.flatrate || []).filter(p => subs.includes(p.providerId));
          if (myServices.length) {
            state.actorStreamingData[film.tmdbId] = { ...providers, flatrate: myServices };
            streamingFilms.push({ film, providers: { ...providers, flatrate: myServices } });
          }
        } catch {}
      }));
      if (i + 8 < nonLocalFilms.length) await new Promise(r => setTimeout(r, 150));
    }

    if (streamingFilms.length) {
      document.getElementById('section-streaming').style.display = 'block';
      document.getElementById('streaming-count').textContent =
        `${streamingFilms.length} title${streamingFilms.length!==1?'s':''}`;

      // Show unique subscribed provider logos
      const myProviders = {};
      streamingFilms.forEach(({ providers }) => {
        (providers.flatrate || []).forEach(p => { myProviders[p.name] = p; });
      });
      document.getElementById('streaming-providers').innerHTML =
        Object.values(myProviders).slice(0, 8).map(p =>
          p.logo
            ? `<img class="provider-logo" src="${p.logo}" alt="${esc(p.name)}" title="${esc(p.name)}" loading="lazy">`
            : `<span class="provider-name">${esc(p.name)}</span>`
        ).join('');

      // Fetch posters for streaming films
      const streamPosterIds = streamingFilms.map(({film}) => film).filter(f => f.posterPath).slice(0, 20);
      if (streamPosterIds.length) {
        api.fetchFilmPosters(streamPosterIds).then(sp => Object.assign(postersMap, sp)).catch(() => {});
      }

      const row = document.getElementById('streaming-films');
      row.innerHTML = '';
      streamingFilms.forEach(({ film }) => row.appendChild(buildFilmCard(film, postersMap, 'stream')));
    } else {
      document.getElementById('section-streaming').style.display = 'none';
    }
  } else {
    document.getElementById('section-streaming').style.display = 'none';
  }

  // ── Fix 2: Full Filmography — collapsed, expand on click ──
  const allCount = allCredits.length;
  const allCountEl = document.getElementById('all-count');
  allCountEl.textContent = `${allCount} title${allCount!==1?'s':''}`;

  // Replace filmography grid with a collapsed button + lazy container
  const allFilmsContainer = document.getElementById('all-films');
  allFilmsContainer.innerHTML = '';

  const expandBtn = document.createElement('button');
  expandBtn.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:10px 18px;background:var(--bg-3);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--t1);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:background 0.16s,color 0.16s,border-color 0.16s;margin-bottom:4px;';
  expandBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg> Show Full Filmography (${allCount} titles)`;
  expandBtn.addEventListener('mouseenter', () => { expandBtn.style.background='var(--bg-4)'; expandBtn.style.color='var(--t0)'; expandBtn.style.borderColor='var(--border-hi)'; });
  expandBtn.addEventListener('mouseleave', () => { expandBtn.style.background='var(--bg-3)'; expandBtn.style.color='var(--t1)'; expandBtn.style.borderColor='var(--border-mid)'; });

  let filmographyExpanded = false;
  expandBtn.addEventListener('click', async () => {
    if (filmographyExpanded) return;
    filmographyExpanded = true;
    expandBtn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Loading posters…`;
    expandBtn.style.pointerEvents = 'none';

    // Now fetch posters for full filmography
    const toFetch = allCredits.filter(f => f.posterPath && !postersMap[f.tmdbId]).slice(0, 60);
    if (toFetch.length) {
      const fetched = await api.fetchFilmPosters(toFetch).catch(() => ({}));
      Object.assign(postersMap, fetched);
    }

    // Build filter buttons
    const filterBar = document.createElement('div');
    filterBar.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;';
    filterBar.innerHTML = [
      { filter: 'all', label: `All (${allCount})` },
      { filter: 'movie', label: `Movies (${allCredits.filter(f=>f.mediaType==='movie').length})` },
      { filter: 'tv', label: `TV (${allCredits.filter(f=>f.mediaType==='tv').length})` },
    ].map(({filter, label}) =>
      `<button class="filt-btn${filter==='all'?' active':''}" data-filter="${filter}" style="padding:5px 12px;background:${filter==='all'?'var(--accent)':'var(--bg-3)'};color:${filter==='all'?'#fff':'var(--t1)'};border:1px solid ${filter==='all'?'var(--accent)':'var(--border)'};border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">${label}</button>`
    ).join('');

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:14px;margin-top:4px;';
    grid.id = 'all-films-grid';

    // Render all credits
    allCredits.forEach(film => grid.appendChild(buildFilmCard(film, postersMap, null)));

    filterBar.querySelectorAll('.filt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.filt-btn').forEach(b => {
          b.style.background = 'var(--bg-3)'; b.style.color = 'var(--t1)'; b.style.borderColor = 'var(--border)';
        });
        btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; btn.style.borderColor = 'var(--accent)';
        const f = btn.dataset.filter;
        grid.innerHTML = '';
        const filtered = f === 'all' ? allCredits : allCredits.filter(x => x.mediaType === f);
        filtered.forEach(film => grid.appendChild(buildFilmCard(film, postersMap, null)));
      });
    });

    allFilmsContainer.innerHTML = '';
    expandBtn.remove();
    // Switch from horizontal scroll row to block layout for the grid
    allFilmsContainer.classList.remove('filmography-row');
    allFilmsContainer.style.cssText = 'display:block;';
    allFilmsContainer.appendChild(filterBar);
    allFilmsContainer.appendChild(grid);
  });

  allFilmsContainer.appendChild(expandBtn);
}

function renderFilmographyFiltered(films, postersMap, filter) {
  const container = document.getElementById('all-films');
  // Full filmography uses a wrap grid, local/streaming use horizontal scroll
  container.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:14px;';
  container.innerHTML = '';
  const filtered = filter === 'all' ? films
    : films.filter(f => f.mediaType === filter);
  document.getElementById('all-count').textContent = `${filtered.length} title${filtered.length!==1?'s':''}`;
  filtered.forEach(film => container.appendChild(buildFilmCard(film, postersMap, null)));
}

function buildFilmCard(film, postersMap, badgeType) {
  const card = document.createElement('div');
  card.className = 'film-card';

  const localPath = postersMap && postersMap[film.tmdbId]
    ? toMediaUrl(postersMap[film.tmdbId])
    : null;
  const providers = state.actorStreamingData[film.tmdbId];
  const isLocal   = isInLocalLibrary(film.tmdbId, film.title);

  const badgeHtml = isLocal
    ? `<span class="film-status-badge film-status-local">📁 LOCAL</span>`
    : (badgeType === 'stream' && providers?.flatrate?.length)
      ? `<span class="film-status-badge film-status-stream">▶ STREAM</span>`
      : film.mediaType === 'tv'
        ? `<span class="film-status-badge film-status-tv-badge">TV</span>`
        : '';

  const scoreHtml = film.voteAverage
    ? `<span class="film-card-score">★ ${film.voteAverage}</span>`
    : '';

  // Use local cached path first, fall back to TMDB URL directly
  const remotePath = film.posterPath || null;
  const imgSrc = localPath || remotePath;
  const imgHtml = imgSrc
    ? `<img src="${imgSrc}" alt="${esc(film.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholderHtml = `<div class="film-card-poster-placeholder" style="display:${imgSrc?'none':'flex'}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></div>`;

  card.dataset.tmdb = film.tmdbId;
  card.innerHTML = `
    <div class="film-card-poster">
      ${imgHtml}${placeholderHtml}
      ${badgeHtml}
      ${scoreHtml}
    </div>
    <div class="film-card-info">
      <div class="film-card-title">${esc(film.title)}</div>
      <div class="film-card-meta">${film.year || '—'}${film.character ? ` · ${esc(film.character)}` : ''}</div>
    </div>`;

  // Click: if in local library open detail panel; otherwise open in-app title detail page
  card.addEventListener('click', () => {
    if (isLocal) {
      const found = findInLocalLibrary(film.tmdbId, film.title);
      if (found) openDetail(found);
    } else {
      // Open in-app TMDB title detail page (never open external URLs)
      openTitleDetailPage(film.tmdbId, film.mediaType, film.title, film.posterPath);
    }
  });

  return card;
}

// ═══════════════════════════════════════════════════════
// REMAP PANEL
// ═══════════════════════════════════════════════════════

function toggleRemapPanel(visible) {
  const panel = document.getElementById('remap-panel');
  if (!panel) return;
  panel.style.display = visible ? 'block' : 'none';
  if (visible) {
    // Stop clicks inside remap panel from bubbling to document
    // (prevents options menu handler from stealing focus)
    panel.onclick = e => e.stopPropagation();
    const input = document.getElementById('remap-input');
    if (input && state.activeItem) {
      input.value = state.activeItem.displayTitle || state.activeItem.title || '';
      setTimeout(() => { input.focus(); input.select(); }, 50);
    }
    document.getElementById('remap-results').innerHTML = '';
  } else {
    panel.onclick = null;
  }
}

async function doRemapSearch() {
  if (!state.activeItem) return;
  if (!state.settings.tmdbKey) {
    showToast('TMDB API key required to remap', 'info');
    return;
  }

  const query = document.getElementById('remap-input').value.trim();
  if (!query) return;

  const resultsEl = document.getElementById('remap-results');
  resultsEl.innerHTML = `<div class="remap-searching"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Searching TMDB…</div>`;

  try {
    // Search both movies and TV — allows fixing misclassified items (e.g. movie filed as TV)
    const [movieData, tvData] = await Promise.all([
      api.remapSearch(query, 'movie'),
      api.remapSearch(query, 'tv'),
    ]);
    // Merge results, tag each with correct mediaType, sort by popularity
    const allResults = [
      ...(movieData.results || []).map(r => ({ ...r, mediaType: 'movie' })),
      ...(tvData.results   || []).map(r => ({ ...r, mediaType: 'tv'    })),
    ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 10);
    const data = { results: allResults };

    if (data.error || !data.results || !data.results.length) {
      resultsEl.innerHTML = `<div class="remap-error">No results found. Try a different title, year, or paste a TMDB URL.</div>`;
      return;
    }

    resultsEl.innerHTML = '';
    data.results.forEach(result => {
      const item = document.createElement('div');
      item.className = 'remap-result-item';

      const thumbHtml = result.poster
        ? `<img class="remap-thumb" src="${result.poster}" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="remap-thumb-placeholder"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></div>`;

      const typeLabel = result.mediaType === 'tv' ? 'TV' : 'Movie';
      const ratingHtml = result.rating ? ` · ★ ${result.rating}` : '';

      item.innerHTML = `
        ${thumbHtml}
        <div class="remap-result-info">
          <div class="remap-result-title">${esc(result.title)}</div>
          <div class="remap-result-meta">${result.year || '—'} · ${typeLabel}${ratingHtml} · ID ${result.tmdbId}</div>
        </div>
        <button class="remap-result-apply">Use This</button>`;

      item.querySelector('.remap-result-apply').addEventListener('click', async () => {
        await applyRemap(result);
      });

      resultsEl.appendChild(item);
    });

  } catch (err) {
    resultsEl.innerHTML = `<div class="remap-error">Search failed: ${esc(err.message)}</div>`;
  }
}

async function applyRemap(result) {
  if (!state.activeItem) return;

  const resultsEl = document.getElementById('remap-results');
  // Mark the chosen item as applying
  const rows = resultsEl.querySelectorAll('.remap-result-item');
  rows.forEach(r => {
    const btn = r.querySelector('.remap-result-apply');
    if (btn && btn.textContent === 'Use This') {
      r.classList.add('applying');
      btn.textContent = 'Applying…';
    }
  });

  try {
    const data = await api.remapApply(state.activeItem, result.tmdbId, result.mediaType);

    if (data.error) {
      showToast(`Remap failed: ${data.error}`, 'error');
      rows.forEach(r => { r.classList.remove('applying'); const b = r.querySelector('.remap-result-apply'); if (b) b.textContent = 'Use This'; });
      return;
    }

    // Update the item in state with the new metadata and title
    const libIdx = state.library.findIndex(f => f.id === state.activeItem.id);
    const tvIdx  = libIdx === -1 ? state.tvShows.findIndex(s => s.id === state.activeItem.id) : -1;
    const arr = libIdx !== -1 ? state.library : state.tvShows;
    const idx = libIdx !== -1 ? libIdx : tvIdx;

    if (arr && idx !== -1) {
      const itemId = arr[idx].id;

      // Cancel any pending fetch-queue entries for this item — metadata just arrived
      state.fetchQueue = state.fetchQueue.filter(q => q.id !== itemId);
      state.metadataFetched.add(itemId);

      // If type changed (movie↔tv), move between the correct arrays
      const oldType = arr[idx].type;
      const newType = data.newType;
      if (oldType !== newType) {
        const updatedItem = {
          ...arr[idx],
          title: data.newTitle, displayTitle: data.newTitle,
          type: newType, metadata: data.meta,
          posterPath: data.meta.posterPath || null, status: 'done',
        };
        // Remove from current array
        if (arr === state.library) {
          state.library = state.library.filter(f => f.id !== itemId);
          state.tvShows.push(updatedItem);
        } else {
          state.tvShows = state.tvShows.filter(s => s.id !== itemId);
          state.library.push(updatedItem);
        }
        state.activeItem = updatedItem;
      } else {
        arr[idx].title        = data.newTitle;
        arr[idx].displayTitle = data.newTitle;
        arr[idx].type         = newType;
        arr[idx].metadata     = data.meta;
        arr[idx].posterPath   = data.meta.posterPath || null;
        arr[idx].status       = 'done';
        state.activeItem = arr[idx];
      }

      // Deduplicate after remap:
      // 1. Remove any other items sharing the same tmdbId
      // 2. Remove any other items sharing the same file path (catches ghost entries)
      const remappedTmdbId = data.meta?.tmdbId;
      const remappedPath   = (state.activeItem.path || '').toLowerCase();
      const activeId = state.activeItem.id;

      state.library = state.library.filter(f => {
        if (f.id === activeId) return true;
        if (remappedTmdbId && String(f.metadata?.tmdbId) === String(remappedTmdbId)) return false;
        if (remappedPath && (f.path || '').toLowerCase() === remappedPath) return false;
        return true;
      });

      // TV shows: merge episodes from duplicates instead of dropping them
      const activeShow = state.tvShows.find(s => s.id === activeId);
      state.tvShows = state.tvShows.filter(s => {
        if (s.id === activeId) return true;
        const sameTmdb = remappedTmdbId && String(s.metadata?.tmdbId) === String(remappedTmdbId);
        const samePath = remappedPath && (s.path || '').toLowerCase() === remappedPath;
        if ((sameTmdb || samePath) && activeShow) {
          // Merge this show's episodes into the surviving entry
          const existingPaths = new Set((activeShow.episodes || []).map(e => e.path));
          const newEps = (s.episodes || []).filter(e => !existingPaths.has(e.path));
          if (newEps.length) {
            activeShow.episodes = [...(activeShow.episodes || []), ...newEps]
              .sort((a, b) => (a.season * 10000 + a.episode) - (b.season * 10000 + b.episode));
            activeShow.episodeCount = activeShow.episodes.length;
            const seasons = new Set(activeShow.episodes.map(e => e.season));
            activeShow.seasonCount = seasons.size;
          }
          return false; // remove the duplicate
        }
        return true;
      });

      saveLibrary();
      applyFiltersAndSort();
      toggleRemapPanel(false);
      showToast(`Remapped to "${data.newTitle}"`, 'success');

      // If type changed, close detail panel and navigate to correct section
      if (oldType !== newType) {
        closeDetail();
        const targetView = newType === 'tv' ? 'tv' : 'movies';
        // Small delay so applyFiltersAndSort has settled
        setTimeout(() => switchView(targetView), 100);
      } else {
        renderDetailPanel(state.activeItem);
        updateCardWithMeta(state.activeItem.id);
      }
    }

  } catch (err) {
    showToast(`Remap failed: ${esc(err.message)}`, 'error');
    rows.forEach(r => { r.classList.remove('applying'); const b = r.querySelector('.remap-result-apply'); if (b) b.textContent = 'Use This'; });
  }
}

// ═══════════════════════════════════════════════════════
// MULTI-SELECT
// ═══════════════════════════════════════════════════════

function applySelectionStyle(card, selected) {
  if (selected) {
    card.style.outline = '2px solid var(--accent)';
    card.style.outlineOffset = '-2px';
    card.style.boxShadow = '0 0 0 4px var(--accent-glow)';
  } else {
    card.style.outline = '';
    card.style.outlineOffset = '';
    card.style.boxShadow = '';
  }
}

function toggleCardSelection(item, card) {
  const id = item.id;
  if (state.selectedItems.has(id)) {
    state.selectedItems.delete(id);
    applySelectionStyle(card, false);
  } else {
    state.selectedItems.add(id);
    applySelectionStyle(card, true);
  }
  updateSelectionBar();
}

function clearSelection() {
  state.selectedItems.clear();
  // Remove highlight from all selected cards
  document.querySelectorAll('[data-id]').forEach(card => applySelectionStyle(card, false));
  updateSelectionBar();
}

function updateSelectionBar() {
  let bar = document.getElementById('selection-bar');

  if (state.selectedItems.size === 0) {
    if (bar) {
      bar.style.transform = 'translateX(-50%) translateY(200%)';
      setTimeout(() => { if (bar && state.selectedItems.size === 0) bar.style.display = 'none'; }, 280);
    }
    return;
  }

  // Create bar if it doesn't exist
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'left:50%',
      'transform:translateX(-50%) translateY(100%)',
      'background:var(--bg-1,#111118)',
      'border:1px solid var(--border-mid,rgba(255,255,255,0.13))',
      'border-radius:12px',
      'padding:12px 20px',
      'display:flex',
      'align-items:center',
      'gap:14px',
      'z-index:800',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'transition:transform 0.25s cubic-bezier(0.4,0,0.2,1)',
      'backdrop-filter:blur(12px)',
      '-webkit-backdrop-filter:blur(12px)',
    ].join(';');

    bar.innerHTML = `
      <span id="sel-count-label" style="font-size:13px;font-weight:600;color:var(--t0,#f0f0f8);white-space:nowrap;"></span>
      <div style="width:1px;height:20px;background:var(--border-mid,rgba(255,255,255,0.13));flex-shrink:0;"></div>
      <button id="sel-reset-btn" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:rgba(124,92,252,0.15);color:var(--accent,#7c5cf8);border:1px solid rgba(124,92,252,0.3);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s,color 0.15s;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
        Reset Selected
      </button>
      <button id="sel-hide-btn" style="display:flex;align-items:center;gap:6px;padding:7px 14px;background:var(--red-soft,rgba(255,85,102,0.15));color:var(--red,#ff5566);border:1px solid rgba(255,85,102,0.3);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s,color 0.15s;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        Hide Selected
      </button>
      <button id="sel-clear-btn" style="display:flex;align-items:center;gap:5px;padding:7px 12px;background:var(--bg-3,#1c1c27);color:var(--t2,#55556a);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:background 0.15s,color 0.15s;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Clear
      </button>`;

    document.body.appendChild(bar);

    document.getElementById('sel-reset-btn').addEventListener('click', () => resetItems([...state.selectedItems]));
    document.getElementById('sel-hide-btn').addEventListener('click', hideSelected);
    document.getElementById('sel-clear-btn').addEventListener('click', clearSelection);

    // Hover styles via JS
    const resetBtn = document.getElementById('sel-reset-btn');
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background='var(--accent,#7c5cf8)'; resetBtn.style.color='#fff'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background='rgba(124,92,252,0.15)'; resetBtn.style.color='var(--accent,#7c5cf8)'; });
    const hideBtn = document.getElementById('sel-hide-btn');
    hideBtn.addEventListener('mouseenter', () => { hideBtn.style.background='var(--red,#ff5566)'; hideBtn.style.color='#fff'; });
    hideBtn.addEventListener('mouseleave', () => { hideBtn.style.background='var(--red-soft,rgba(255,85,102,0.15))'; hideBtn.style.color='var(--red,#ff5566)'; });
    const clearBtn = document.getElementById('sel-clear-btn');
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.background='var(--bg-4,#22222f)'; clearBtn.style.color='var(--t0,#f0f0f8)'; });
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.background='var(--bg-3,#1c1c27)'; clearBtn.style.color='var(--t2,#55556a)'; });
  }

  // Update count label
  const n = state.selectedItems.size;
  document.getElementById('sel-count-label').textContent = `${n} item${n !== 1 ? 's' : ''} selected`;

  // Slide into view
  bar.style.display = 'flex';
  requestAnimationFrame(() => {
    bar.style.transform = 'translateX(-50%) translateY(0)';
  });
}

function hideSelected() {
  if (!state.selectedItems.size) return;
  const ids = [...state.selectedItems];
  const count = ids.length;

  ids.forEach(id => {
    if (!state.hiddenItems.includes(id)) state.hiddenItems.push(id);
    state.library = state.library.filter(f => f.id !== id);
    state.tvShows = state.tvShows.filter(s => s.id !== id);
    state.metadataFetched.delete(id);
  });

  clearSelection();
  applyFiltersAndSort();
  updateStats();
  saveLibrary();
  showToast(`${count} item${count !== 1 ? 's' : ''} hidden`, 'info');
}

// ═══════════════════════════════════════════════════════
// EXCLUDED FOLDERS
// ═══════════════════════════════════════════════════════

// ── Collapsible folder list helper ───────────────────────
function renderCollapsibleFolderList(containerId, folders, onRemove, emptyMsg) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (!folders.length) {
    container.innerHTML = `<p style="font-size:12px;color:var(--t2);padding:8px 0">${emptyMsg}</p>`;
    return;
  }
  const chevronId = `${containerId}-chv`;
  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;user-select:none;';
  summary.innerHTML = `<svg id="${chevronId}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="color:var(--t2);transition:transform 0.16s;flex-shrink:0;"><polyline points="9 18 15 12 9 6"/></svg><span style="font-size:12px;font-weight:600;color:var(--t1)">${folders.length} folder${folders.length!==1?'s':''}</span>`;
  const details = document.createElement('div');
  details.style.cssText = 'overflow:hidden;max-height:0;transition:max-height 0.25s ease;';
  let open = false;
  summary.addEventListener('click', () => {
    open = !open;
    const ch = document.getElementById(chevronId);
    if (ch) ch.style.transform = open ? 'rotate(90deg)' : '';
    details.style.maxHeight = open ? `${folders.length * 48}px` : '0';
  });
  folders.forEach(p => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span class="folder-path">${esc(p)}</span><button class="folder-remove" title="Remove">×</button>`;
    row.querySelector('.folder-remove').addEventListener('click', () => onRemove(p));
    details.appendChild(row);
  });
  container.appendChild(summary);
  container.appendChild(details);
}

function renderExcludedFolderList() {
  renderCollapsibleFolderList(
    'excluded-folder-list',
    state.excludedFolders,
    (p) => {
      state.excludedFolders = state.excludedFolders.filter(x => x !== p);
      state.settings.excludedFolders = state.excludedFolders;
      saveLibrary();
      renderExcludedFolderList();
      showToast('Exclusion removed — re-scan to restore content', 'info');
    },
    'No excluded folders'
  );
}

// ═══════════════════════════════════════════════════════
// STREAMING SERVICES SETTINGS
// ═══════════════════════════════════════════════════════

// Well-known providers with their TMDB IDs for pre-population
const KNOWN_PROVIDERS = [
  { id: 8,    name: 'Netflix',            logo: null },
  { id: 119,  name: 'Amazon Prime Video', logo: null },
  { id: 1899, name: 'Max',               logo: null },
  { id: 337,  name: 'Disney+',           logo: null },
  { id: 350,  name: 'Apple TV+',         logo: null },
  { id: 149,  name: 'GO3',               logo: null },
];
const ALLOWED_PROVIDER_IDS = new Set([8, 119, 1899, 337, 350, 149]);

function renderStreamingServicesList() {
  const container = document.getElementById('streaming-services-list');
  if (!container) return;

  // Only show the curated KNOWN_PROVIDERS — clear any old discovered bloat
  state.settings.discoveredProviders = [];
  const allProviders = [...KNOWN_PROVIDERS];

  container.innerHTML = '';
  allProviders.forEach(provider => {
    const subscribed = (state.settings.subscribedServices || []).includes(provider.id);
    const item = document.createElement('div');
    item.className = `streaming-service-item${subscribed ? ' subscribed' : ''}`;
    item.dataset.id = provider.id;

    const logoHtml = provider.logo
      ? `<img class="streaming-service-logo" src="${provider.logo}" alt="${esc(provider.name)}" loading="lazy">`
      : `<div class="streaming-service-logo-placeholder">${provider.name.substring(0,2).toUpperCase()}</div>`;

    item.innerHTML = `${logoHtml}
      <span class="streaming-service-name">${esc(provider.name)}</span>
      <div class="streaming-service-check">${subscribed ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}</div>`;

    item.addEventListener('click', () => {
      const subs = state.settings.subscribedServices || [];
      if (subs.includes(provider.id)) {
        state.settings.subscribedServices = subs.filter(s => s !== provider.id);
      } else {
        state.settings.subscribedServices = [...subs, provider.id];
      }
      saveSettings();
      renderStreamingServicesList();
    });
    container.appendChild(item);
  });
}

function buildStreamingBanner(streamingProviders) {
  if (!streamingProviders) return '';
  const subs = state.settings.subscribedServices || [];
  const flatrate = streamingProviders.flatrate || [];
  // Only show if user has subscriptions set AND content is on one of them
  if (!subs.length) return '';
  const myServices = flatrate.filter(p => subs.includes(p.providerId));
  if (!myServices.length) return '';
  const main = myServices[0];
  const logoHtml = main.logo
    ? `<img class="streaming-banner-logo" src="${main.logo}" alt="${esc(main.name)}">`
    : `<div style="width:32px;height:32px;border-radius:6px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--accent)">${main.name.substring(0,2)}</div>`;
  return `<div style="display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:6px;border:1.5px solid var(--accent);background:var(--accent-soft);width:fit-content;max-width:320px;">${logoHtml}<div><div style="font-size:13px;font-weight:600;color:var(--accent);">Available on ${esc(main.name)}</div><div style="font-size:11px;color:var(--t1);">Included in your subscription</div></div></div>`;
}

// ═══════════════════════════════════════════════════════
// TMDB TITLE SEARCH (non-library content)
// ═══════════════════════════════════════════════════════

async function openTitleSearch(query) {
  if (!state.settings.tmdbKey) {
    showToast('TMDB API key required', 'info'); return;
  }
  state.previousView = state.currentView !== 'titlesearch' ? state.currentView : (state.previousView || 'library');
  switchView('titlesearch');

  const wrap    = document.getElementById('titlesearch-wrap');
  const loading = document.getElementById('titlesearch-loading');
  const results = document.getElementById('titlesearch-results');
  wrap.style.display = 'none';
  loading.style.display = 'flex';
  document.getElementById('titlesearch-loading-msg').textContent = `Searching for "${query}"…`;

  try {
    const data = await api.searchTitle(query);
    loading.style.display = 'none';
    wrap.style.display = 'flex';
    results.innerHTML = '';

    if (data.error || !data.results || !data.results.length) {
      results.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><h2>No results found</h2><p>Try a different title or check your spelling</p></div>`;
      return;
    }

    // Back button lives in the toolbar

    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);margin-bottom:16px;';
    heading.textContent = `${data.results.length} result${data.results.length!==1?'s':''} for "${query}"`;
    results.appendChild(heading);

    data.results.forEach(result => {
      const inLib = isInLocalLibrary(result.tmdbId, result.title);
      const card = document.createElement('div');
      card.className = 'tsearch-result-card';

      const posterHtml = result.poster
        ? `<img class="tsearch-poster" src="${result.poster}" loading="lazy" alt="${esc(result.title)}">`
        : `<div class="tsearch-poster-ph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></div>`;

      const libBadge = inLib
        ? `<div class="tsearch-in-lib"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> In your library</div>`
        : `<div class="tsearch-not-in-lib"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Not in library</div>`;

      card.innerHTML = `${posterHtml}
        <div class="tsearch-info">
          <div class="tsearch-title">${esc(result.title)}</div>
          <div class="tsearch-meta">${result.year||'—'} · ${result.mediaType==='tv'?'TV Series':'Movie'}${result.rating?' · ★ '+result.rating:''}</div>
          <div class="tsearch-overview">${esc(result.overview||'No description available.')}</div>
          ${libBadge}
        </div>`;

      card.addEventListener('click', () => {
        if (inLib) {
          const found = findInLocalLibrary(result.tmdbId, result.title);
          if (found) { openDetail(found); return; }
        }
        openTitleDetailPage(result.tmdbId, result.mediaType, result.title, result.poster, true);
      });
      results.appendChild(card);
    });

  } catch (err) {
    loading.style.display = 'none';
    wrap.style.display = 'flex';
    results.innerHTML = `<div class="empty-state"><h2>Search failed</h2><p>${esc(err.message)}</p></div>`;
  }
}

async function openTitleDetailPage(tmdbId, mediaType, title, posterUrl, fromSearch) {
  // Always switch to titlesearch view first so the DOM elements exist
  if (state.currentView !== 'titlesearch') {
    state.previousView = state.currentView;
    state.navStack.push(state.currentView);
    switchView('titlesearch');
  }
  const loading = document.getElementById('titlesearch-loading');
  const wrap    = document.getElementById('titlesearch-wrap');
  wrap.style.display = 'none';
  loading.style.display = 'flex';
  document.getElementById('titlesearch-loading-msg').textContent = `Loading ${title}…`;

  const country = state.settings.countryCode ||
    Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';

  const meta = await api.fetchTitleDetail(tmdbId, mediaType, country
  );

  loading.style.display = 'none';
  wrap.style.display = 'flex';

  if (meta.error) {
    showToast(`Failed to load title: ${meta.error}`, 'error'); return;
  }

  // Store any new providers discovered for the streaming settings list
  if (meta.streamingProviders) {
    const all = [...(meta.streamingProviders.flatrate||[]), ...(meta.streamingProviders.rent||[])];
    const discovered = state.settings.discoveredProviders || [];
    all.forEach(p => {
      if (!KNOWN_PROVIDERS.find(k => k.id === p.providerId) && !discovered.find(d => d.id === p.providerId)) {
        discovered.push({ id: p.providerId, name: p.name, logo: p.logo });
      }
    });
    state.settings.discoveredProviders = discovered;
    saveSettings();
  }

  // Build detail page HTML
  const results = document.getElementById('titlesearch-results');
  results.innerHTML = '';

  if (fromSearch) {
    const backBtn = document.createElement('button');
    backBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--t2);padding:6px 10px;border-radius:var(--radius-sm);background:none;border:none;cursor:pointer;margin-bottom:16px;transition:background 0.16s,color 0.16s;';
    backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back to results`;
    backBtn.addEventListener('mouseenter', () => { backBtn.style.background='var(--bg-3)'; backBtn.style.color='var(--t0)'; });
    backBtn.addEventListener('mouseleave', () => { backBtn.style.background='none'; backBtn.style.color='var(--t2)'; });
    backBtn.addEventListener('click', () => { openTitleSearch(title); });
    results.appendChild(backBtn);
  }

  // Hero row
  const hero = document.createElement('div');
  hero.style.cssText = 'display:flex;gap:24px;margin-bottom:24px;';

  const posterEl = document.createElement('img');
  const posterSrc = meta.posterUrl || posterUrl;
  if (posterSrc) {
    posterEl.src = posterSrc;
    posterEl.style.cssText = 'width:160px;height:240px;border-radius:10px;object-fit:cover;flex-shrink:0;border:1px solid var(--border);';
  }

  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  const typeLabel = mediaType === 'tv' ? 'TV Series' : 'Movie';
  const badges = [`<span style="font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:var(--accent-soft);color:var(--text-accent);border:1px solid rgba(124,92,252,.3)">${typeLabel}</span>`];
  if (meta.year) badges.push(`<span style="font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:var(--bg-3);color:var(--t1);border:1px solid var(--border)">${meta.year}</span>`);
  if (meta.rated) badges.push(`<span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--bg-3);color:var(--t1);border:1px solid var(--border)">${esc(meta.rated)}</span>`);
  (meta.genres||[]).slice(0,3).forEach(g => badges.push(`<span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--bg-3);color:var(--t1);border:1px solid var(--border)">${esc(g)}</span>`));

  // Ratings
  let ratingsHtml = '';
  if (meta.imdbRating || meta.tmdbRating) {
    const score = meta.imdbRating || meta.tmdbRating;
    const sm = scoreMeta(score);
    if (sm) {
      ratingsHtml = `<div style="display:inline-flex;flex-direction:column;align-items:center;padding:5px 10px 4px;border-radius:7px;border:1.5px solid ${sm.color};background:rgba(0,0,0,.3);gap:1px;margin-bottom:12px;">
        <span style="font-size:7px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${sm.color};opacity:.85;">${meta.imdbRating?'IMDB':'TMDB'}</span>
        <span style="font-size:20px;font-weight:900;color:${sm.color};font-family:'DM Mono',monospace;line-height:1.1;">${score}</span>
        <span style="font-size:7px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${sm.color};opacity:.85;">${sm.label}</span>
      </div>`;
    }
  }

  // Streaming banner
  const streamHtml = meta.streamingProviders ? buildStreamingBanner(meta.streamingProviders) : '';

  info.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${badges.join('')}</div>
    <h1 style="font-size:26px;font-weight:900;letter-spacing:-.02em;color:var(--t0);margin-bottom:10px;">${esc(meta.title||title)}</h1>
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:14px;">${ratingsHtml}${streamHtml}</div>
    <p style="font-size:13px;color:var(--t1);line-height:1.7;margin-bottom:16px;">${esc(meta.overview||'No description available.')}</p>
    <div style="font-size:12px;color:var(--t2);font-family:'DM Mono',monospace;">
      ${meta.runtime ? `${meta.runtime} min · ` : ''}${meta.status||''}
    </div>`;

  if (posterSrc) hero.appendChild(posterEl);
  hero.appendChild(info);
  results.appendChild(hero);

  // Add to My List button
  const isLocal = isInLocalLibrary(tmdbId, title);
  if (!isLocal) {
    const wlRow = document.createElement('div');
    wlRow.style.cssText = 'margin-bottom:16px;';
    const wlInList = state.watchlist.find(w => String(w.tmdbId) === String(tmdbId));
    const wlBtn = document.createElement('button');
    wlBtn.className = 'btn-secondary';
    wlBtn.style.cssText = 'display:inline-flex;align-items:center;gap:7px;font-size:12px;';
    wlBtn.innerHTML = wlInList
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> In My List`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Add to My List`;
    if (wlInList) { wlBtn.style.color='var(--green)'; wlBtn.style.borderColor='var(--green)'; }
    wlBtn.addEventListener('click', () => {
      if (!state.watchlist.find(w => String(w.tmdbId) === String(tmdbId))) {
        addToWatchlist(tmdbId, mediaType, title, meta.year, meta.posterUrl || posterUrl, meta.overview);
        wlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> In My List`;
        wlBtn.style.color='var(--green)'; wlBtn.style.borderColor='var(--green)';
      }
    });
    wlRow.appendChild(wlBtn);
    results.appendChild(wlRow);
  }

  // Cast section — reuse renderCastRows style
  if ((meta.crewFull||[]).length || (meta.castFull||[]).length) {
    const castWrap = document.createElement('div');
    castWrap.id = 'titlesearch-cast-wrap';
    results.appendChild(castWrap);

    // Fetch headshots
    api.fetchHeadshots(meta.castFull||[], meta.crewFull||[]).then(headshots => {
      const wrap = document.getElementById('titlesearch-cast-wrap');
      if (!wrap) return;
      wrap.innerHTML = '';
      if ((meta.crewFull||[]).length) renderTitleCastSection(wrap, 'Creative Team', meta.crewFull, headshots);
      if ((meta.castFull||[]).length) renderTitleCastSection(wrap, 'Cast', meta.castFull, headshots);
    }).catch(() => {});
  }
}

function renderTitleCastSection(container, label, people, headshots) {
  if (!people || !people.length) return;
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:20px;';
  section.innerHTML = `<div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);">${label}</div>`;
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  people.forEach(person => {
    const row = document.createElement('button');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--radius-sm);cursor:pointer;background:none;border:none;width:100%;text-align:left;transition:background 0.16s;';
    row.addEventListener('mouseenter', () => row.style.background='var(--bg-3)');
    row.addEventListener('mouseleave', () => row.style.background='none');
    const hs = headshots && headshots[person.name];
    const initials = person.name.split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase();
    const avatarHtml = hs
      ? `<img style="width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;" src="${esc(toMediaUrl(hs))}" loading="lazy">`
      : `<div style="width:38px;height:38px;border-radius:50%;background:var(--bg-3);border:1px solid var(--border);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--t2);">${initials}</div>`;
    row.innerHTML = `${avatarHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(person.name)}</div>
        <div style="font-size:11px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(person.character||person.job||'')}</div>
      </div>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--t2)" stroke-width="2" style="opacity:0;transition:opacity 0.16s;flex-shrink:0;"><polyline points="9 18 15 12 9 6"/></svg>`;
    row.addEventListener('mouseenter', () => { row.querySelector('svg').style.opacity='1'; });
    row.addEventListener('mouseleave', () => { row.querySelector('svg').style.opacity='0'; });
    row.addEventListener('click', () => {
      // Close cinematic overlay if open before navigating to actor profile
      const cinOverlay = document.getElementById('cinematic-overlay');
      if (cinOverlay && cinOverlay.style.display !== 'none') closeDetailedOverlay();
      openActorProfile(person.name);
    });
    list.appendChild(row);
  });
  section.appendChild(list);
  container.appendChild(section);
}

// ═══════════════════════════════════════════════════════
// TV SHOW EPISODE PANEL — Disney+/Hulu style
// ═══════════════════════════════════════════════════════

// Cache for TMDB episode data: tmdbId_seasonNum → episodes[]
const tvEpisodeCache = {};

function renderTVEpisodePanel(item, meta, container) {
  container.innerHTML = '';

  const bySeasons = {};
  (item.episodes || []).forEach(e => {
    if (!bySeasons[e.season]) bySeasons[e.season] = [];
    bySeasons[e.season].push(e);
  });
  const seasonNums = Object.keys(bySeasons).map(Number).sort((a,b) => a - b);
  if (!seasonNums.length) return;

  // ── Season selector ──────────────────────────────────
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:14px;';

  const select = document.createElement('select');
  select.style.cssText = 'padding:7px 12px;background:var(--bg-3);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--t0);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;outline:none;';
  seasonNums.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Season ${s}  (${bySeasons[s].length} ep${bySeasons[s].length!==1?'s':''})`;
    opt.style.cssText = 'background:var(--bg-2);color:var(--t0);';
    select.appendChild(opt);
  });
  header.appendChild(select);

  // Progress bar — takes all remaining space
  const progressWrap = document.createElement('div');
  progressWrap.style.cssText = 'flex:1;height:4px;background:var(--bg-4);border-radius:2px;min-width:30px;';
  const progressBar = document.createElement('div');
  progressBar.style.cssText = 'height:4px;border-radius:2px;background:#4cde8a;width:0;transition:width 0.3s ease;';
  progressWrap.appendChild(progressBar);
  header.appendChild(progressWrap);

  const progressTxt = document.createElement('span');
  progressTxt.style.cssText = 'font-size:11px;color:var(--t2);white-space:nowrap;';
  progressTxt.textContent = '0 / 0';
  header.appendChild(progressTxt);

  // Mark season watched button — short label to fit panel width
  const markSeasonBtn = document.createElement('button');
  markSeasonBtn.style.cssText = 'padding:5px 10px;background:var(--bg-3);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--t2);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.16s;white-space:nowrap;flex-shrink:0;';
  markSeasonBtn.textContent = 'Mark watched';
  markSeasonBtn.addEventListener('mouseenter', () => { markSeasonBtn.style.background='var(--bg-4)'; markSeasonBtn.style.color='var(--t0)'; });
  markSeasonBtn.addEventListener('mouseleave', () => { markSeasonBtn.style.background='var(--bg-3)'; markSeasonBtn.style.color='var(--t2)'; });
  markSeasonBtn.addEventListener('click', () => {
    const seasonNum = parseInt(select.value);
    const eps = bySeasons[seasonNum] || [];
    const allWatched = eps.every(e => e.watched);
    eps.forEach(e => {
      e.watched = !allWatched;
      if (e.path) {
        for (const show of state.tvShows) {
          const liveEp = (show.episodes || []).find(le => le.path === e.path);
          if (liveEp) { liveEp.watched = e.watched; break; }
        }
      }
    });
    renderSeason(seasonNum);
    saveLibrary();
  });
  header.appendChild(markSeasonBtn);

  container.appendChild(header);

  // ── Episode list container ───────────────────────────
  const epList = document.createElement('div');
  epList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  container.appendChild(epList);

  function updateSeasonProgress(eps) {
    const watchedCount = eps.filter(e => e.watched).length;
    const pct = eps.length ? Math.round(watchedCount / eps.length * 100) : 0;
    progressBar.style.width = pct + '%';
    progressTxt.textContent = `${watchedCount} / ${eps.length}`;
    markSeasonBtn.textContent = watchedCount === eps.length ? 'Unmark' : 'Mark watched';
  }

  function renderSeason(seasonNum) {
    epList.innerHTML = '';
    const eps = (bySeasons[seasonNum] || []).sort((a,b) => a.episode - b.episode);
    updateSeasonProgress(eps);

    // Try to load TMDB episode data for this season
    const cacheKey = `${meta.tmdbId}_${seasonNum}`;
    const tmdbEps  = tvEpisodeCache[cacheKey] || null;

    // Find episode numbers that appear more than once (different files, same ep number)
    const epNumCount = {};
    eps.forEach(ep => { epNumCount[ep.episode] = (epNumCount[ep.episode] || 0) + 1; });

    eps.forEach(ep => {
      const tmdbEp = tmdbEps ? tmdbEps.find(t => t.episode_number === ep.episode) : null;
      const isDuplicate = epNumCount[ep.episode] > 1;
      epList.appendChild(buildEpisodeCard(ep, tmdbEp, () => updateSeasonProgress(eps), isDuplicate));
    });

    // episode count shown in season selector label

    // If we have a tmdbId but no cached data, fetch in background
    if (meta.tmdbId && !tvEpisodeCache[cacheKey] && state.settings.tmdbKey) {
      fetchTVSeasonData(meta.tmdbId, seasonNum).then(data => {
        if (data && data.episodes) {
          tvEpisodeCache[cacheKey] = data.episodes;
          if (parseInt(select.value) === seasonNum) renderSeason(seasonNum);
        }
      });
    }
  }

  select.addEventListener('change', () => renderSeason(parseInt(select.value)));
  renderSeason(seasonNums[0]);
}

async function fetchTVSeasonData(tmdbId, seasonNum) {
  if (!state.settings.tmdbKey) return null;
  try {
    const resp = await api.tmdbGet(
      `/3/tv/${tmdbId}/season/${seasonNum}`
    );
    if (!resp || resp.error) return null;
    return resp;
  } catch { return null; }
}

function applyEpisodeWatchedStyle(card, watched) {
  if (watched) {
    card.style.background     = 'rgba(13,31,13,0.85)';
    card.style.borderColor    = '#27500a';
    card.style.borderWidth    = '1px';
  } else {
    card.style.background     = 'var(--bg-2)';
    card.style.borderColor    = 'var(--border)';
  }
  // Update still overlay tint
  const tint = card.querySelector('.ep-watched-tint');
  if (tint) tint.style.opacity = watched ? '1' : '0';
  // Update check badge
  const badge = card.querySelector('.ep-check-badge');
  if (badge) badge.style.display = watched ? 'flex' : 'none';
  // Update title colour
  const titleEl = card.querySelector('.ep-title-text');
  if (titleEl) titleEl.style.color = watched ? '#97C459' : 'var(--t0)';
  const numEl = card.querySelector('.ep-num-text');
  if (numEl) numEl.style.color = watched ? '#3B6D11' : 'var(--t2)';
  const metaEl = card.querySelector('.ep-meta-text');
  if (metaEl) metaEl.style.color = watched ? '#3B6D11' : 'var(--t2)';
}

function buildEpisodeCard(localEp, tmdbEp, onWatchedToggle, isDuplicate) {
  const isWatched = !!localEp.watched;
  const card = document.createElement('div');
  card.style.cssText = 'display:flex;gap:12px;padding:10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-2);cursor:pointer;transition:border-color 0.16s,background 0.16s;align-items:flex-start;position:relative;';
  card.addEventListener('mouseenter', () => {
    if (!localEp.watched) { card.style.borderColor='var(--border-mid)'; card.style.background='var(--bg-3)'; }
  });
  card.addEventListener('mouseleave', () => {
    if (!localEp.watched) { card.style.borderColor='var(--border)'; card.style.background='var(--bg-2)'; }
  });
  if (isWatched) applyEpisodeWatchedStyle(card, true);

  // Still image or placeholder
  const stillWrap = document.createElement('div');
  stillWrap.style.cssText = 'width:120px;height:68px;border-radius:6px;overflow:hidden;background:var(--bg-4);flex-shrink:0;position:relative;';

  if (tmdbEp && tmdbEp.still_path) {
    const img = document.createElement('img');
    img.src = `https://image.tmdb.org/t/p/w300${tmdbEp.still_path}`;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.onerror = () => img.style.display = 'none';
    stillWrap.appendChild(img);
  } else {
    stillWrap.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--t2);"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>`;
  }

  // Green tint overlay for watched state
  const watchedTint = document.createElement('div');
  watchedTint.className = 'ep-watched-tint';
  watchedTint.style.cssText = `position:absolute;inset:0;background:rgba(13,40,13,.55);border-radius:6px;opacity:${isWatched?'1':'0'};transition:opacity 0.16s;pointer-events:none;`;
  stillWrap.appendChild(watchedTint);

  // Check badge
  const checkBadge = document.createElement('div');
  checkBadge.className = 'ep-check-badge';
  checkBadge.style.cssText = `position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;background:#1a4a1a;border:1.5px solid #4cde8a;display:${isWatched?'flex':'none'};align-items:center;justify-content:center;z-index:2;`;
  checkBadge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4cde8a" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  stillWrap.appendChild(checkBadge);

  // Play button overlay on still — only shown when there's a local file to play
  const playOverlay = document.createElement('div');
  playOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);opacity:0;transition:opacity 0.16s;border-radius:6px;';
  playOverlay.innerHTML = `<div style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="#111"><path d="M5 3l14 9-14 9V3z"/></svg></div>`;
  if (localEp.path) {
    stillWrap.appendChild(playOverlay);
    card.addEventListener('mouseenter', () => playOverlay.style.opacity = '1');
    card.addEventListener('mouseleave', () => playOverlay.style.opacity = '0');
  }

  card.appendChild(stillWrap);

  // Info
  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  const epTitle = tmdbEp ? tmdbEp.name : localEp.filename.replace(/\.[^.]+$/,'');
  const runtime = tmdbEp && tmdbEp.runtime ? `${tmdbEp.runtime}m` : localEp.sizeHuman;
  const airDate = tmdbEp && tmdbEp.air_date ? new Date(tmdbEp.air_date).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'numeric'}) : '';
  const overview = tmdbEp && tmdbEp.overview ? tmdbEp.overview : '';
  // When multiple local files share the same episode number, show the filename
  // so the user can tell them apart (e.g. two different cuts of the same episode).
  const filenameLabel = isDuplicate
    ? `<div style="font-size:10px;color:var(--t2);font-family:'DM Mono',monospace;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(localEp.filename)}">${esc(localEp.filename.replace(/\.[^.]+$/, ''))}</div>`
    : '';

  info.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">
      <span class="ep-num-text" style="font-size:11px;font-weight:700;color:${isWatched?'#3B6D11':'var(--t2)'};font-family:'DM Mono',monospace;flex-shrink:0;">E${String(localEp.episode).padStart(2,'0')}</span>
      <span class="ep-title-text" style="font-size:13px;font-weight:600;color:${isWatched?'#97C459':'var(--t0)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(epTitle)}</span>
    </div>
    ${filenameLabel}
    ${overview ? `<p style="font-size:11px;color:var(--t1);line-height:1.55;margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(overview)}</p>` : ''}
    <div class="ep-meta-text" style="display:flex;align-items:center;gap:10px;font-size:10px;color:${isWatched?'#3B6D11':'var(--t2)'};font-family:'DM Mono',monospace;">
      ${airDate ? `<span>${airDate}</span>` : ''}
      <span>${runtime}</span>
    </div>`;

  // Watched toggle button (right side)
  const watchBtn = document.createElement('button');
  watchBtn.style.cssText = `width:28px;height:28px;border-radius:50%;flex-shrink:0;align-self:center;background:${isWatched?'#1a4a1a':'var(--bg-3)'};border:1.5px solid ${isWatched?'#4cde8a':'var(--border-mid)'};display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all 0.16s;`;
  watchBtn.title = isWatched ? 'Mark as unwatched' : 'Mark as watched';
  watchBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${isWatched?'#4cde8a':'var(--t2)'}" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  card.appendChild(info);
  card.appendChild(watchBtn);

  // Watch toggle — left click toggles watched, right click plays
  watchBtn.addEventListener('click', e => {
    e.stopPropagation();
    localEp.watched = !localEp.watched;
    // Mirror change onto the live state.tvShows episode (localEp may be a snapshot copy)
    if (localEp.path) {
      for (const show of state.tvShows) {
        const liveEp = (show.episodes || []).find(e => e.path === localEp.path);
        if (liveEp) { liveEp.watched = localEp.watched; break; }
      }
    }
    applyEpisodeWatchedStyle(card, localEp.watched);
    watchBtn.style.background = localEp.watched ? '#1a4a1a' : 'var(--bg-3)';
    watchBtn.style.borderColor = localEp.watched ? '#4cde8a' : 'var(--border-mid)';
    watchBtn.querySelector('svg').setAttribute('stroke', localEp.watched ? '#4cde8a' : 'var(--t2)');
    watchBtn.title = localEp.watched ? 'Mark as unwatched' : 'Mark as watched';
    if (onWatchedToggle) onWatchedToggle();
    saveLibrary();
  });

  // Click card body to play — only if there's a local file
  card.addEventListener('click', e => {
    if (e.target === watchBtn || watchBtn.contains(e.target)) return;
    if (localEp.path) api.openFile(localEp.path);
  });

  return card;
}

// ═══════════════════════════════════════════════════════
// CINEMATIC DETAIL OVERLAY (Detailed view mode)
// ═══════════════════════════════════════════════════════

function closeDetailedOverlay() {
  const overlay = document.getElementById('cinematic-overlay');
  if (overlay) overlay.style.setProperty('display', 'none', 'important');
  state.activeItem = null;
}

async function openDetailedOverlay(item, mode) {
  const sessionId = item.id + '_' + Date.now();
  // Deep-copy item to prevent live state mutations from corrupting this render
  const itemSnapshot = JSON.parse(JSON.stringify(item));
  state.activeItem = item; // keep live reference in state for updates
  state._overlaySession = sessionId;
  const overlay = document.getElementById('cinematic-overlay');
  const inner   = document.getElementById('cinematic-inner');
  if (!overlay || !inner) { openDetail(item); return; }

  overlay.style.setProperty('display', 'block', 'important');
  inner.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:14px;color:rgba(255,255,255,.6);font-size:14px;"><div class="spinner"></div>Loading…</div>`;

  // Remove any leftover floating toolbar from previous overlay
  document.querySelectorAll('.cin-floating-toolbar').forEach(el => el.remove());

  // Fetch metadata if needed
  if (!state.metadataFetched.has(itemSnapshot.id) && (state.settings.tmdbKey || state.settings.omdbKey)) {
    fetchMetadataForItem(item);
    await new Promise(resolve => {
      let tries = 0;
      const poll = setInterval(() => {
        if (state._overlaySession !== sessionId) { clearInterval(poll); resolve(); return; }
        const cur = [...state.library, ...state.tvShows].find(x => x.id === itemSnapshot.id);
        if ((cur && cur.metadata) || ++tries > 16) { clearInterval(poll); resolve(); }
      }, 500);
    });
  }

  if (state._overlaySession !== sessionId) return;

  // Read fresh metadata from state but use snapshot for identity/path fields
  const liveItem = [...state.library, ...state.tvShows].find(x => x.id === itemSnapshot.id) || item;
  // Merge: take live metadata but keep snapshot's identity fields to prevent cross-contamination
  const safeItem = {
    ...itemSnapshot,
    metadata:   liveItem.metadata   || itemSnapshot.metadata,
    posterPath: liveItem.posterPath || itemSnapshot.posterPath,
    status:     liveItem.status     || itemSnapshot.status,
    // Use live episodes array so watched state mutations persist correctly
    episodes:   liveItem.episodes   || itemSnapshot.episodes,
  };
  state.activeItem = safeItem;
  renderCinematicOverlay(safeItem, mode || 'frosted');
}

function renderCinematicOverlay(item, mode) {
  const overlay = document.getElementById('cinematic-overlay');
  const inner   = document.getElementById('cinematic-inner');
  const m = item.metadata || {};

  const hasBackdrop = !!m.backdropPath;
  // Cinematic falls back to Frosted if no backdrop
  const effectiveMode = (mode === 'cinematic' && !hasBackdrop) ? 'frosted' : (mode || 'frosted');

  const backdropUrl = m.backdropPath
    ? `https://image.tmdb.org/t/p/original${m.backdropPath}`
    : (item.posterPath ? toMediaUrl(item.posterPath) : null);

  inner.style.cssText = `min-height:100vh;position:relative;background:#0a0a0f;`;
  inner.innerHTML = '';

  if (effectiveMode === 'cinematic') {
    renderCinematicStyleC(inner, item, m, backdropUrl);
  } else if (effectiveMode === 'focused') {
    renderCinematicStyleB(inner, item, m, backdropUrl);
  } else {
    renderCinematicStyleA(inner, item, m, backdropUrl);
  }
}

// ── Shared helpers ────────────────────────────────────────
function cinFloatingToolbar(item) {
  // Returns an "Options" button to be placed inline with action buttons
  // Uses class cin-floating-toolbar so old ones can be cleaned up on re-open
  const wrap = document.createElement('div');
  wrap.className = 'cin-floating-toolbar';
  wrap.style.cssText = 'position:relative;display:inline-flex;flex-direction:column;align-items:flex-start;';

  const trigger = document.createElement('button');
  trigger.style.cssText = 'display:inline-flex;align-items:center;gap:7px;padding:11px 18px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);transition:background 0.16s;';
  trigger.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/></svg>Options`;
  trigger.addEventListener('mouseenter', () => trigger.style.background = 'rgba(255,255,255,.18)');
  trigger.addEventListener('mouseleave', () => { if (!panelOpen) trigger.style.background = 'rgba(255,255,255,.1)'; });

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;position:absolute;bottom:calc(100% + 8px);left:0;flex-direction:column;gap:2px;background:rgba(10,10,20,.95);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:6px;min-width:180px;z-index:200;';

  function makeAction(icon, label, onClick) {
    const btn = document.createElement('button');
    btn.style.cssText = 'display:flex;align-items:center;gap:9px;padding:9px 12px;background:none;border:none;color:rgba(255,255,255,.85);font-size:13px;font-weight:500;cursor:pointer;border-radius:6px;font-family:inherit;transition:background 0.12s;text-align:left;width:100%;';
    btn.innerHTML = `${icon}<span>${label}</span>`;
    btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,.1)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', () => { closePanel(); onClick(); });
    return btn;
  }

  panel.appendChild(makeAction(
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    'Remap title',
    () => {
      closeDetailedOverlay();
      const key = item.type === 'tv' ? 'tvDetailView' : 'movieDetailView';
      const origMode = state.settings[key];
      state.settings[key] = 'minimal';
      openDetail(item);
      setTimeout(() => { state.settings[key] = origMode; }, 500);
      setTimeout(() => toggleRemapPanel(true), 300);
    }
  ));
  panel.appendChild(makeAction(
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    'Refresh metadata',
    () => { closeDetailedOverlay(); state.metadataFetched.delete(item.id); fetchMetadataForItem(item); showToast('Refreshing metadata…', 'info'); }
  ));
  panel.appendChild(makeAction(
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    'Hide from library',
    () => { closeDetailedOverlay(); hideItem(item); }
  ));
  panel.appendChild(makeAction(
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>',
    'Reset entry',
    () => { closeDetailedOverlay(); resetItems([item.id]); }
  ));

  let panelOpen = false;
  function closePanel() {
    panelOpen = false; panel.style.display = 'none';
    trigger.style.background = 'rgba(255,255,255,.1)';
  }
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';
    trigger.style.background = panelOpen ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.1)';
  });
  document.addEventListener('click', function outsideHandler(e) {
    if (!wrap.contains(e.target)) { closePanel(); }
  }, { once: false });

  wrap.appendChild(panel);
  wrap.appendChild(trigger);
  return wrap;
}

function cinBackdropLayer(bgUrl, gradient) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;inset:0;z-index:0;`;
  if (bgUrl) {
    const img = document.createElement('div');
    img.style.cssText = `position:absolute;inset:0;background-image:url('${bgUrl}');background-size:cover;background-position:center top;`;
    wrap.appendChild(img);
  }
  const grad = document.createElement('div');
  grad.style.cssText = `position:absolute;inset:0;background:${gradient};`;
  wrap.appendChild(grad);
  return wrap;
}

function cinBadges(item, m) {
  return [item.type==='tv'?'TV Series':'Movie', m.year||item.year, m.rated, ...(m.genres||[]).slice(0,3)]
    .filter(Boolean).map(b =>
      `<span style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:4px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.9);border:1px solid rgba(255,255,255,.18);">${esc(String(b))}</span>`
    ).join('');
}

function cinRating(m) {
  const score = m.imdbRating || m.tmdbRating;
  const sm = score ? scoreMeta(score) : null;
  if (!sm) return '';
  return `<div style="display:inline-flex;flex-direction:column;align-items:center;padding:5px 12px 4px;border-radius:8px;border:1.5px solid ${sm.color};background:rgba(0,0,0,.5);gap:1px;margin-bottom:14px;"><span style="font-size:7px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${sm.color};">${m.imdbRating?'IMDB':'TMDB'}</span><span style="font-size:22px;font-weight:900;color:${sm.color};font-family:'DM Mono',monospace;line-height:1.1;">${score}</span><span style="font-size:7px;font-weight:700;color:${sm.color};">${sm.label}</span></div>`;
}

function cinStreamingPill(m) {
  if (!m.streamingProviders) return '';
  const banner = buildStreamingBanner(m.streamingProviders);
  if (!banner) return '';
  // Already wrapped in fit-content div — return as-is
  return banner;
}

function cinActionBtns(item, closeOverlay) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px;align-items:center;';
  function btn(label, icon, primary, onClick) {
    const b = document.createElement('button');
    b.style.cssText = `display:inline-flex;align-items:center;gap:7px;padding:11px 22px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:none;transition:opacity 0.16s;${primary?'background:var(--accent);color:#fff;':'background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.15);'}`;
    b.innerHTML = `${icon}${label}`;
    b.addEventListener('mouseenter', () => b.style.opacity='.85');
    b.addEventListener('mouseleave', () => b.style.opacity='1');
    b.addEventListener('click', onClick);
    return b;
  }
  if (item.type==='movie'&&item.path) wrap.appendChild(btn('Play','<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>',true,()=>api.openFile(item.path)));
  wrap.appendChild(btn('Show in Folder','<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',false,()=>item.path&&api.revealFile(item.path)));
  wrap.appendChild(cinFloatingToolbar(item));
  // Spacer pushes Close to the far right
  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1;';
  wrap.appendChild(spacer);
  wrap.appendChild(btn('Close','<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',false,closeOverlay));
  return wrap;
}

function cinCastSection(item, m) {
  if (!m.castFull && !m.crewFull) return null;
  const section = document.createElement('div');
  section.style.cssText = 'margin-top:24px;';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.45);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.1);';
  label.textContent = 'Cast & Crew';
  section.appendChild(label);
  const castWrap = document.createElement('div');
  castWrap.dataset.castTarget = item.id;
  section.appendChild(castWrap);
  api.fetchHeadshots(m.castFull||[], m.crewFull||[]).then(hs => {
    const w = document.querySelector(`[data-cast-target="${item.id}"]`);
    if (!w) return;
    if (m.crewFull?.length) renderTitleCastSection(w,'Creative Team',m.crewFull,hs);
    if (m.castFull?.length) renderTitleCastSection(w,'Cast',m.castFull,hs);
    w.querySelectorAll('[style*="color:var(--accent)"]').forEach(el=>el.style.color='#a78bfa');
    w.querySelectorAll('[style*="color:var(--t2)"]').forEach(el=>el.style.color='rgba(255,255,255,.5)');
    w.querySelectorAll('[style*="border-bottom:1px solid var(--border)"]').forEach(el=>el.style.borderColor='rgba(255,255,255,.1)');
  }).catch(()=>{});
  return section;
}

function cinLazyStreamingProviders(item, m, insertAfter) {
  if (m.streamingProviders || !m.tmdbId || !state.settings.tmdbKey) return;
  const country = state.settings.countryCode || Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';
  api.getWatchProviders(m.tmdbId, item.type==='tv'?'tv':'movie', country).then(providers => {
    if (!providers.flatrate) return;
    const found = [...state.library,...state.tvShows].find(x=>x.id===item.id);
    if (found?.metadata) found.metadata.streamingProviders = providers;
    const banner = buildStreamingBanner(providers);
    if (banner && insertAfter) insertAfter.insertAdjacentHTML('afterend', banner);
  }).catch(()=>{});
}


function cinFileInfo(item) {
  // Collapsible file info section
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:28px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px;';

  const toggle = document.createElement('button');
  toggle.style.cssText = 'display:flex;align-items:center;gap:7px;background:none;border:none;color:rgba(255,255,255,.45);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;padding:0;transition:color 0.16s;';
  toggle.innerHTML = `<svg id="finfo-chv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="transition:transform 0.16s;"><polyline points="9 18 15 12 9 6"/></svg>File Info`;
  toggle.addEventListener('mouseenter', () => toggle.style.color = 'rgba(255,255,255,.7)');
  toggle.addEventListener('mouseleave', () => { if (!open) toggle.style.color = 'rgba(255,255,255,.45)'; });

  const details = document.createElement('div');
  details.style.cssText = 'overflow:hidden;max-height:0;transition:max-height 0.25s ease;';

  const rows = [];
  if (item.type === 'tv') {
    rows.push(['Episodes', String(item.episodeCount || item.episodes?.length || '—')]);
    rows.push(['Seasons',  String(item.seasonCount || '—')]);
    rows.push(['Total size', item.sizeHuman || '—']);
    rows.push(['Folder', item.path || '—']);
  } else {
    rows.push(['File', item.filename || item.path?.split(/[\/]/).pop() || '—']);
    rows.push(['Size', item.sizeHuman || '—']);
    rows.push(['Format', (item.extension || '').toUpperCase().replace('.','') || '—']);
    rows.push(['Added', item.createdAt ? new Date(item.createdAt).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'numeric'}) : '—']);
    rows.push(['Path', item.path || '—']);
  }

  const table = document.createElement('div');
  table.style.cssText = 'padding:12px 0;display:flex;flex-direction:column;gap:6px;';
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;font-size:12px;';
    row.innerHTML = `<span style="color:rgba(255,255,255,.4);font-weight:600;min-width:80px;flex-shrink:0;">${esc(label)}</span><span style="color:rgba(255,255,255,.75);font-family:'DM Mono',monospace;word-break:break-all;">${esc(value)}</span>`;
    table.appendChild(row);
  });
  details.appendChild(table);

  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    const chv = toggle.querySelector('#finfo-chv');
    if (chv) chv.style.transform = open ? 'rotate(90deg)' : '';
    toggle.style.color = open ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.45)';
    details.style.maxHeight = open ? `${rows.length * 32 + 24}px` : '0';
  });

  wrap.appendChild(toggle);
  wrap.appendChild(details);
  return wrap;
}

// ── Style A: Frosted ──────────────────────────────────────
function renderCinematicStyleA(inner, item, m, backdropUrl) {
  inner.style.cssText = `min-height:100vh;position:relative;background:#0a0a0f;`;
  inner.appendChild(cinBackdropLayer(backdropUrl,
    'linear-gradient(to right, rgba(5,5,15,.96) 0%, rgba(5,5,15,.75) 45%, rgba(5,5,15,.3) 100%)'));

  // Options toolbar added inline in action buttons

  const content = document.createElement('div');
  content.style.cssText = 'position:relative;z-index:2;max-width:1100px;margin:0 auto;padding:40px 48px 60px;min-height:100vh;display:flex;flex-direction:column;';
  inner.appendChild(content);

  const hero = document.createElement('div');
  hero.style.cssText = 'display:flex;gap:32px;align-items:flex-start;margin-bottom:28px;';
  if (item.posterPath) {
    const p = document.createElement('img');
    p.src=toMediaUrl(item.posterPath); p.style.cssText='width:160px;height:240px;border-radius:10px;object-fit:cover;flex-shrink:0;box-shadow:0 12px 40px rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.1);';
    hero.appendChild(p);
  }
  const heroInfo = document.createElement('div');
  heroInfo.style.cssText = 'flex:1;min-width:0;';
  heroInfo.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${cinBadges(item,m)}</div>
    <h1 style="font-size:38px;font-weight:900;letter-spacing:-.02em;color:#fff;line-height:1.05;margin-bottom:14px;text-shadow:0 2px 8px rgba(0,0,0,.6);">${esc(item.displayTitle||item.title)}</h1>
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:14px;">${cinRating(m)}${cinStreamingPill(m)}</div>`;
  // Frosted synopsis card
  const synCard = document.createElement('div');
  synCard.style.cssText = 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:16px 18px;margin-top:12px;max-width:600px;backdrop-filter:blur(4px);';
  synCard.innerHTML = `<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:8px;">Synopsis</div><p style="font-size:13px;color:rgba(255,255,255,.85);line-height:1.75;margin:0;">${esc(m.overview||'No description available.')}</p>`;
  heroInfo.appendChild(synCard);
  hero.appendChild(heroInfo);
  content.appendChild(hero);
  content.appendChild(cinActionBtns(item, closeDetailedOverlay));
  if (item.type==='tv'&&item.episodes?.length) {
    const ep=document.createElement('div'); ep.style.marginBottom='32px';
    const epl=document.createElement('h2'); epl.style.cssText='font-size:18px;font-weight:700;color:#fff;margin-bottom:14px;'; epl.textContent='Episodes';
    ep.appendChild(epl); const epb=document.createElement('div'); renderTVEpisodePanel(item,m,epb); ep.appendChild(epb); content.appendChild(ep);
  }
  const cs = cinCastSection(item,m); if(cs) content.appendChild(cs);
  content.appendChild(cinFileInfo(item));
  cinLazyStreamingProviders(item, m, heroInfo.querySelector('h1'));
  const escH = e => { if(e.key==='Escape'){closeDetailedOverlay();document.removeEventListener('keydown',escH);}};
  document.addEventListener('keydown', escH);
}

// ── Style B: Focused ──────────────────────────────────────
function renderCinematicStyleB(inner, item, m, backdropUrl) {
  inner.style.cssText = `min-height:100vh;position:relative;background:#08050f;display:flex;`;
  // Left solid panel
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = 'width:480px;flex-shrink:0;background:rgba(8,5,15,.97);position:relative;z-index:2;display:flex;flex-direction:column;padding:40px 36px 40px;overflow-y:auto;min-height:100vh;';
  // Right backdrop
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = `flex:1;position:relative;`;
  if (backdropUrl) {
    rightPanel.style.backgroundImage=`url('${backdropUrl}')`;
    rightPanel.style.backgroundSize='cover';
    rightPanel.style.backgroundPosition='center';
  }
  const rightGrad = document.createElement('div');
  rightGrad.style.cssText='position:absolute;inset:0;background:linear-gradient(to right, rgba(8,5,15,.85) 0%, transparent 40%);';
  rightPanel.appendChild(rightGrad);

  // Options toolbar added inline in action buttons

  // Content in left panel
  leftPanel.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">${cinBadges(item,m)}</div>
    <h1 style="font-size:32px;font-weight:900;letter-spacing:-.02em;color:#fff;line-height:1.1;margin-bottom:14px;">${esc(item.displayTitle||item.title)}</h1>
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:14px;">${cinRating(m)}${cinStreamingPill(m)}</div>`;
  // Left-border synopsis
  const syn = document.createElement('div');
  syn.style.cssText='border-left:3px solid rgba(124,92,252,.5);padding-left:14px;margin:14px 0 20px;';
  syn.innerHTML=`<p style="font-size:13px;color:rgba(255,255,255,.8);line-height:1.75;margin:0;">${esc(m.overview||'No description available.')}</p>`;
  leftPanel.appendChild(syn);

  const btns = cinActionBtns(item, closeDetailedOverlay);
  btns.style.marginBottom='24px';
  leftPanel.appendChild(btns);

  if (item.type==='tv'&&item.episodes?.length) {
    const epl=document.createElement('h2'); epl.style.cssText='font-size:16px;font-weight:700;color:#fff;margin-bottom:12px;'; epl.textContent='Episodes';
    leftPanel.appendChild(epl); const epb=document.createElement('div'); renderTVEpisodePanel(item,m,epb); leftPanel.appendChild(epb);
  }
  const cs = cinCastSection(item,m); if(cs) leftPanel.appendChild(cs);
  leftPanel.appendChild(cinFileInfo(item));

  inner.appendChild(leftPanel);
  inner.appendChild(rightPanel);
  cinLazyStreamingProviders(item, m, leftPanel.querySelector('h1'));
  const escH = e => { if(e.key==='Escape'){closeDetailedOverlay();document.removeEventListener('keydown',escH);}};
  document.addEventListener('keydown', escH);
}

// ── Style C: Cinematic ────────────────────────────────────
function renderCinematicStyleC(inner, item, m, backdropUrl) {
  inner.style.cssText = `min-height:100vh;position:relative;background:#0a0a0f;display:flex;flex-direction:column;`;

  // Full-bleed backdrop
  const bg = document.createElement('div');
  bg.style.cssText = `position:absolute;inset:0;z-index:0;`;
  if (backdropUrl) { bg.style.backgroundImage=`url('${backdropUrl}')`; bg.style.backgroundSize='cover'; bg.style.backgroundPosition='center top'; }
  inner.appendChild(bg);
  // Gradient — light at top, dark at bottom for bottom bar
  const grad = document.createElement('div');
  grad.style.cssText='position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(to bottom, rgba(0,0,0,.4) 0%, rgba(0,0,0,.05) 25%, rgba(0,0,0,.05) 45%, rgba(0,0,0,.5) 62%, rgba(0,0,0,.85) 74%, rgba(0,0,0,.96) 82%, rgba(0,0,0,.99) 100%);';
  inner.appendChild(grad);

  // Options toolbar added inline in action buttons

  // Floating info (poster + title + rating) in upper-left
  const floatInfo = document.createElement('div');
  floatInfo.style.cssText='position:relative;z-index:2;padding:36px 44px 0;display:flex;gap:24px;align-items:flex-end;';
  if (item.posterPath) {
    const p=document.createElement('img'); p.src=toMediaUrl(item.posterPath);
    p.style.cssText='width:130px;height:195px;border-radius:8px;object-fit:cover;flex-shrink:0;box-shadow:0 8px 32px rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.1);';
    floatInfo.appendChild(p);
  }
  const titleBlock=document.createElement('div'); titleBlock.style.cssText='flex:1;min-width:0;padding-bottom:8px;';
  titleBlock.innerHTML=`<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;">${cinBadges(item,m)}</div>
    <h1 style="font-size:36px;font-weight:900;letter-spacing:-.02em;color:#fff;line-height:1.05;margin-bottom:12px;text-shadow:0 2px 10px rgba(0,0,0,.8);">${esc(item.displayTitle||item.title)}</h1>
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;">${cinRating(m)}</div>`;
  floatInfo.appendChild(titleBlock);
  inner.appendChild(floatInfo);

  // Spacer to push bottom bar down
  const spacer=document.createElement('div');
  spacer.style.cssText=`position:relative;z-index:2;flex:1;min-height:${item.type==='tv'?'20px':'120px'};`;
  inner.appendChild(spacer);

  // Bottom bar — solid, scrollable
  const bar=document.createElement('div');
  const barIsTV = item.type==='tv'&&item.episodes?.length;
  // Bar does NOT scroll itself — the outer overlay scrolls
  // This prevents episode cards from rendering behind the backdrop
  bar.style.cssText=`position:relative;z-index:2;background:rgba(0,0,0,.9);border-top:1px solid rgba(255,255,255,.1);padding:20px 44px 32px;`;
  // Make the whole overlay scrollable so bar content expands naturally below hero
  const cinOverlay = document.getElementById('cinematic-overlay');
  if (cinOverlay) cinOverlay.style.overflowY = 'auto';

  // Streaming + synopsis row
  const topRow=document.createElement('div');
  topRow.style.cssText='display:flex;gap:20px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap;';
  const synWrap=document.createElement('div'); synWrap.style.cssText='flex:1;min-width:220px;';
  synWrap.innerHTML=`<p style="font-size:13px;color:rgba(255,255,255,.8);line-height:1.7;margin:0;">${esc(m.overview||'No description available.')}</p>`;
  topRow.appendChild(synWrap);
  const streamWrap=document.createElement('div'); streamWrap.style.cssText='flex-shrink:0;';
  const streamHtml = cinStreamingPill(m);
  if (streamHtml) streamWrap.innerHTML=streamHtml;
  topRow.appendChild(streamWrap);
  bar.appendChild(topRow);

  // Action buttons
  bar.appendChild(cinActionBtns(item, closeDetailedOverlay));
  bar.appendChild(cinFileInfo(item));

  // TV episode browser in bottom bar
  if (barIsTV) {
    const epl=document.createElement('h2'); epl.style.cssText='font-size:16px;font-weight:700;color:#fff;margin:8px 0 14px;'; epl.textContent='Episodes';
    bar.appendChild(epl); const epb=document.createElement('div'); renderTVEpisodePanel(item,m,epb); bar.appendChild(epb);
  }

  inner.appendChild(bar);
  cinLazyStreamingProviders(item, m, streamWrap);
  const escH = e => { if(e.key==='Escape'){closeDetailedOverlay();document.removeEventListener('keydown',escH);}};
  document.addEventListener('keydown', escH);
}


// ═══════════════════════════════════════════════════════
// PERSON SEARCH — always-first, with disambiguation
// ═══════════════════════════════════════════════════════

async function openPersonSearch(query) {
  if (!state.settings.tmdbKey) {
    showToast('TMDB API key required', 'info'); return;
  }

  // Search TMDB person database
  let personResults;
  try {
    const resp = await api.tmdbGet(
      `/3/search/person?query=${encodeURIComponent(query)}&page=1`
    );
    const data = resp;
    personResults = (data.results || []).slice(0, 6);
  } catch {
    // Network error — fall back to title search
    openTitleSearch(query);
    return;
  }

  if (!personResults.length) {
    // No people found — fall back to title search
    openTitleSearch(query);
    return;
  }

  // Single result — only accept if it has decent popularity or known_for titles
  // Low popularity = likely a false positive (e.g. searching "Trackers" finds "Taheen Tracker")
  if (personResults.length === 1) {
    const top = personResults[0];
    const hasKnownFor  = (top.known_for || []).length > 0;
    const isPopular    = (top.popularity || 0) >= 3;
    if (hasKnownFor && isPopular) {
      openActorProfile(top.name);
      return;
    }
    // Low confidence single result — treat as title search instead
    openTitleSearch(query);
    return;
  }

  // Check if top result is a very strong match (exact name, high popularity)
  const topName = (personResults[0].name || '').toLowerCase();
  const queryLower = query.toLowerCase();
  if (topName === queryLower && personResults[0].popularity > 5) {
    openActorProfile(personResults[0].name);
    return;
  }

  // If ALL person results have very low popularity and no known_for titles,
  // the query is almost certainly a title name, not a person name
  const allLowConfidence = personResults.every(p =>
    (p.popularity || 0) < 2 && (p.known_for || []).length === 0
  );
  if (allLowConfidence) {
    openTitleSearch(query);
    return;
  }

  // Multiple results → show disambiguation page
  state.previousView = state.currentView !== 'titlesearch' ? state.currentView : (state.previousView || 'library');
  switchView('titlesearch');

  const wrap    = document.getElementById('titlesearch-wrap');
  const loading = document.getElementById('titlesearch-loading');
  const results = document.getElementById('titlesearch-results');
  loading.style.display = 'none';
  wrap.style.display = 'flex';
  results.innerHTML = '';

  // Back button lives in the toolbar

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--t2);margin-bottom:12px;';
  heading.textContent = `${personResults.length} people found for "${query}"`;
  results.appendChild(heading);

  // Title search fallback link
  const titleFallback = document.createElement('button');
  titleFallback.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--t2);background:none;border:none;cursor:pointer;padding:0 0 14px;font-family:inherit;text-decoration:underline;';
  titleFallback.textContent = `Search titles instead →`;
  titleFallback.addEventListener('click', () => openTitleSearch(query));
  results.appendChild(titleFallback);

  personResults.forEach(person => {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;gap:14px;padding:14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-2);cursor:pointer;transition:border-color 0.16s,background 0.16s;align-items:center;margin-bottom:8px;';
    card.addEventListener('mouseenter', () => { card.style.borderColor='var(--border-mid)'; card.style.background='var(--bg-3)'; });
    card.addEventListener('mouseleave', () => { card.style.borderColor='var(--border)'; card.style.background='var(--bg-2)'; });

    // Photo
    const photoWrap = document.createElement('div');
    photoWrap.style.cssText = 'width:56px;height:56px;border-radius:50%;overflow:hidden;background:var(--bg-4);flex-shrink:0;';
    if (person.profile_path) {
      const img = document.createElement('img');
      img.src = `https://image.tmdb.org/t/p/w185${person.profile_path}`;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = () => img.remove();
      photoWrap.appendChild(img);
    }
    card.appendChild(photoWrap);

    // Info
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const knownFor = person.known_for_department || 'Unknown';
    const localCount = (person.known_for || []).filter(kf =>
      isInLocalLibrary(kf.id, kf.title || kf.name)
    ).length;
    const knownForTitles = (person.known_for || []).slice(0,3).map(kf => kf.title || kf.name).filter(Boolean).join(', ');

    info.innerHTML = `
      <div style="font-size:15px;font-weight:700;color:var(--t0);margin-bottom:3px;">${esc(person.name)}</div>
      <div style="font-size:12px;color:var(--accent);font-weight:600;margin-bottom:4px;">${esc(knownFor)}</div>
      ${knownForTitles ? `<div style="font-size:11px;color:var(--t2);">Known for: ${esc(knownForTitles)}</div>` : ''}
      ${localCount ? `<div style="font-size:11px;color:var(--green);font-weight:600;margin-top:3px;">● ${localCount} title${localCount!==1?'s':''} in your library</div>` : ''}`;
    card.appendChild(info);

    // Arrow
    card.innerHTML += `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t2)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
    card.addEventListener('click', () => openActorProfile(person.name));
    results.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════
// RESCAN — refresh all watched folders for new content
// ═══════════════════════════════════════════════════════

async function handleRescan(silent = false) {
  if (!state.folders.length) {
    if (!silent) showToast('No folders added yet', 'info');
    return;
  }
  const btn = document.getElementById('rescan-btn');
  if (btn) { btn.classList.add('scanning'); btn.querySelector('svg').style.animation = 'spin 1s linear infinite'; }

  if (!silent) showProgress(true, 'Rescanning…', 0);

  try {
    // Prune deleted files (also runs at startup, but run again here for manual rescans)
    const pruned = silent ? { movies: 0, shows: 0, episodes: 0 } : await pruneDeletedFiles(false);

    const scanSettings = { junkKeywords: state.settings.junkKeywords, minFileSizeMb: state.settings.minFileSizeMb };
    const result = await api.scanFolders(state.folders, state.settings.excludedFolders, scanSettings);

    // Only add genuinely new items — don't touch existing ones with metadata
    // For multi-part movies, add ALL part paths to the existing set
    const existingMoviePaths = new Set();
    state.library.forEach(f => {
      existingMoviePaths.add((f.path||'').toLowerCase());
      (f.parts||[]).forEach(p => existingMoviePaths.add((p.path||'').toLowerCase()));
    });
    // TV: match by id (stable hash of title+rootPath), normalised title, or tmdbId
    const existingTVIds      = new Set(state.tvShows.map(s => s.id));
    const normTitle = t => (t||'').toLowerCase().replace(/[^a-z0-9]/g,'').trim();
    const existingTVTitles   = new Set(state.tvShows.map(s => normTitle(s.title)));
    const existingTVTmdbIds  = new Set(state.tvShows.map(s => s.metadata?.tmdbId).filter(Boolean).map(String));
    const existingTVPaths    = new Set(state.tvShows.map(s => (s.path||'').toLowerCase()));

    const newMovies = (result.movies || []).filter(f =>
      !existingMoviePaths.has((f.path||'').toLowerCase()) &&
      !state.hiddenFolders.some(hf => (f.path||'').startsWith(hf))
    );
    const newTV = [];
    for (const s of (result.tvShows || [])) {
      if (state.hiddenFolders.some(hf => (s.path||'').startsWith(hf))) continue;

      // Find an existing show that matches by id, normalised title, or tmdbId
      const existing = state.tvShows.find(ex =>
        ex.id === s.id ||
        normTitle(ex.title) === normTitle(s.title) ||
        (s.metadata?.tmdbId && ex.metadata?.tmdbId &&
          String(ex.metadata.tmdbId) === String(s.metadata.tmdbId))
      );

      if (existing) {
        // Merge any episodes whose path isn't already tracked.
        // Case-insensitive comparison — Windows paths are case-insensitive.
        const knownPaths = new Set((existing.episodes || []).map(e => (e.path||'').toLowerCase()));
        const newEps = (s.episodes || []).filter(e => !knownPaths.has((e.path||'').toLowerCase()));
        if (newEps.length) {
          existing.episodes = [...(existing.episodes || []), ...newEps]
            .sort((a, b) => (a.season * 10000 + a.episode) - (b.season * 10000 + b.episode));
          existing.episodeCount = existing.episodes.length;
          existing.seasonCount  = new Set(existing.episodes.map(e => e.season)).size;
          existing.size         = existing.episodes.reduce((n, e) => n + (e.size || 0), 0);
          existing.sizeHuman    = existing.size > 1073741824
            ? (existing.size / 1073741824).toFixed(1) + ' GB'
            : (existing.size / 1048576).toFixed(0) + ' MB';
        }
      } else if (
        !existingTVIds.has(s.id) &&
        !existingTVPaths.has((s.path||'').toLowerCase())
      ) {
        // Genuinely new show
        newTV.push(s);
      }
    }

    if (newMovies.length || newTV.length) {
      state.library.push(...newMovies);
      state.tvShows.push(...newTV);
      applyFiltersAndSort();
      updateStats();
      saveLibrary();
      if (!silent) showToast(`Found ${newMovies.length} new movie${newMovies.length!==1?'s':''} and ${newTV.length} new show${newTV.length!==1?'s':''}`, 'success');
      else if (newMovies.length + newTV.length > 0) showToast(`${newMovies.length + newTV.length} new item${(newMovies.length+newTV.length)!==1?'s':''} added`, 'info');

      // Auto-fetch metadata for new items
      const toFetch = [...newMovies, ...newTV].filter(f =>
        !state.metadataFetched.has(f.id) && (state.settings.tmdbKey || state.settings.omdbKey)
      );
      if (toFetch.length && state.settings.autoFetch) {
        state.fetchQueue.push(...toFetch);
        processFetchQueue();
      }
    } else if (!silent) {
      const prunedMsg = (pruned.movies + pruned.shows) > 0
        ? ` (${pruned.movies + pruned.shows} deleted item${pruned.movies + pruned.shows !== 1 ? 's' : ''} removed)`
        : '';
      showToast(`Library is up to date${prunedMsg}`, 'info');
    }
  } catch (err) {
    if (!silent) showToast(`Rescan failed: ${err.message}`, 'error');
  }

  if (btn) { btn.classList.remove('scanning'); btn.querySelector('svg').style.animation = ''; }
  if (!silent) showProgress(false);
}

// ═══════════════════════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════════════════════

function addToWatchlist(tmdbId, mediaType, title, year, posterUrl, overview) {
  if (state.watchlist.find(w => String(w.tmdbId) === String(tmdbId))) {
    showToast(`"${title}" is already in My List`, 'info');
    return;
  }
  state.watchlist.push({
    tmdbId: String(tmdbId),
    mediaType,
    title,
    year:     year     || '',
    posterUrl: posterUrl || null,
    overview:  overview  || '',
    addedAt:   new Date().toISOString(),
    watched:   false,
    streamingProviders: null,
  });
  saveLibrary();
  updateWatchlistBadge(true); // flash the badge briefly for new item
  renderWatchlist();           // refresh the list immediately wherever it is
  showToast(`"${title}" added to My List`, 'success');
  // Check TV Guide for this new item immediately
  if (state.settings.tmdbKey) {
    refreshTVGuideForItem(String(tmdbId), mediaType);
  }
}

function removeFromWatchlist(tmdbId) {
  state.watchlist = state.watchlist.filter(w => String(w.tmdbId) !== String(tmdbId));
  // Remove any TV Guide entries for this item, unless they're from a local show
  // (local shows with watched episodes also populate TV Guide)
  const isLocalShow = state.tvShows.some(s => String(s.metadata?.tmdbId) === String(tmdbId));
  if (!isLocalShow) {
    const before = state.tvGuideNotifications.length;
    state.tvGuideNotifications = state.tvGuideNotifications
      .filter(n => String(n.tmdbId) !== String(tmdbId));
    if (state.tvGuideNotifications.length < before) {
      updateTVGuideBadge();
      if (state.currentView === 'tvguide') renderTVGuide();
    }
  }
  saveLibrary();
  updateWatchlistBadge();
  renderWatchlist();
}

function toggleWatchlistWatched(tmdbId) {
  const item = state.watchlist.find(w => String(w.tmdbId) === String(tmdbId));
  if (item) { item.watched = !item.watched; saveLibrary(); renderWatchlist(); }
}

function updateWatchlistBadge(forceShow = false) {
  const badge = document.getElementById('watchlist-badge');
  if (!badge) return;
  // Only show badge if user hasn't visited yet, OR if forceShow (new item just added)
  if (state.watchlistVisited && !forceShow) {
    badge.style.display = 'none';
    return;
  }
  const unwatched = state.watchlist.filter(w => !w.watched).length;
  if (unwatched > 0 && (!state.watchlistVisited || forceShow)) {
    badge.textContent = forceShow ? '+1' : String(unwatched);
    badge.style.display = 'inline-block';
    // Auto-hide the "+1" after 4 seconds
    if (forceShow) setTimeout(() => { badge.style.display = 'none'; }, 4000);
  } else {
    badge.style.display = 'none';
  }
}

function renderWatchlist() {
  const container = document.getElementById('watchlist-content');
  if (!container) return;

  const countEl = document.getElementById('watchlist-count');
  if (countEl) countEl.textContent = `${state.watchlist.length} item${state.watchlist.length!==1?'s':''}`;

  // Don't call updateWatchlistBadge here — would re-show badge after visit

  if (!state.watchlist.length) {
    container.innerHTML = `<div class="watchlist-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      <h2>Your list is empty</h2>
      <p>Search for movies and TV shows to add them here. Look for the "Add to My List" button on any title.</p>
    </div>`;
    return;
  }

  container.innerHTML = '';

  const wantToWatch = state.watchlist.filter(w => !w.watched);
  const watched     = state.watchlist.filter(w => w.watched);

  // ── New / Upcoming seasons section ───────────────────
  const newSeasonItems = state.watchlist.filter(w =>
    w.newSeasonInfo && !w.newSeasonInfo.dismissed
  );
  if (newSeasonItems.length) {
    const sec = document.createElement('div');
    const tvNew    = newSeasonItems.filter(w => w.mediaType === 'tv').length;
    const movieNew = newSeasonItems.filter(w => w.mediaType === 'movie').length;
    const sectionLabel = tvNew && movieNew ? 'New & Upcoming'
      : tvNew ? 'New & Upcoming Seasons'
      : 'New & Upcoming Releases';
    sec.innerHTML = `<div class="watchlist-section-title" style="color:#4cde8a;">🆕 ${sectionLabel} · ${newSeasonItems.length} title${newSeasonItems.length!==1?'s':''}</div>`;
    const grid = document.createElement('div');
    grid.className = 'watchlist-grid';
    newSeasonItems.forEach(item => grid.appendChild(buildWatchlistCard(item)));
    sec.appendChild(grid);
    container.appendChild(sec);
  }

  if (wantToWatch.length) {
    // Exclude items already shown in New Seasons section
    const newSeasonIds = new Set(newSeasonItems.map(w => w.tmdbId));
    const movies = wantToWatch.filter(w => w.mediaType === 'movie' && !newSeasonIds.has(w.tmdbId));
    const shows  = wantToWatch.filter(w => w.mediaType === 'tv'    && !newSeasonIds.has(w.tmdbId));

    function addWatchSection(items, label) {
      if (!items.length) return;
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="watchlist-section-title">${label} · ${items.length} title${items.length!==1?'s':''}</div>`;
      const grid = document.createElement('div');
      grid.className = 'watchlist-grid';
      items.forEach(item => grid.appendChild(buildWatchlistCard(item)));
      sec.appendChild(grid);
      container.appendChild(sec);
    }

    if (movies.length && shows.length) {
      addWatchSection(movies, 'Movies · Want to Watch');
      addWatchSection(shows, 'TV Shows · Want to Watch');
    } else if (movies.length) {
      addWatchSection(movies, 'Want to Watch');
    } else if (shows.length) {
      addWatchSection(shows, 'TV Shows · Want to Watch');
    }
  }

  if (watched.length) {
    const sec = document.createElement('div');
    const chevId = 'wl-watched-chev';
    sec.innerHTML = `<div class="watchlist-watched-toggle" id="wl-watched-toggle">
      <svg id="${chevId}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="transition:transform .16s"><polyline points="9 18 15 12 9 6"/></svg>
      Watched · ${watched.length} title${watched.length!==1?'s':''}
    </div>`;
    const grid = document.createElement('div');
    grid.className = 'watchlist-grid';
    grid.id = 'wl-watched-grid';
    grid.style.cssText = 'overflow:hidden;max-height:0;transition:max-height 0.25s ease;';
    watched.forEach(item => grid.appendChild(buildWatchlistCard(item)));
    sec.appendChild(grid);

    let open = false;
    sec.querySelector('#wl-watched-toggle').addEventListener('click', () => {
      open = !open;
      const chv = document.getElementById(chevId);
      if (chv) chv.style.transform = open ? 'rotate(90deg)' : '';
      grid.style.maxHeight = open ? `${watched.length * 140}px` : '0';
    });
    container.appendChild(sec);
  }
}

function buildWatchlistCard(item) {
  const card = document.createElement('div');
  card.className = `watchlist-card${item.watched ? ' watched-card' : ''}`;

  // Poster
  const posterEl = item.posterUrl
    ? `<img class="watchlist-poster" src="${item.posterUrl}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="watchlist-poster-ph"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20"/></svg></div>`;

  // Streaming badge
  const subs = state.settings.subscribedServices || [];
  const flatrate = item.streamingProviders?.flatrate || [];
  const myService = flatrate.find(p => subs.includes(p.providerId));
  const streamBadge = myService
    ? `<span style="font-size:10px;font-weight:700;color:#4cde8a;display:flex;align-items:center;gap:4px;">
        ${myService.logo ? `<img src="${myService.logo}" style="width:14px;height:14px;border-radius:3px;">` : ''}
        On ${esc(myService.name)}
      </span>`
    : `<span style="font-size:10px;color:var(--t2);">Not on your services</span>`;

  const typeLabel = item.mediaType === 'tv' ? 'TV Series' : 'Movie';

  // Episode progress for TV shows
  const epProgress = item.mediaType === 'tv' && item.watchedEpisodes
    ? Object.keys(item.watchedEpisodes).filter(k => item.watchedEpisodes[k]).length
    : 0;
  const epTotal = item.totalEpisodes || 0;
  const epProgressHtml = item.mediaType === 'tv' && epTotal > 0
    ? `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
        <div style="flex:1;height:3px;background:var(--bg-4);border-radius:2px;max-width:120px;">
          <div style="height:3px;border-radius:2px;background:#4cde8a;width:${Math.round(epProgress/epTotal*100)}%;transition:width .3s;"></div>
        </div>
        <span style="font-size:10px;color:var(--t2);">${epProgress}/${epTotal} watched</span>
      </div>`
    : '';

  const detailBtnLabel = item.mediaType === 'tv' ? 'Episodes' : 'View Details';

  card.innerHTML = `
    ${posterEl}
    <div class="watchlist-info">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--accent-soft);color:var(--text-accent);border:1px solid rgba(124,92,252,.2);">${typeLabel}</span>
        ${item.year ? `<span style="font-size:10px;color:var(--t2);font-family:'DM Mono',monospace;">${item.year}</span>` : ''}
        ${item.watched ? `<span style="font-size:10px;font-weight:700;color:#4cde8a;">✓ Watched</span>` : ''}
        ${item.newSeasonInfo && !item.newSeasonInfo.dismissed ? `<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(76,222,138,.15);color:#4cde8a;border:1px solid rgba(76,222,138,.3);">${item.newSeasonInfo.label}</span>` : ''}
      </div>
      <div class="watchlist-title">${esc(item.title)}</div>
      <div class="watchlist-overview">${esc(item.overview || 'No description available.')}</div>
      ${streamBadge}
      ${epProgressHtml}
      <div class="watchlist-actions">
        <button class="watchlist-btn" data-action="detail">${detailBtnLabel}</button>
        ${item.mediaType !== 'tv' ? `<button class="watchlist-btn${item.watched?' watched-btn':''}" data-action="watched">${item.watched ? '↩ Unmark' : '✓ Watched'}</button>` : ''}
        <button class="watchlist-btn" data-action="remove" style="color:var(--red);">Remove</button>
      </div>
    </div>`;

  // (No inline panel — TV shows open full overlay via openWatchlistTVOverlay)
  const epPanelWrap = null;

  card.querySelector('[data-action="detail"]').addEventListener('click', () => {
    if (item.mediaType === 'tv') {
      openWatchlistTVOverlay(item);
    } else {
      openTitleDetailPage(item.tmdbId, item.mediaType, item.title, item.posterUrl);
    }
  });
  if (card.querySelector('[data-action="watched"]')) {
    card.querySelector('[data-action="watched"]').addEventListener('click', () =>
      toggleWatchlistWatched(item.tmdbId));
  }
  card.querySelector('[data-action="remove"]').addEventListener('click', () =>
    removeFromWatchlist(item.tmdbId));

  return card;
}

async function checkWatchlistStreaming(showToastMsg = false) {
  if (!state.settings.tmdbKey || !state.watchlist.length) return;
  const country = state.settings.countryCode ||
    Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'US';
  let updated = 0;
  for (const item of state.watchlist) {
    try {
      const providers = await api.getWatchProviders(item.tmdbId, item.mediaType, country);
      if (providers.flatrate) {
        item.streamingProviders = providers;
        updated++;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100)); // gentle rate limit
  }
  saveLibrary();
  renderWatchlist();
  if (showToastMsg) showToast(`Streaming checked for ${updated} title${updated!==1?'s':''}`, 'info');
}

// Watchlist rendering is triggered by the nav click handler directly

// ═══════════════════════════════════════════════════════
// MY LIST SEARCH
// ═══════════════════════════════════════════════════════

let _wlSearchTimer = null;
let _wlSearchMode  = 'titles'; // 'titles' | 'people'
let _wlSearchInit  = false;

function initWatchlistSearch() {
  if (_wlSearchInit) return; // only bind once
  _wlSearchInit = true;

  // Mode toggle buttons
  document.querySelectorAll('.wl-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wl-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _wlSearchMode = btn.dataset.mode;
      // Re-run search if there's already a query
      const q = document.getElementById('wl-search-input')?.value.trim();
      if (q && q.length >= 2) wlTriggerDropdown(q);
    });
  });

  const input    = document.getElementById('wl-search-input');
  const dropdown = document.getElementById('wl-dropdown');
  if (!input) return;

  // 1-second delay → dropdown
  input.addEventListener('input', () => {
    clearTimeout(_wlSearchTimer);
    const q = input.value.trim();
    if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }
    _wlSearchTimer = setTimeout(() => wlTriggerDropdown(q), 1000);
  });

  // Enter key → full results page
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    clearTimeout(_wlSearchTimer);
    const q = input.value.trim();
    if (!q || q.length < 2) return;
    dropdown.style.display = 'none';
    if (!state.settings.tmdbKey) { showToast('TMDB API key required', 'info'); return; }
    wlShowFullResults(q);
  });

  // Escape closes dropdown
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dropdown.style.display = 'none'; input.blur(); }
  });

  // Click outside closes dropdown
  document.addEventListener('click', e => {
    if (!input.closest('.wl-search-input-wrap')?.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
}

async function wlTriggerDropdown(query) {
  if (!state.settings.tmdbKey) return;
  const dropdown = document.getElementById('wl-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--t2);">Searching…</div>`;
  dropdown.style.display = 'block';

  try {
    if (_wlSearchMode === 'people') {
      // Person search dropdown
      const resp = await api.tmdbGet(
      `/3/search/person?query=${encodeURIComponent(query)}&page=1`
    );
      const data = resp;
      const people = (data.results || []).filter(p => (p.known_for||[]).length > 0 || (p.popularity||0) >= 1).slice(0, 6);

      if (!people.length) {
        dropdown.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--t2);">No people found. Press Enter to search titles instead.</div>`;
        return;
      }

      dropdown.innerHTML = '';
      people.forEach(person => {
        const item = document.createElement('div');
        item.className = 'wl-drop-item';
        const knownFor = (person.known_for || []).slice(0,2).map(k => k.title || k.name).join(', ');
        const photoHtml = person.profile_path
          ? `<img class="wl-drop-person-ph" src="https://image.tmdb.org/t/p/w185${person.profile_path}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" loading="lazy">`
          : `<div class="wl-drop-person-ph"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`;
        item.innerHTML = `${photoHtml}<div style="flex:1;min-width:0;"><div class="wl-drop-title">${esc(person.name)}</div><div class="wl-drop-meta">${esc(person.known_for_department||'')}</div></div>
          <div style="font-size:10px;color:var(--t2);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(knownFor)}</div>`;
        item.addEventListener('click', () => {
          dropdown.style.display = 'none';
          // Open actor profile in actor view
          state.previousView = 'watchlist';
          openActorProfile(person.name);
        });
        dropdown.appendChild(item);
      });

    } else {
      // Title search dropdown
      const [mRes, tRes] = await Promise.all([
        api.tmdbGet(`/3/search/movie?query=${encodeURIComponent(query)}&page=1`),
        api.tmdbGet(`/3/search/tv?query=${encodeURIComponent(query)}&page=1`),
      ]);
      const results = [
        ...(mRes.results||[]).slice(0,4).map(r=>({...r,media_type:'movie'})),
        ...(tRes.results||[]).slice(0,4).map(r=>({...r,media_type:'tv'})),
      ].sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,6);

      if (!results.length) {
        dropdown.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--t2);">No results found.</div>`;
        return;
      }

      dropdown.innerHTML = '';
      results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'wl-drop-item';
        const poster = result.poster_path
          ? `<img class="wl-drop-thumb" src="https://image.tmdb.org/t/p/w92${result.poster_path}" loading="lazy">`
          : `<div class="wl-drop-thumb-ph"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/></svg></div>`;
        const title = result.title || result.name;
        const year  = (result.release_date || result.first_air_date || '').substring(0,4);
        const type  = result.media_type === 'tv' ? 'TV' : 'Movie';
        const inList = state.watchlist.find(w => String(w.tmdbId) === String(result.id));
        const inLib  = isInLocalLibrary(result.id, title);

        item.innerHTML = `${poster}
          <div style="flex:1;min-width:0;">
            <div class="wl-drop-title">${esc(title)}</div>
            <div class="wl-drop-meta">${year} · ${type}${inLib?' · In Library':''}</div>
          </div>
          <button class="wl-drop-add${inList?' added':''}">${inList?'✓ Added':'+ Add'}</button>`;

        // Click card body → open title detail within My List
        item.addEventListener('click', e => {
          if (e.target.classList.contains('wl-drop-add')) return;
          dropdown.style.display = 'none';
          wlOpenTitleDetail(result.id, result.media_type, title, result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null);
        });

        // Click Add button
        const addBtn = item.querySelector('.wl-drop-add');
        addBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (!state.watchlist.find(w => String(w.tmdbId) === String(result.id))) {
            const overview = result.overview || '';
            const posterUrl = result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null;
            addToWatchlist(result.id, result.media_type, title, year, posterUrl, overview);
            addBtn.textContent = '✓ Added';
            addBtn.classList.add('added');
          }
        });

        dropdown.appendChild(item);
      });
    }
  } catch (err) {
    dropdown.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--red);">Search error</div>`;
  }
}

async function wlShowFullResults(query) {
  if (!state.settings.tmdbKey) return;

  const content    = document.getElementById('watchlist-content');
  const fullRes    = document.getElementById('wl-full-results');
  if (!fullRes) return;

  // Hide list, show full results
  content.style.display = 'none';
  fullRes.style.display = 'block';
  fullRes.innerHTML = `<div style="display:flex;align-items:center;gap:12px;padding:4px 0;"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div><span style="font-size:13px;color:var(--t2);">Searching for "${esc(query)}"…</span></div>`;

  try {
    if (_wlSearchMode === 'people') {
      // People full results — open actor profile in actor view
      const resp = await api.tmdbGet(`/3/search/person?query=${encodeURIComponent(query)}&page=1`);
      const data = resp;
      const people = (data.results || []).slice(0, 8);
      if (!people.length) {
        fullRes.innerHTML = buildWlBackBtn() + `<div class="watchlist-empty"><h2>No people found for "${esc(query)}"</h2><p>Try switching to Titles search</p></div>`;
        attachWlBackBtn();
        return;
      }
      // Show person cards — click opens actor profile
      let html = buildWlBackBtn();
      html += `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t2);margin-bottom:14px;">${people.length} people found for "${esc(query)}"</div>`;
      html += `<div style="display:flex;flex-direction:column;gap:8px;max-width:600px;">`;
      people.forEach(p => {
        const photo = p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : null;
        const knownFor = (p.known_for||[]).slice(0,3).map(k=>k.title||k.name).filter(Boolean).join(', ');
        html += `<div class="wl-person-result" data-name="${esc(p.name)}" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-2);cursor:pointer;transition:background .16s,border-color .16s;">
          ${photo ? `<img src="${photo}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;">` : `<div style="width:44px;height:44px;border-radius:50%;background:var(--bg-4);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--t2);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`}
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;color:var(--accent);">${esc(p.name)}</div>
            <div style="font-size:11px;color:var(--t2);">${esc(p.known_for_department||'')}${knownFor?` · ${esc(knownFor)}`:''}</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--t2)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`;
      });
      html += `</div>`;
      fullRes.innerHTML = html;
      attachWlBackBtn();
      fullRes.querySelectorAll('.wl-person-result').forEach(el => {
        el.addEventListener('mouseenter', () => { el.style.background='var(--bg-3)'; el.style.borderColor='var(--border-mid)'; });
        el.addEventListener('mouseleave', () => { el.style.background='var(--bg-2)'; el.style.borderColor='var(--border)'; });
        el.addEventListener('click', () => {
          state.previousView = 'watchlist';
          openActorProfile(el.dataset.name);
          // Restore My List on back
        });
      });

    } else {
      // Title full results
      const [mRes, tRes] = await Promise.all([
        api.tmdbGet(`/3/search/movie?query=${encodeURIComponent(query)}&page=1`),
        api.tmdbGet(`/3/search/tv?query=${encodeURIComponent(query)}&page=1`),
      ]);
      const results = [
        ...(mRes.results||[]).slice(0,6).map(r=>({...r,media_type:'movie'})),
        ...(tRes.results||[]).slice(0,6).map(r=>({...r,media_type:'tv'})),
      ].sort((a,b)=>(b.popularity||0)-(a.popularity||0)).slice(0,10);

      if (!results.length) {
        fullRes.innerHTML = buildWlBackBtn() + `<div class="watchlist-empty"><h2>No results for "${esc(query)}"</h2></div>`;
        attachWlBackBtn();
        return;
      }

      let html = buildWlBackBtn();
      html += `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--t2);margin-bottom:14px;">${results.length} results for "${esc(query)}"</div>`;
      html += `<div style="display:flex;flex-direction:column;gap:10px;max-width:700px;">`;

      results.forEach(r => {
        const title   = r.title || r.name;
        const year    = (r.release_date || r.first_air_date || '').substring(0,4);
        const type    = r.media_type === 'tv' ? 'TV Series' : 'Movie';
        const poster  = r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null;
        const rating  = r.vote_average ? `★ ${r.vote_average.toFixed(1)}` : '';
        const inList  = state.watchlist.find(w => String(w.tmdbId) === String(r.id));
        const inLib   = isInLocalLibrary(r.id, title);
        const tmdbId  = r.id;
        const mediaType = r.media_type;

        html += `<div class="wl-full-result" data-id="${r.id}" data-type="${r.media_type}" style="display:flex;gap:14px;padding:14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-2);cursor:pointer;transition:background .16s,border-color .16s;">
          ${poster
            ? `<img src="${poster}" style="width:56px;height:84px;border-radius:6px;object-fit:cover;flex-shrink:0;" loading="lazy">`
            : `<div style="width:56px;height:84px;border-radius:6px;background:var(--bg-4);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--t2);"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="2" width="20" height="20" rx="2"/></svg></div>`}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
              <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--accent-soft);color:var(--text-accent);">${type}</span>
              ${year ? `<span style="font-size:10px;color:var(--t2);">${year}</span>` : ''}
              ${rating ? `<span style="font-size:10px;color:var(--t2);">${rating}</span>` : ''}
              ${inLib  ? `<span style="font-size:10px;font-weight:700;color:var(--green);">✓ In Library</span>` : ''}
            </div>
            <div style="font-size:14px;font-weight:700;color:var(--t0);margin-bottom:5px;">${esc(title)}</div>
            <div style="font-size:11px;color:var(--t1);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(r.overview||'')}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;justify-content:center;flex-shrink:0;">
            <button class="wl-drop-add wl-full-add${inList?' added':''}">${inList?'✓ In List':'+ My List'}</button>
          </div>
        </div>`;
      });
      html += `</div>`;
      fullRes.innerHTML = html;
      attachWlBackBtn();

      // Bind events
      fullRes.querySelectorAll('.wl-full-result').forEach(el => {
        el.addEventListener('mouseenter', () => { el.style.background='var(--bg-3)'; el.style.borderColor='var(--border-mid)'; });
        el.addEventListener('mouseleave', () => { el.style.background='var(--bg-2)'; el.style.borderColor='var(--border)'; });
        el.addEventListener('click', e => {
          if (e.target.classList.contains('wl-full-add') || e.target.closest('.wl-full-add')) return;
          const id   = el.dataset.id;
          const type = el.dataset.type;
          const result = results.find(r => String(r.id) === String(id));
          if (result) {
            const t = result.title || result.name;
            wlOpenTitleDetail(id, type, t, result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null);
          }
        });
        const addBtn = el.querySelector('.wl-full-add');
        if (addBtn) {
          addBtn.addEventListener('click', e => {
            e.stopPropagation();
            const id   = el.dataset.id;
            const type = el.dataset.type;
            const result = results.find(r => String(r.id) === String(id));
            if (result && !state.watchlist.find(w => String(w.tmdbId) === String(id))) {
              const t = result.title || result.name;
              const y = (result.release_date || result.first_air_date || '').substring(0,4);
              const p = result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null;
              addToWatchlist(id, type, t, y, p, result.overview||'');
              addBtn.textContent = '✓ In List';
              addBtn.classList.add('added');
            }
          });
        }
      });
    }
  } catch(err) {
    fullRes.innerHTML = buildWlBackBtn() + `<div class="watchlist-empty"><h2>Search failed</h2><p>${esc(err.message)}</p></div>`;
    attachWlBackBtn();
  }
}

function buildWlBackBtn() {
  // Use a unique ID so we can attach a proper event listener after inserting into DOM
  return `<button class="wl-results-back" id="wl-back-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back to My List</button>`;
}

function attachWlBackBtn() {
  const btn = document.getElementById('wl-back-btn');
  if (btn) btn.addEventListener('click', wlCloseFullResults);
}

function wlCloseFullResults() {
  const content = document.getElementById('watchlist-content');
  const fullRes = document.getElementById('wl-full-results');
  if (content) content.style.display = '';
  if (fullRes) { fullRes.style.display = 'none'; fullRes.innerHTML = ''; }
  const input = document.getElementById('wl-search-input');
  if (input) input.value = '';
}

async function wlOpenTitleDetail(tmdbId, mediaType, title, posterUrl) {
  // Open in titlesearch view then navigate back to watchlist
  state.previousView = 'watchlist';
  openTitleDetailPage(tmdbId, mediaType, title, posterUrl);
}

// ═══════════════════════════════════════════════════════
// WATCHLIST TV EPISODE BROWSER
// ═══════════════════════════════════════════════════════

const wlEpCache = {}; // tmdbId_season → episodes[]

async function toggleWatchlistEpisodes(item, panelWrap) {
  // Toggle expand/collapse
  if (panelWrap.style.maxHeight !== '0px' && panelWrap.style.maxHeight !== '') {
    panelWrap.style.maxHeight = '0';
    panelWrap.style.marginTop = '0';
    return;
  }

  // Show loading state
  panelWrap.style.background = 'var(--bg-1)';
  panelWrap.style.borderTop = '1px solid var(--border)';
  panelWrap.style.maxHeight = '60px';
  panelWrap.style.marginTop = '0';
  panelWrap.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--t2);display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div>Loading episodes…</div>`;

  // Fetch show details to get season count
  let showDetails = null;
  try {
    if (!item.showDetails && state.settings.tmdbKey) {
      const resp = await api.tmdbGet(`/3/tv/${item.tmdbId}`);
      showDetails = resp;
      item.showDetails = { seasons: showDetails.number_of_seasons, episodes: showDetails.number_of_episodes };
      item.totalEpisodes = showDetails.number_of_episodes;
      saveLibrary();
    }
  } catch {}

  const totalSeasons = item.showDetails?.seasons || 1;
  renderWatchlistEpisodePanel(item, panelWrap, totalSeasons, 1);
}

async function renderWatchlistEpisodePanel(item, panelWrap, totalSeasons, selectedSeason) {
  if (!item.watchedEpisodes) item.watchedEpisodes = {};

  // Fetch season data
  const cacheKey = `${item.tmdbId}_${selectedSeason}`;
  if (!wlEpCache[cacheKey] && state.settings.tmdbKey) {
    try {
      const resp = await api.tmdbGet(`/3/tv/${item.tmdbId}/season/${selectedSeason}`);
      const data = resp;
      // Only cache if episodes actually exist — don't cache empty future seasons
      if (data.episodes && data.episodes.length > 0) wlEpCache[cacheKey] = data.episodes;
    } catch {}
  }

  const episodes = wlEpCache[cacheKey] || [];
  const watchedInSeason = episodes.filter(e => item.watchedEpisodes[`${selectedSeason}-${e.episode_number}`]).length;
  const pct = episodes.length ? Math.round(watchedInSeason / episodes.length * 100) : 0;

  // Build panel HTML
  const inner = document.createElement('div');
  inner.style.cssText = 'padding:16px 20px;';

  // Season selector + progress + mark all
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;';

  // Season select
  const sel = document.createElement('select');
  sel.style.cssText = 'padding:6px 10px;background:var(--bg-3);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--t0);font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;outline:none;';
  for (let s = 1; s <= totalSeasons; s++) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Season ${s}`;
    if (s === selectedSeason) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => renderWatchlistEpisodePanel(item, panelWrap, totalSeasons, parseInt(sel.value)));
  header.appendChild(sel);

  // Progress bar
  const progWrap = document.createElement('div');
  progWrap.style.cssText = 'flex:1;height:4px;background:var(--bg-4);border-radius:2px;max-width:120px;';
  const progBar = document.createElement('div');
  progBar.style.cssText = `height:4px;border-radius:2px;background:#4cde8a;width:${pct}%;`;
  progWrap.appendChild(progBar);
  header.appendChild(progWrap);

  const progTxt = document.createElement('span');
  progTxt.style.cssText = 'font-size:11px;color:var(--t2);white-space:nowrap;';
  progTxt.textContent = `${watchedInSeason}/${episodes.length} watched`;
  header.appendChild(progTxt);

  // Mark season button
  const allWatched = episodes.length > 0 && episodes.every(e => item.watchedEpisodes[`${selectedSeason}-${e.episode_number}`]);
  const markBtn = document.createElement('button');
  markBtn.style.cssText = 'padding:5px 10px;background:var(--bg-3);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--t2);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;';
  markBtn.textContent = allWatched ? 'Unmark season' : 'Mark season watched';
  markBtn.addEventListener('click', () => {
    episodes.forEach(e => {
      const key = `${selectedSeason}-${e.episode_number}`;
      item.watchedEpisodes[key] = !allWatched;
    });
    saveLibrary();
    renderWatchlistEpisodePanel(item, panelWrap, totalSeasons, selectedSeason);
  });
  header.appendChild(markBtn);
  inner.appendChild(header);

  // Episode list
  if (!episodes.length) {
    inner.innerHTML += `<div style="font-size:12px;color:var(--t2);padding:8px 0;">No episode data available.</div>`;
  } else {
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    episodes.forEach(ep => {
      const epKey = `${selectedSeason}-${ep.episode_number}`;
      const watched = !!item.watchedEpisodes[epKey];

      const epCard = document.createElement('div');
      epCard.style.cssText = `display:flex;gap:10px;padding:8px;border-radius:var(--radius-sm);border:1px solid ${watched?'#27500a':'var(--border)'};background:${watched?'rgba(13,31,13,.7)':'var(--bg-2)'};align-items:flex-start;transition:all .16s;`;

      // Still image
      const still = document.createElement('div');
      still.style.cssText = 'width:96px;height:54px;border-radius:5px;overflow:hidden;background:var(--bg-4);flex-shrink:0;position:relative;';
      if (ep.still_path) {
        const img = document.createElement('img');
        img.src = `https://image.tmdb.org/t/p/w300${ep.still_path}`;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        if (watched) img.style.opacity = '0.45';
        img.onerror = () => img.remove();
        still.appendChild(img);
      }
      if (watched) {
        const chk = document.createElement('div');
        chk.style.cssText = 'position:absolute;top:3px;right:3px;width:16px;height:16px;border-radius:50%;background:#1a4a1a;border:1.5px solid #4cde8a;display:flex;align-items:center;justify-content:center;';
        chk.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#4cde8a" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        still.appendChild(chk);
      }
      epCard.appendChild(still);

      // Info
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const airDate = ep.air_date ? new Date(ep.air_date).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'numeric'}) : '';
      info.innerHTML = `
        <div style="display:flex;align-items:baseline;gap:7px;margin-bottom:3px;">
          <span style="font-size:10px;font-weight:700;color:${watched?'#3B6D11':'var(--t2)'};font-family:'DM Mono',monospace;flex-shrink:0;">E${String(ep.episode_number).padStart(2,'0')}</span>
          <span style="font-size:12px;font-weight:600;color:${watched?'#97C459':'var(--t0)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(ep.name||'')}</span>
        </div>
        ${ep.overview ? `<p style="font-size:10px;color:var(--t1);line-height:1.5;margin-bottom:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${esc(ep.overview)}</p>` : ''}
        <span style="font-size:10px;color:${watched?'#3B6D11':'var(--t2)'};font-family:'DM Mono',monospace;">${ep.runtime?ep.runtime+'m · ':''}${airDate}</span>`;

      epCard.appendChild(info);

      // Watch toggle button
      const wBtn = document.createElement('button');
      wBtn.style.cssText = `width:26px;height:26px;border-radius:50%;flex-shrink:0;align-self:center;background:${watched?'#1a4a1a':'var(--bg-3)'};border:1.5px solid ${watched?'#4cde8a':'var(--border-mid)'};display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .16s;`;
      wBtn.title = watched ? 'Mark unwatched' : 'Mark watched';
      wBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="${watched?'#4cde8a':'var(--t2)'}" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      wBtn.addEventListener('click', () => {
        item.watchedEpisodes[epKey] = !item.watchedEpisodes[epKey];
        saveLibrary();
        renderWatchlistEpisodePanel(item, panelWrap, totalSeasons, selectedSeason);
      });
      epCard.appendChild(wBtn);

      list.appendChild(epCard);
    });
    inner.appendChild(list);
  }

  panelWrap.innerHTML = '';
  panelWrap.appendChild(inner);
  panelWrap.style.maxHeight = `${Math.max(episodes.length * 82 + 80, 100)}px`;
  panelWrap.style.marginTop = '0';
}

// ═══════════════════════════════════════════════════════
// BACKUP — Export / Import
// ═══════════════════════════════════════════════════════

async function exportWatchlist() {
  if (!state.watchlist.length) {
    showToast('My List is empty — nothing to export', 'info');
    return;
  }
  const data = {
    _type: 'mediavault-watchlist',
    _version: 1,
    _exported: new Date().toISOString(),
    items: state.watchlist,
  };
  const date = new Date().toISOString().slice(0,10);
  const result = await api.saveFile({
    defaultName: `mediavault-mylist-${date}.json`,
    content: JSON.stringify(data, null, 2),
  });
  if (result.ok) showToast('My List exported successfully', 'success');
  else if (result.error) showToast(`Export failed: ${result.error}`, 'error');
}

async function importWatchlist() {
  const result = await api.readFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!result.ok) return;
  try {
    const data = JSON.parse(result.content);
    if (data._type !== 'mediavault-watchlist' || !Array.isArray(data.items)) {
      showToast('Invalid file — not a MediaVault watchlist export', 'error');
      return;
    }
    let added = 0, skipped = 0;
    for (const item of data.items) {
      if (!item.tmdbId) continue;
      const exists = state.watchlist.find(w => String(w.tmdbId) === String(item.tmdbId));
      if (exists) {
        // Merge watched states but don't overwrite existing item
        if (item.watchedEpisodes) Object.assign(exists.watchedEpisodes || (exists.watchedEpisodes={}), item.watchedEpisodes);
        skipped++;
      } else {
        state.watchlist.push(item);
        added++;
      }
    }
    saveLibrary();
    renderWatchlist();
    updateWatchlistBadge();
    showToast(`Imported ${added} new item${added!==1?'s':''}, ${skipped} already existed`, 'success');
  } catch (e) {
    showToast(`Import failed: ${e.message}`, 'error');
  }
}

async function exportTVProgress() {
  const showsWithProgress = state.tvShows.filter(s =>
    s.episodes && s.episodes.some(e => e.watched)
  );
  if (!showsWithProgress.length) {
    showToast('No TV show progress to export yet', 'info');
    return;
  }
  const data = {
    _type: 'mediavault-tv-progress',
    _version: 1,
    _exported: new Date().toISOString(),
    shows: showsWithProgress.map(s => ({
      title: s.displayTitle || s.title,
      tmdbId: s.metadata?.tmdbId || null,
      // Store watched as { "season_episode": true } map
      watchedEpisodes: Object.fromEntries(
        s.episodes
          .filter(e => e.watched)
          .map(e => [`${e.season}-${e.episode}`, true])
      ),
    })).filter(s => Object.keys(s.watchedEpisodes).length > 0),
  };
  const date = new Date().toISOString().slice(0,10);
  const result = await api.saveFile({
    defaultName: `mediavault-tv-progress-${date}.json`,
    content: JSON.stringify(data, null, 2),
  });
  if (result.ok) showToast(`TV progress exported for ${data.shows.length} show${data.shows.length!==1?'s':''}`, 'success');
  else if (result.error) showToast(`Export failed: ${result.error}`, 'error');
}

async function importTVProgress() {
  const result = await api.readFile({ filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!result.ok) return;
  try {
    const data = JSON.parse(result.content);
    if (data._type !== 'mediavault-tv-progress' || !Array.isArray(data.shows)) {
      showToast('Invalid file — not a MediaVault TV progress export', 'error');
      return;
    }
    let restored = 0, unmatched = 0;
    for (const saved of data.shows) {
      // Match by tmdbId first, fall back to title
      const show = state.tvShows.find(s =>
        (saved.tmdbId && String(s.metadata?.tmdbId) === String(saved.tmdbId)) ||
        (s.displayTitle || s.title || '').toLowerCase() === (saved.title || '').toLowerCase()
      );
      if (!show) { unmatched++; continue; }
      // Restore watched states on episodes
      for (const ep of (show.episodes || [])) {
        const key = `${ep.season}-${ep.episode}`;
        if (saved.watchedEpisodes[key]) ep.watched = true;
      }
      restored++;
    }
    saveLibrary();
    applyFiltersAndSort();
    showToast(`Progress restored for ${restored} show${restored!==1?'s':''}${unmatched?`, ${unmatched} not found in library`:''}`, 'success');
  } catch (e) {
    showToast(`Import failed: ${e.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════
// WATCHLIST TV SHOW — open in full cinematic overlay
// ═══════════════════════════════════════════════════════

async function openWatchlistTVOverlay(wlItem) {
  if (!state.settings.tmdbKey) {
    showToast('TMDB API key required to view episodes', 'info');
    return;
  }

  // Show overlay immediately with a loading state
  const overlay = document.getElementById('cinematic-overlay');
  const inner   = document.getElementById('cinematic-inner');
  if (!overlay || !inner) return;
  document.querySelectorAll('.cin-floating-toolbar').forEach(el => el.remove());
  overlay.style.setProperty('display', 'block', 'important');
  inner.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:14px;color:rgba(255,255,255,.6);font-size:14px;"><div class="spinner"></div>Loading…</div>`;

  // Fetch full show metadata from TMDB
  let meta = {};
  try {
    const [detail, credResp] = await Promise.all([
      api.tmdbGet(`/3/tv/${wlItem.tmdbId}?append_to_response=credits,content_ratings`),
      api.tmdbGet(`/3/tv/${wlItem.tmdbId}/credits`),
    ]);
    meta = {
      tmdbId:      String(wlItem.tmdbId),
      title:       detail.name || wlItem.title,
      year:        (detail.first_air_date || '').substring(0, 4),
      overview:    detail.overview || wlItem.overview || '',
      genres:      (detail.genres || []).map(g => g.name),
      tmdbRating:  detail.vote_average ? detail.vote_average.toFixed(1) : null,
      backdropPath: detail.backdrop_path || null,
      posterUrl:   detail.poster_path ? `https://image.tmdb.org/t/p/w500${detail.poster_path}` : wlItem.posterUrl,
      status:      detail.status || '',
      castFull:    (detail.credits?.cast || []).slice(0, 20).map(c => ({ name: c.name, character: c.character, profilePath: c.profile_path })),
      crewFull:    (detail.credits?.crew || []).filter(c => ['Director','Creator','Executive Producer'].includes(c.job)).slice(0, 8).map(c => ({ name: c.name, job: c.job })),
      streamingProviders: wlItem.streamingProviders || null,
      seasons:     detail.number_of_seasons || 1,
    };
    // Store show details back on watchlist item
    wlItem.showDetails = { seasons: detail.number_of_seasons, episodes: detail.number_of_episodes };
    wlItem.totalEpisodes = detail.number_of_episodes;
    saveLibrary();
  } catch (e) {
    // Fall back to what we have
    meta = {
      tmdbId: String(wlItem.tmdbId),
      title: wlItem.title,
      overview: wlItem.overview || '',
      posterUrl: wlItem.posterUrl,
      backdropPath: null,
    };
  }

  // Build a synthetic item that looks like a local TV show
  // We use the watchlist item's watchedEpisodes map for watched state
  const syntheticItem = {
    id:           `wl_${wlItem.tmdbId}`,
    type:         'tv',
    title:        meta.title || wlItem.title,
    displayTitle: meta.title || wlItem.title,
    posterPath:   null, // no local poster path
    path:         null,
    episodes:     [],   // empty — episode browser fetches from TMDB
    episodeCount: wlItem.totalEpisodes || 0,
    seasonCount:  meta.seasons || wlItem.showDetails?.seasons || 1,
    metadata:     meta,
    _isWatchlistItem: true,
    _wlRef:       wlItem, // keep reference to update watched state
  };

  // Determine detail mode
  const mode = state.settings.tvDetailView || 'frosted';

  // Override closeDetailedOverlay for this overlay to return to My List
  const origClose = closeDetailedOverlay;
  const wlClose = () => {
    overlay.style.setProperty('display', 'none', 'important');
    state.activeItem = null;
    // Re-render watchlist to reflect any watched changes
    renderWatchlist();
    // Navigate back to My List
    switchView('watchlist');
  };

  // Patch the close button temporarily
  state._wlOverlayClose = wlClose;
  state.activeItem = syntheticItem;
  renderCinematicOverlayWL(syntheticItem, mode, wlItem, wlClose);
}

function renderCinematicOverlayWL(item, mode, wlItem, closeOverlay) {
  const overlay = document.getElementById('cinematic-overlay');
  const inner   = document.getElementById('cinematic-inner');
  const m = item.metadata || {};

  const hasBackdrop = !!m.backdropPath;
  const effectiveMode = (mode === 'cinematic' && !hasBackdrop) ? 'frosted' : (mode || 'frosted');

  const backdropUrl = m.backdropPath
    ? `https://image.tmdb.org/t/p/original${m.backdropPath}`
    : (m.posterUrl || null);

  inner.style.cssText = 'min-height:100vh;position:relative;background:#0a0a0f;';
  inner.innerHTML = '';

  // Use Style A (Frosted) as base — clearest for long episode lists
  // but swap in the WL-aware episode browser
  renderWLCinematicContent(inner, item, m, backdropUrl, effectiveMode, wlItem, closeOverlay);
}

function renderWLCinematicContent(inner, item, m, backdropUrl, mode, wlItem, closeOverlay) {
  // Background
  inner.appendChild(cinBackdropLayer(backdropUrl,
    'linear-gradient(to right, rgba(5,5,15,.97) 0%, rgba(5,5,15,.8) 50%, rgba(5,5,15,.35) 100%)'));

  // Floating toolbar (no hide/remap since not a local item — just Close)
  const overlay = document.getElementById('cinematic-overlay');
  const toolbarWrap = document.createElement('div');
  toolbarWrap.className = 'cin-floating-toolbar';
  toolbarWrap.style.cssText = 'position:fixed;top:20px;right:20px;z-index:100;';
  const closeBtn2 = document.createElement('button');
  closeBtn2.style.cssText = 'display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);';
  closeBtn2.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close`;
  closeBtn2.addEventListener('click', closeOverlay);
  toolbarWrap.appendChild(closeBtn2);
  overlay.appendChild(toolbarWrap);

  const content = document.createElement('div');
  content.style.cssText = 'position:relative;z-index:2;max-width:1100px;margin:0 auto;padding:40px 48px 60px;min-height:100vh;display:flex;flex-direction:column;';
  inner.appendChild(content);

  // Hero
  const hero = document.createElement('div');
  hero.style.cssText = 'display:flex;gap:32px;align-items:flex-start;margin-bottom:28px;';
  if (m.posterUrl) {
    const p = document.createElement('img');
    p.src = m.posterUrl;
    p.style.cssText = 'width:160px;height:240px;border-radius:10px;object-fit:cover;flex-shrink:0;box-shadow:0 12px 40px rgba(0,0,0,.7);border:1px solid rgba(255,255,255,.1);';
    hero.appendChild(p);
  }

  const heroInfo = document.createElement('div');
  heroInfo.style.cssText = 'flex:1;min-width:0;';
  heroInfo.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${cinBadges(item, m)}</div>
    <h1 style="font-size:38px;font-weight:900;letter-spacing:-.02em;color:#fff;line-height:1.05;margin-bottom:14px;text-shadow:0 2px 8px rgba(0,0,0,.6);">${esc(item.displayTitle || item.title)}</h1>
    <div style="display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-bottom:14px;">${cinRating(m)}${cinStreamingPill(m)}</div>`;

  const synCard = document.createElement('div');
  synCard.style.cssText = 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:16px 18px;margin-top:12px;max-width:600px;';
  synCard.innerHTML = `<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4);margin-bottom:8px;">Synopsis</div><p style="font-size:13px;color:rgba(255,255,255,.85);line-height:1.75;margin:0;">${esc(m.overview || 'No description available.')}</p>`;
  heroInfo.appendChild(synCard);
  hero.appendChild(heroInfo);
  content.appendChild(hero);

  // Action row — just Close (no Play/Show in Folder for watchlist items)
  const actRow = document.createElement('div');
  actRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px;align-items:center;';
  const closeActBtn = document.createElement('button');
  closeActBtn.style.cssText = 'display:inline-flex;align-items:center;gap:7px;padding:11px 22px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.15);';
  closeActBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Back to My List`;
  closeActBtn.addEventListener('click', closeOverlay);
  actRow.appendChild(closeActBtn);
  content.appendChild(actRow);

  // Episode browser — WL-aware version
  const epSection = document.createElement('div');
  epSection.style.cssText = 'margin-bottom:32px;';
  const epLabel = document.createElement('h2');
  epLabel.style.cssText = 'font-size:18px;font-weight:700;color:#fff;margin-bottom:14px;';
  epLabel.textContent = 'Episodes';
  epSection.appendChild(epLabel);

  const epContainer = document.createElement('div');
  epSection.appendChild(epContainer);
  content.appendChild(epSection);

  // Render episode panel using WL watched state
  const totalSeasons = item.seasonCount || 1;
  renderWLEpisodePanel(wlItem, epContainer, totalSeasons, 1);

  // Cast section
  const cs = cinCastSection(item, m);
  if (cs) content.appendChild(cs);

  // File info — adapted for watchlist (no local file)
  const infoWrap = document.createElement('div');
  infoWrap.style.cssText = 'margin-top:28px;border-top:1px solid rgba(255,255,255,.08);padding-top:16px;';
  const infoTog = document.createElement('button');
  infoTog.style.cssText = 'display:flex;align-items:center;gap:7px;background:none;border:none;color:rgba(255,255,255,.45);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;font-family:inherit;padding:0;';
  infoTog.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="transition:transform .16s" id="wl-finfo-chv"><polyline points="9 18 15 12 9 6"/></svg>Show Info`;
  const infoDetails = document.createElement('div');
  infoDetails.style.cssText = 'overflow:hidden;max-height:0;transition:max-height 0.25s ease;';
  const rows = [
    ['Status',   m.status || '—'],
    ['Seasons',  String(item.seasonCount || '—')],
    ['Episodes', String(item.episodeCount || '—')],
    ['TMDB ID',  String(m.tmdbId || wlItem.tmdbId || '—')],
    ['Added',    wlItem.addedAt ? new Date(wlItem.addedAt).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'numeric'}) : '—'],
  ];
  const table = document.createElement('div');
  table.style.cssText = 'padding:12px 0;display:flex;flex-direction:column;gap:6px;';
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;font-size:12px;';
    row.innerHTML = `<span style="color:rgba(255,255,255,.4);font-weight:600;min-width:80px;flex-shrink:0;">${esc(label)}</span><span style="color:rgba(255,255,255,.75);font-family:'DM Mono',monospace;">${esc(value)}</span>`;
    table.appendChild(row);
  });
  infoDetails.appendChild(table);
  let infoOpen = false;
  infoTog.addEventListener('click', () => {
    infoOpen = !infoOpen;
    const chv = document.getElementById('wl-finfo-chv');
    if (chv) chv.style.transform = infoOpen ? 'rotate(90deg)' : '';
    infoDetails.style.maxHeight = infoOpen ? `${rows.length * 32 + 24}px` : '0';
  });
  infoWrap.appendChild(infoTog);
  infoWrap.appendChild(infoDetails);
  content.appendChild(infoWrap);

  // Esc key
  const escH = e => { if (e.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', escH); } };
  document.addEventListener('keydown', escH);
}

let _wlEpRenderSeq = 0;

function renderWLEpisodePanel(wlItem, container, totalSeasons, startSeason) {
  if (!wlItem.watchedEpisodes) wlItem.watchedEpisodes = {};

  // Build stable shell — selector + progress bar stay in DOM, only episode list swaps
  container.innerHTML = '';

  // ── Header row (never rebuilt on season change) ─────────
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;';

  const sel = document.createElement('select');
  sel.style.cssText = 'padding:7px 12px;background:#1a0a2e;border:1px solid rgba(255,255,255,.25);border-radius:var(--radius-sm);color:#fff;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;outline:none;';
  for (let s = 1; s <= totalSeasons; s++) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `Season ${s}`;
    opt.style.cssText = 'background:#1a0a2e;color:#fff;';
    if (s === startSeason) opt.selected = true;
    sel.appendChild(opt);
  }
  header.appendChild(sel);

  const progWrap = document.createElement('div');
  progWrap.style.cssText = 'flex:1;height:4px;background:rgba(255,255,255,.1);border-radius:2px;max-width:140px;';
  const progBar = document.createElement('div');
  progBar.style.cssText = 'height:4px;border-radius:2px;background:#4cde8a;width:0%;transition:width .3s;';
  progWrap.appendChild(progBar);
  header.appendChild(progWrap);

  const progTxt = document.createElement('span');
  progTxt.style.cssText = 'font-size:11px;color:rgba(255,255,255,.5);white-space:nowrap;';
  progTxt.textContent = '…';
  header.appendChild(progTxt);

  const markBtn = document.createElement('button');
  markBtn.style.cssText = 'padding:6px 12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:var(--radius-sm);color:rgba(255,255,255,.7);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:all .16s;';
  markBtn.textContent = 'Mark season watched';
  markBtn.addEventListener('mouseenter', () => { markBtn.style.background='rgba(255,255,255,.15)'; markBtn.style.color='#fff'; });
  markBtn.addEventListener('mouseleave', () => { markBtn.style.background='rgba(255,255,255,.08)'; markBtn.style.color='rgba(255,255,255,.7)'; });
  header.appendChild(markBtn);

  container.appendChild(header);

  // ── Episode list area (this is the ONLY thing that changes on season switch) ─
  const epList = document.createElement('div');
  epList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  container.appendChild(epList);

  // ── Load and render a season ─────────────────────────────
  let currentSeason = startSeason;
  let loading = false;

  async function loadSeason(seasonNum) {
    if (loading) return;
    loading = true;
    currentSeason = seasonNum;

    const cacheKey = `${wlItem.tmdbId}_${seasonNum}`;

    if (!wlEpCache[cacheKey]) {
      epList.innerHTML = `<div style="padding:8px 0;font-size:12px;color:rgba(255,255,255,.4);display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:14px;height:14px;border-width:2px;border-color:rgba(255,255,255,.2);border-top-color:rgba(255,255,255,.6);"></div>Loading episodes…</div>`;

      if (state.settings.tmdbKey) {
        try {
          const resp = await api.tmdbGet(`/3/tv/${wlItem.tmdbId}/season/${seasonNum}`);
          const data = resp;
          if (data.episodes && data.episodes.length > 0) {
            wlEpCache[cacheKey] = data.episodes;
          }
        } catch {}
      }
    }

    // If user switched season while fetching, bail — the new loadSeason call handles it
    if (currentSeason !== seasonNum) { loading = false; return; }

    const episodes = wlEpCache[cacheKey] || [];
    const watchedCount = episodes.filter(e => wlItem.watchedEpisodes[`${seasonNum}-${e.episode_number}`]).length;
    const pct = episodes.length ? Math.round(watchedCount / episodes.length * 100) : 0;
    const allWatched = episodes.length > 0 && watchedCount === episodes.length;

    // Update progress bar + mark button
    progBar.style.width = pct + '%';
    progTxt.textContent = episodes.length ? `${watchedCount}/${episodes.length} watched` : '';
    markBtn.textContent = allWatched ? 'Unmark season' : 'Mark season watched';

    // Replace only the episode list
    epList.innerHTML = '';

    if (!episodes.length) {
      epList.innerHTML = `<div style="font-size:13px;color:rgba(255,255,255,.45);padding:12px 0;">📅 No episodes available yet — this season may not have aired.</div>`;
      loading = false;
      return;
    }

    // Mark-season button handler (needs current episodes in scope)
    markBtn.onclick = () => {
      episodes.forEach(e => {
        wlItem.watchedEpisodes[`${seasonNum}-${e.episode_number}`] = !allWatched;
      });
      saveLibrary();
      loadSeason(seasonNum); // re-render this season
    };

    episodes.forEach(ep => {
      const epKey = `${seasonNum}-${ep.episode_number}`;
      const watched = !!wlItem.watchedEpisodes[epKey];
      const synEp = {
        episode: ep.episode_number, season: seasonNum,
        filename: ep.name || '', path: null,
        sizeHuman: ep.runtime ? `${ep.runtime}m` : '',
        watched,
      };
      const card = buildEpisodeCard(synEp, ep, () => {
        wlItem.watchedEpisodes[epKey] = synEp.watched;
        const newWatched = episodes.filter(e => wlItem.watchedEpisodes[`${seasonNum}-${e.episode_number}`]).length;
        progBar.style.width = Math.round(newWatched / episodes.length * 100) + '%';
        progTxt.textContent = `${newWatched}/${episodes.length} watched`;
        markBtn.textContent = newWatched === episodes.length ? 'Unmark season' : 'Mark season watched';
        saveLibrary();
      });
      epList.appendChild(card);
    });

    loading = false;
  }

  // Season selector drives loadSeason
  sel.addEventListener('change', () => {
    loading = false; // allow interruption
    loadSeason(parseInt(sel.value));
  });

  // Initial load
  loadSeason(startSeason);
}


// ═══════════════════════════════════════════════════════
// PRUNE DELETED FILES
// ═══════════════════════════════════════════════════════

async function pruneDeletedFiles(silent = false) {
  const result = { movies: 0, shows: 0, episodes: 0 };
  try {
    const { missingMovieIds, missingTVIds, missingEpisodes } = await api.checkFilesExist({
      movies: state.library,
      tvShows: state.tvShows,
    });

    // Remove entire missing movies
    if (missingMovieIds.length) {
      state.library = state.library.filter(f => !missingMovieIds.includes(f.id));
      result.movies = missingMovieIds.length;
    }

    // Remove entire missing shows
    if (missingTVIds.length) {
      state.tvShows = state.tvShows.filter(s => !missingTVIds.includes(s.id));
      result.shows  = missingTVIds.length;
    }

    // Prune individual missing episodes from partially-deleted shows
    if (missingEpisodes && Object.keys(missingEpisodes).length) {
      for (const [showId, missingPaths] of Object.entries(missingEpisodes)) {
        const show = state.tvShows.find(s => s.id === showId);
        if (!show) continue;
        const missingSet = new Set(missingPaths);
        const before = show.episodes.length;
        show.episodes = show.episodes.filter(e => !missingSet.has(e.path));
        const removed = before - show.episodes.length;
        if (removed > 0) {
          result.episodes += removed;
          // Recalculate counts
          show.episodeCount = show.episodes.length;
          const seasons = new Set(show.episodes.map(e => e.season));
          show.seasonCount = seasons.size;
        }
      }
    }

    const totalChanged = result.movies + result.shows + result.episodes;
    if (totalChanged > 0) {
      applyFiltersAndSort();
      updateStats();
      saveLibrary();

      if (!silent) {
        const parts = [];
        if (result.movies)   parts.push(`${result.movies} movie${result.movies !== 1 ? 's' : ''}`);
        if (result.shows)    parts.push(`${result.shows} show${result.shows !== 1 ? 's' : ''}`);
        if (result.episodes) parts.push(`${result.episodes} episode${result.episodes !== 1 ? 's' : ''}`);
        showToast(`Removed ${parts.join(', ')} from library`, 'info');
      }
    }
  } catch (e) {
    console.warn('[pruneDeletedFiles]', e);
  }
  return result;
}

// ═══════════════════════════════════════════════════════
// NEW SEASON DETECTION
// ═══════════════════════════════════════════════════════

async function checkWatchlistNewSeasons(notify = false) {
  if (!state.settings.tmdbKey) return;
  const items = state.watchlist.filter(w => w.mediaType === 'tv' || w.mediaType === 'movie');
  if (!items.length) return;

  const now      = new Date();
  const past90   = new Date(now); past90.setDate(now.getDate() - 90);
  const future90 = new Date(now); future90.setDate(now.getDate() + 90);

  let newCount = 0;
  let changed  = false;

  for (const item of items) {
    try {
      let airDate = null;
      let label   = '';
      let isNew   = false;
      let isUpcoming = false;
      let seasonNum  = null;

      if (item.mediaType === 'tv') {
        // ── TV: check for new/upcoming season ──────────────
        const resp = await api.tmdbGet(
      `/3/tv/${item.tmdbId}`
    );
        if (!resp || resp.error) { await new Promise(r => setTimeout(r, 150)); continue; }
        const data = resp;
        const seasons = (data.seasons || []).filter(s => s.season_number > 0);
        if (!seasons.length) { await new Promise(r => setTimeout(r, 150)); continue; }
        const latest = seasons[seasons.length - 1];
        airDate   = latest.air_date ? new Date(latest.air_date) : null;
        seasonNum = latest.season_number;
        if (!airDate) { await new Promise(r => setTimeout(r, 150)); continue; }
        isNew      = airDate >= past90 && airDate <= now;
        isUpcoming = airDate > now     && airDate <= future90;
        if (isNew || isUpcoming) {
          const dateStr = airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
          label = isNew
            ? `🆕 S${seasonNum} — aired ${dateStr}`
            : `📅 S${seasonNum} — ${dateStr}`;
        }
      } else {
        // ── Movie: check theatrical + streaming/digital release dates ──
        const country = (state.settings.countryCode || 'US').toUpperCase();
        const [baseData, datesData] = await Promise.all([
          api.tmdbGet(`/3/movie/${item.tmdbId}`),
          api.tmdbGet(`/3/movie/${item.tmdbId}/release_dates`),
        ]);
        if (!baseData || baseData.error) { await new Promise(r => setTimeout(r, 150)); continue; }

        // Collect theatrical + digital (4) + streaming/TV (6) dates
        const candidates = [];
        if (baseData.release_date) candidates.push(new Date(baseData.release_date));
        if (datesData?.results) {
          const regions = [country, 'US'];
          for (const region of regions) {
            const entry = datesData.results.find(r => r.iso_3166_1 === region);
            if (!entry) continue;
            for (const rel of (entry.release_dates || [])) {
              if ([3, 4, 6].includes(rel.type) && rel.release_date) {
                candidates.push(new Date(rel.release_date));
              }
            }
          }
        }

        // Use the most recent in-window date
        const inWindow = candidates.filter(d =>
          (d >= past90 && d <= now) || (d > now && d <= future90)
        );
        if (!inWindow.length) { await new Promise(r => setTimeout(r, 150)); continue; }

        const pastDates   = inWindow.filter(d => d <= now).sort((a,b) => b - a);
        const futureDates = inWindow.filter(d => d > now).sort((a,b) => a - b);
        airDate    = pastDates[0] || futureDates[0];
        isNew      = airDate >= past90 && airDate <= now;
        isUpcoming = airDate > now && airDate <= future90;
        if (isNew || isUpcoming) {
          const dateStr = airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
          label = isNew ? `🆕 Available ${dateStr}` : `📅 Available ${dateStr}`;
        }
      }

      if (isNew || isUpcoming) {
        const prev = item.newSeasonInfo;
        const prevKey = item.mediaType === 'tv' ? prev?.season : prev?.airDate;
        const curKey  = item.mediaType === 'tv' ? seasonNum    : airDate?.toISOString().split('T')[0];
        // Re-flag if: no previous flag, different season, or was dismissed on old season
        if (!prev || prevKey !== curKey || (prev.dismissed && prevKey === curKey)) {
          item.newSeasonInfo = {
            season:    seasonNum,
            airDate:   airDate?.toISOString().split('T')[0],
            label,
            isNew,
            isUpcoming,
            dismissed: false,
          };
          if (item.watched) item.watched = false;
          newCount++;
          changed = true;
        }
      } else {
        if (item.newSeasonInfo && !item.newSeasonInfo.dismissed) {
          item.newSeasonInfo = null;
          changed = true;
        }
      }

      await new Promise(r => setTimeout(r, 150));
    } catch {}
  }

  if (changed) {
    saveLibrary();
    renderWatchlist();
  }

  if (notify && newCount > 0) {
    const flagged = state.watchlist.filter(w => w.newSeasonInfo && !w.newSeasonInfo.dismissed);
    const names   = flagged.map(w => w.title).slice(0, 3).join(', ');
    const tvCount    = flagged.filter(w => w.mediaType === 'tv').length;
    const movieCount = flagged.filter(w => w.mediaType === 'movie').length;
    const parts = [];
    if (tvCount)    parts.push(`${tvCount} show${tvCount!==1?'s':''}`);
    if (movieCount) parts.push(`${movieCount} movie${movieCount!==1?'s':''}`);
    showToast(`New & upcoming: ${parts.join(' and ')} — ${names}`, 'success');
  }
}

// ═══════════════════════════════════════════════════════
// RESET ITEMS — clear metadata and re-fetch fresh
// ═══════════════════════════════════════════════════════

async function resetItems(ids) {
  if (!ids || !ids.length) return;

  const count = ids.length;
  const label = count === 1 ? '1 item' : `${count} items`;

  if (!confirm(`Reset ${label}? This clears all metadata and mappings. The ${count === 1 ? 'item' : 'items'} will be re-fetched fresh.`)) return;

  // Clear metadata from all matched items
  ids.forEach(id => {
    // Movies
    const movie = state.library.find(f => f.id === id);
    if (movie) {
      movie.metadata    = null;
      movie.posterPath  = null;
      movie.status      = 'pending';
      movie.title       = movie.displayTitle = cleanDisplayTitle(movie.filename || movie.path);
      state.metadataFetched.delete(id);
    }
    // TV shows
    const show = state.tvShows.find(s => s.id === id);
    if (show) {
      show.metadata    = null;
      show.posterPath  = null;
      show.status      = 'pending';
      show.title       = show.displayTitle = show.title || cleanDisplayTitle(show.path);
      state.metadataFetched.delete(id);
    }
  });

  clearSelection();
  applyFiltersAndSort();
  updateStats();
  saveLibrary();
  showToast(`${label} reset — re-fetching…`, 'info');

  // Delete cached files for these items via main process
  // (best effort — no error if cache file doesn't exist)
  try { await api.clearItemCache(ids); } catch {}

  // Queue re-fetch for all reset items — run as a batch so dedup fires after all complete
  if (state.settings.tmdbKey || state.settings.omdbKey) {
    const toFetch = [
      ...state.library.filter(f => ids.includes(f.id)),
      ...state.tvShows.filter(s => ids.includes(s.id)),
    ];
    // Small delay so UI updates first
    setTimeout(() => {
      state.fetchQueue.push(...toFetch);
      processFetchQueue();
    }, 300);
  }
}

function cleanDisplayTitle(raw) {
  if (!raw) return 'Unknown';
  // Strip extension and clean up filename into a readable title
  return (raw.replace(/\.[^/.]+$/, '').replace(/[._\-]+/g, ' ').trim()) || 'Unknown';
}

// ═══════════════════════════════════════════════════════
// TV GUIDE — episode & movie release tracker
// ═══════════════════════════════════════════════════════

function updateTVGuideBadge() {
  const badge = document.getElementById('tvguide-badge');
  if (!badge) return;
  const unread = (state.tvGuideNotifications || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderTVGuide() {
  const feed    = document.getElementById('tvguide-feed');
  const empty   = document.getElementById('tvguide-empty');
  const count   = document.getElementById('tvguide-count');
  if (!feed) return;

  // Mark all as read
  (state.tvGuideNotifications || []).forEach(n => { n.read = true; });
  updateTVGuideBadge();
  saveLibrary();

  const items = (state.tvGuideNotifications || [])
    .slice()
    .sort((a, b) => new Date(a.airDate) - new Date(b.airDate));

  if (!items.length) {
    feed.innerHTML = '';
    empty.style.display = 'flex';
    if (count) count.textContent = '';
    return;
  }
  empty.style.display = 'none';
  if (count) count.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const groups = {};

  items.forEach(item => {
    const d    = new Date(item.airDate);
    const diff = Math.floor((d - today) / 86400000);
    let group;
    if      (diff < 0)    group = 'RECENTLY AIRED';
    else if (diff === 0)  group = 'TODAY';
    else if (diff <= 7)   group = 'THIS WEEK';
    else if (diff <= 30)  group = 'THIS MONTH';
    else                  group = 'COMING SOON';
    if (!groups[group]) groups[group] = [];
    groups[group].push(item);
  });

  const ORDER = ['RECENTLY AIRED', 'TODAY', 'THIS WEEK', 'THIS MONTH', 'COMING SOON'];
  feed.innerHTML = '';

  ORDER.forEach(grp => {
    if (!groups[grp]) return;
    const hdr = document.createElement('div');
    hdr.className = 'tvguide-section-title';
    hdr.textContent = grp;
    feed.appendChild(hdr);

    groups[grp].forEach(item => {
      const d       = new Date(item.airDate);
      const diff    = Math.floor((d - today) / 86400000);
      const isPast  = diff < 0;
      const isToday = diff === 0;

      const entry = document.createElement('div');
      entry.className = `tvguide-entry ${isPast ? 'aired' : isToday ? 'unread' : 'upcoming'}`;

      const icon = item.type === 'movie' ? '🎬' : '📺';
      const dateStr = d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year: diff > 60 ? 'numeric' : undefined });
      const relStr  = isPast
        ? (diff === -1 ? 'Yesterday' : `${Math.abs(diff)}d ago`)
        : isToday ? 'Today'
        : diff === 1 ? 'Tomorrow'
        : dateStr;

      const isSeen = !!item.seen;
      entry.innerHTML = `
        <div class="tvguide-entry-icon">${isSeen ? '✓' : icon}</div>
        <div class="tvguide-entry-body">
          <div class="tvguide-entry-show" style="color:${isSeen ? 'var(--t2)' : 'var(--t0)'};text-decoration:${isSeen ? 'line-through' : 'none'};">${esc(item.showTitle)}</div>
          <div class="tvguide-entry-detail">${esc(item.detail)}</div>
        </div>
        <div class="tvguide-entry-date">${esc(relStr)}</div>
        <div class="tvguide-entry-actions">
          <button class="tvguide-seen-btn${isSeen ? ' seen' : ''}" title="${item.type === 'movie' ? 'Mark as watched' : 'Mark episode as watched'}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <button class="tvguide-view-btn">View</button>
          <button class="tvguide-dismiss-btn" title="Dismiss">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`;

      // Seen button — mark watched then dismiss
      entry.querySelector('.tvguide-seen-btn').addEventListener('click', () => {
        markTVGuideEntrySeen(item);
      });

      // View button — open the title directly
      entry.querySelector('.tvguide-view-btn').addEventListener('click', () => {
        // Try My List first
        const wlItem = state.watchlist.find(w => String(w.tmdbId) === String(item.tmdbId));
        if (wlItem) {
          if (item.type === 'tv') {
            switchView('watchlist');
            renderWatchlist();
            // Open the TV overlay after a short delay so the view is ready
            setTimeout(() => openWatchlistTVOverlay(wlItem), 150);
          } else {
            // Movie — open title detail page
            openTitleDetailPage(item.tmdbId, 'movie', item.showTitle, null);
          }
          return;
        }
        // Try local library
        const localMovie = state.library.find(f => String(f.metadata?.tmdbId) === String(item.tmdbId));
        if (localMovie) { openDetail(localMovie); return; }
        const localShow  = state.tvShows.find(s => String(s.metadata?.tmdbId) === String(item.tmdbId));
        if (localShow)  { openDetail(localShow);  return; }
        // Fallback — open TMDB search page
        openTitleDetailPage(item.tmdbId, item.type, item.showTitle, null);
      });

      // Dismiss button
      entry.querySelector('.tvguide-dismiss-btn').addEventListener('click', () => {
        state.tvGuideDismissed.add(item.id);
        state.tvGuideNotifications = state.tvGuideNotifications.filter(n => n.id !== item.id);
        saveLibrary();
        renderTVGuide();
      });

      feed.appendChild(entry);
    });
  });
}

async function refreshTVGuide(notify = false) {
  if (!state.settings.tmdbKey) return;

  const now      = new Date();
  const past30   = new Date(now); past30.setDate(now.getDate() - 30);
  const future90 = new Date(now); future90.setDate(now.getDate() + 90);
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const existingIds = new Set((state.tvGuideNotifications || []).map(n => n.id));
  let added = 0;

  // ── 1. My List TV shows — check current/next season episodes ──
  const tvWatchlist = state.watchlist.filter(w => w.mediaType === 'tv' && w.tmdbId);
  for (const item of tvWatchlist) {
    try {
      const resp = await api.tmdbGet(
      `/3/tv/${item.tmdbId}`
    );
      if (!resp || resp.error) { await new Promise(r => setTimeout(r, 150)); continue; }
      const data = resp;
      const seasons = (data.seasons || []).filter(s => s.season_number > 0);

      for (const season of seasons.slice(-2)) { // check last 2 seasons
        const key = `${item.tmdbId}_${season.season_number}`;
        let episodes = tvEpisodeCache[key];
        if (!episodes) {
          const sr = await api.tmdbGet(
      `/3/tv/${item.tmdbId}/season/${season.season_number}`
    );
          if (sr && !sr.error) {
            episodes = sr.episodes || [];
            if (episodes.length) tvEpisodeCache[key] = episodes;
          }
          await new Promise(r => setTimeout(r, 120));
        }
        for (const ep of (episodes || [])) {
          if (!ep.air_date) continue;
          const airDate = new Date(ep.air_date);
          if (airDate < past30 || airDate > future90) continue;
          const id = `tv_${item.tmdbId}_s${season.season_number}e${ep.episode_number}`;
          if (existingIds.has(id) || state.tvGuideDismissed.has(id)) continue;
          const detail = `S${String(season.season_number).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} — ${ep.name || 'Episode '+ep.episode_number}`;
          state.tvGuideNotifications.push({
            id, tmdbId: item.tmdbId, type: 'tv',
            showTitle: item.title,
            detail,
            airDate: ep.air_date,
            read: false,
            seen: false,
          });
          existingIds.add(id);
          added++;
        }
      }
    } catch {}
  }

  // ── 2. Local TV shows with watched episodes — same logic ──
  const activeLocal = state.tvShows.filter(show => {
    if (!show.metadata?.tmdbId) return false;
    return (show.episodes || []).some(e => e.watched);
  });
  for (const show of activeLocal) {
    if (tvWatchlist.find(w => String(w.tmdbId) === String(show.metadata.tmdbId))) continue; // already handled
    try {
      const resp = await api.tmdbGet(
      `/3/tv/${show.metadata.tmdbId}`
    );
      if (!resp || resp.error) { await new Promise(r => setTimeout(r, 150)); continue; }
      const data = resp;
      const seasons = (data.seasons || []).filter(s => s.season_number > 0);
      const latestSeason = seasons[seasons.length - 1];
      if (!latestSeason) continue;

      const key = `${show.metadata.tmdbId}_${latestSeason.season_number}`;
      let episodes = tvEpisodeCache[key];
      if (!episodes) {
        const sr = await api.tmdbGet(
      `/3/tv/${show.metadata.tmdbId}/season/${latestSeason.season_number}`
    );
        if (sr && !sr.error) {
          episodes = sr.episodes || [];
          if (episodes.length) tvEpisodeCache[key] = episodes;
        }
        await new Promise(r => setTimeout(r, 120));
      }
      for (const ep of (episodes || [])) {
        if (!ep.air_date) continue;
        const airDate = new Date(ep.air_date);
        if (airDate < past30 || airDate > future90) continue;
        const id = `tv_${show.metadata.tmdbId}_s${latestSeason.season_number}e${ep.episode_number}`;
        if (existingIds.has(id) || state.tvGuideDismissed.has(id)) continue;
        const detail = `S${String(latestSeason.season_number).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} — ${ep.name || 'Episode '+ep.episode_number}`;
        state.tvGuideNotifications.push({
          id, tmdbId: show.metadata.tmdbId, type: 'tv',
          showTitle: show.displayTitle || show.title,
          detail,
          airDate: ep.air_date,
          read: false,
        });
        existingIds.add(id);
        added++;
      }
    } catch {}
  }

  // ── 3. My List movies — check release dates ──
  const movieWatchlist = state.watchlist.filter(w => w.mediaType === 'movie' && w.tmdbId);
  for (const item of movieWatchlist) {
    try {
      const resp = await api.tmdbGet(
      `/3/movie/${item.tmdbId}`
    );
      if (!resp || resp.error) { await new Promise(r => setTimeout(r, 150)); continue; }
      const data = resp;
      if (!data.release_date) continue;
      const airDate = new Date(data.release_date);
      if (airDate < past30 || airDate > future90) continue;
      const id = `movie_${item.tmdbId}`;
      if (existingIds.has(id) || state.tvGuideDismissed.has(id)) continue;
      const diff = Math.floor((airDate - today) / 86400000);
      const detail = diff > 0
        ? `Premieres ${airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`
        : `Released ${airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`;
      state.tvGuideNotifications.push({
        id, tmdbId: item.tmdbId, type: 'movie',
        showTitle: item.title,
        detail,
        airDate: data.release_date,
        read: false,
      });
      existingIds.add(id);
      added++;
    } catch {}
  }

  // Purge entries and dismissed IDs older than the lookback window
  state.tvGuideNotifications = state.tvGuideNotifications
    .filter(n => new Date(n.airDate) >= past30);
  // Keep dismissed set bounded — only retain IDs that could still reappear
  // (i.e. whose air date is within the future90 window). Since IDs don't encode
  // dates directly, we keep any dismissed ID that still matches a notification
  // we just purged, plus a hard cap of 500 entries to prevent unbounded growth.
  if (state.tvGuideDismissed.size > 500) {
    const arr = [...state.tvGuideDismissed];
    state.tvGuideDismissed = new Set(arr.slice(arr.length - 500));
  }

  saveLibrary();
  updateTVGuideBadge();

  // If TV Guide is currently open, re-render it
  if (state.currentView === 'tvguide') renderTVGuide();

  if (notify && added > 0) {
    showToast(`TV Guide: ${added} new item${added !== 1 ? 's' : ''} added`, 'success');
  }
}

// ── Targeted TV Guide refresh for a single newly-added item ──
async function refreshTVGuideForItem(tmdbId, mediaType) {
  if (!state.settings.tmdbKey) return;

  const now      = new Date();
  const past90   = new Date(now); past90.setDate(now.getDate() - 90);
  const future90 = new Date(now); future90.setDate(now.getDate() + 90);
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const existingIds = new Set((state.tvGuideNotifications || []).map(n => n.id));
  const item = state.watchlist.find(w => String(w.tmdbId) === String(tmdbId));
  if (!item) return;

  let added = 0;

  try {
    if (mediaType === 'tv') {
      const resp = await api.tmdbGet(
      `/3/tv/${tmdbId}`
    );
      if (!resp || resp.error) return;
      const data = resp;
      const seasons = (data.seasons || []).filter(s => s.season_number > 0);

      for (const season of seasons.slice(-2)) {
        const key = `${tmdbId}_${season.season_number}`;
        let episodes = tvEpisodeCache[key];
        if (!episodes) {
          const sr = await api.tmdbGet(
      `/3/tv/${tmdbId}/season/${season.season_number}`
    );
          if (sr && !sr.error) {
            episodes = sr.episodes || [];
            if (episodes.length) tvEpisodeCache[key] = episodes;
          }
        }
        for (const ep of (episodes || [])) {
          if (!ep.air_date) continue;
          const airDate = new Date(ep.air_date);
          if (airDate < past90 || airDate > future90) continue;
          const id = `tv_${tmdbId}_s${season.season_number}e${ep.episode_number}`;
          if (existingIds.has(id) || state.tvGuideDismissed.has(id)) continue;
          const detail = `S${String(season.season_number).padStart(2,'0')}E${String(ep.episode_number).padStart(2,'0')} — ${ep.name || 'Episode '+ep.episode_number}`;
          state.tvGuideNotifications.push({
            id, tmdbId: String(tmdbId), type: 'tv',
            showTitle: item.title, detail,
            airDate: ep.air_date, read: false,
          });
          existingIds.add(id);
          added++;
        }
      }
    } else {
      const country = (state.settings.countryCode || 'US').toUpperCase();
      const [baseData, datesData] = await Promise.all([
        api.tmdbGet(`/3/movie/${tmdbId}`),
        api.tmdbGet(`/3/movie/${tmdbId}/release_dates`),
      ]);
      if (!baseData || baseData.error) return;

      const candidates = [];
      if (baseData.release_date) candidates.push(new Date(baseData.release_date));
      if (datesData?.results) {
        for (const region of [country, 'US']) {
          const entry = datesData.results.find(r => r.iso_3166_1 === region);
          if (!entry) continue;
          for (const rel of (entry.release_dates || [])) {
            if ([3, 4, 6].includes(rel.type) && rel.release_date) {
              candidates.push(new Date(rel.release_date));
            }
          }
        }
      }

      const inWindow = candidates.filter(d => d >= past90 && d <= future90);
      if (!inWindow.length) return;
      const pastDates   = inWindow.filter(d => d <= today).sort((a,b) => b - a);
      const futureDates = inWindow.filter(d => d > today).sort((a,b) => a - b);
      const airDate = pastDates[0] || futureDates[0];

      const id = `movie_${tmdbId}`;
      if (existingIds.has(id) || state.tvGuideDismissed.has(id)) return;
      const diff = Math.floor((airDate - today) / 86400000);
      const detail = diff > 0
        ? `Available ${airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`
        : `Available ${airDate.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}`;
      state.tvGuideNotifications.push({
        id, tmdbId: String(tmdbId), type: 'movie',
        showTitle: item.title, detail,
        airDate: airDate.toISOString().split('T')[0], read: false,
      });
      added++;
    }
  } catch {}

  if (added > 0) {
    saveLibrary();
    updateTVGuideBadge();
    if (state.currentView === 'tvguide') renderTVGuide();
    showToast(`TV Guide: ${added} new item${added !== 1 ? 's' : ''} added for "${item.title}"`, 'info');
  }
}


// ── Mark a TV Guide entry as seen ────────────────────────────────────────────
function markTVGuideEntrySeen(item) {
  const tmdbId = String(item.tmdbId);

  if (item.type === 'movie') {
    // ── Movie: mark My List item as watched ──────────────────
    const wlItem = state.watchlist.find(w => String(w.tmdbId) === tmdbId);
    if (wlItem) {
      wlItem.watched = true;
      saveLibrary();
      renderWatchlist();
      showToast(`"${item.showTitle}" marked as watched`, 'success');
    }

  } else {
    // ── TV episode: parse season + episode from the entry ID ──
    // ID format: tv_tmdbId_sNNeNN
    const m = item.id.match(/_s(\d+)e(\d+)$/);
    const season  = m ? parseInt(m[1]) : null;
    const episode = m ? parseInt(m[2]) : null;

    if (season !== null && episode !== null) {
      // Try My List watchlist first
      const wlItem = state.watchlist.find(w => String(w.tmdbId) === tmdbId);
      if (wlItem) {
        if (!wlItem.watchedEpisodes) wlItem.watchedEpisodes = {};
        wlItem.watchedEpisodes[`${season}-${episode}`] = true;
        saveLibrary();
        if (state.currentView === 'watchlist') renderWatchlist();
      }

      // Also mark in local library if the show exists there
      const localShow = state.tvShows.find(s =>
        String(s.metadata?.tmdbId) === tmdbId
      );
      if (localShow) {
        const ep = (localShow.episodes || []).find(
          e => e.season === season && e.episode === episode
        );
        if (ep) {
          ep.watched = true;
          saveLibrary();
        }
      }

      showToast(
        `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')} marked as watched`,
        'success'
      );
    }
  }

  // Dismiss the entry from TV Guide (Option B behaviour)
  state.tvGuideDismissed.add(item.id);
  state.tvGuideNotifications = state.tvGuideNotifications.filter(n => n.id !== item.id);
  saveLibrary();
  updateTVGuideBadge();
  renderTVGuide();
}

// ═══════════════════════════════════════════════════════
// UPDATE CHECKER
// ═══════════════════════════════════════════════════════

async function checkForUpdates(userInitiated = false) {
  const CURRENT_VERSION = await api.getAppVersion().catch(() => '1.6.3');
  const RELEASES_API    = 'https://api.github.com/repos/IVibeStuff/MediaVault/releases/latest';
  const RELEASES_PAGE   = 'https://github.com/IVibeStuff/MediaVault/releases/latest';

  try {
    const resp = await fetch(RELEASES_API, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });

    if (!resp || resp.error) {
      if (userInitiated) showToast('Could not reach GitHub — check your connection', 'error');
      return;
    }

    const data = resp;
    const latest = (data.tag_name || '').replace(/^v/, '');

    if (!latest) {
      if (userInitiated) showToast('Could not determine latest version', 'error');
      return;
    }

    // Compare versions semantically
    const parseVer = v => v.split('.').map(Number);
    const [maj, min, pat]    = parseVer(latest);
    const [cMaj, cMin, cPat] = parseVer(CURRENT_VERSION);
    const isNewer = maj > cMaj || (maj === cMaj && min > cMin) || (maj === cMaj && min === cMin && pat > cPat);

    if (isNewer) {
      // Find the .exe asset if available
      const exeAsset = (data.assets || []).find(a => a.name.endsWith('.exe'));
      const rawUrl = exeAsset ? exeAsset.browser_download_url : RELEASES_PAGE;
      // Only allow github.com URLs — guard against a compromised API response
      const downloadUrl = /^https:\/\/github\.com\//i.test(rawUrl) ? rawUrl : RELEASES_PAGE;

      // Show a persistent update banner
      showUpdateBanner(`v${latest}`, downloadUrl, data.body || '');
    } else if (userInitiated) {
      showToast(`MediaVault is up to date (v${CURRENT_VERSION})`, 'success');
    }

  } catch (e) {
    if (userInitiated) showToast('Update check failed — ' + e.message, 'error');
  }
}

function showUpdateBanner(version, downloadUrl, releaseNotes) {
  // Remove any existing banner
  document.getElementById('update-banner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'z-index:900',
    'background:var(--bg-1)',
    'border:1px solid var(--accent)',
    'border-radius:12px',
    'padding:16px 20px',
    'max-width:320px',
    'box-shadow:0 8px 32px rgba(0,0,0,.5)',
    'display:flex',
    'flex-direction:column',
    'gap:10px',
    'animation:slideInRight .3s cubic-bezier(.4,0,.2,1)',
  ].join(';');

  // Trim release notes to first 2 lines
  const notes = releaseNotes
    ? releaseNotes.split('\n').filter(l => l.trim()).slice(0, 2).join(' · ')
    : '';

  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--t0);margin-bottom:3px;">
          MediaVault ${esc(version)} available
        </div>
        ${notes ? `<div style="font-size:11px;color:var(--t2);line-height:1.5;">${esc(notes.substring(0, 120))}${notes.length > 120 ? '…' : ''}</div>` : ''}
      </div>
      <button id="update-banner-close" style="background:none;border:none;color:var(--t2);cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;padding:0;">×</button>
    </div>
    <div style="display:flex;gap:8px;">
      <a href="${esc(downloadUrl)}" id="update-download-btn" style="flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;background:var(--accent);color:#fff;border-radius:var(--radius-sm);font-size:12px;font-weight:600;text-decoration:none;transition:opacity .15s;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download ${esc(version)}
      </a>
      <a href="https://github.com/IVibeStuff/MediaVault/releases" style="display:inline-flex;align-items:center;padding:8px 12px;background:var(--bg-3);color:var(--t1);border:1px solid var(--border-mid);border-radius:var(--radius-sm);font-size:12px;font-weight:500;text-decoration:none;">
        Release notes
      </a>
    </div>`;

  document.body.appendChild(banner);

  // Handle link clicks — open in system browser via Electron shell
  banner.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      api.openExternal(a.href);
    });
  });

  document.getElementById('update-banner-close').addEventListener('click', () => {
    banner.style.opacity = '0';
    banner.style.transition = 'opacity .2s';
    setTimeout(() => banner.remove(), 200);
  });
}

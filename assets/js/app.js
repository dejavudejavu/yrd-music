/*
 * yrd音乐站 · 主逻辑
 * ---------------------------------------------------------------------------
 * 功能：四源聚合搜索、播放/暂停/切歌、进度与音量、LRC 歌词高亮、
 *       收藏、自建歌单、导入/导出、中英切换、快捷键、粒子背景、水波纹。
 * 数据持久化键与原站一致（同源时可直接沿用）：
 *   pikachu-music-lang / pikachu-music-library-v1
 */
(function () {
  'use strict';

  const API = window.PikachuAPI;
  const I18N = window.PikachuI18N;

  const LIBRARY_STORAGE_KEY = 'pikachu-music-library-v1';
  const LANG_STORAGE_KEY = 'pikachu-music-lang';

  const state = {
    language: 'zh',
    enabledSources: { netease: true, qq: true, kuwo: true, joox: false },
    perSourceLimit: 10,
    perSourceCurrentLimit: { netease: 10, qq: 10, kuwo: 10, joox: 10 },
    perSourcePage: { netease: 1, qq: 1, kuwo: 1, joox: 1 },

    searchKeyword: '',
    searchResults: [],
    trackMap: new Map(),
    favorites: [],
    playlists: [],
    currentTrack: null,
    playContext: { type: 'results', index: -1, playlistId: null },
    playMode: 'list',
    isPlaying: false,
    lyricLines: [],
    currentLyricIndex: -1,
    searchInProgress: false,
    noMoreResults: false,
    lyricsAlt: false,
    muted: false,

    statusKey: 'playerStatusIdle',
    searchStatusKey: 'searchStatusIdle'
  };

  const dom = {};
  let audioLevel = 0;
  let playToken = 0;
  let searchToken = 0;
  let toastTimer = null;
  let lastPlayErrorAt = 0;
  let progressDragging = false;

  /* ============================ 基础工具 ============================ */

  function $(id) {
    return document.getElementById(id);
  }

  function t(key) {
    return I18N.get(state.language, key);
  }

  function showToast(msg) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function isReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function getInterleavedSearchList() {
    const grouped = { netease: [], qq: [], kuwo: [], joox: [] };
    state.searchResults.forEach(track => {
      if (grouped[track.source]) grouped[track.source].push(track);
    });
    Object.keys(grouped).forEach(k => grouped[k].sort((a, b) => (a.displayIndex || 0) - (b.displayIndex || 0)));
    const order = ['netease', 'qq', 'kuwo', 'joox'];
    const idx = { netease: 0, qq: 0, kuwo: 0, joox: 0 };
    const out = [];
    let added = true;
    while (added) {
      added = false;
      for (const s of order) {
        const arr = grouped[s];
        const i = idx[s];
        if (arr && i < arr.length) {
          out.push(arr[i]);
          idx[s]++;
          added = true;
        }
      }
    }
    return out;
  }

  function setPlayerStatus(key) {
    state.statusKey = key;
    dom.playerStatus.textContent = t(key);
  }

  function setSearchStatus(key) {
    state.searchStatusKey = key;
    dom.searchStatus.textContent = t(key);
  }

  function updatePlayButtonUI() {
    if (!dom.playBtn) return;
    dom.playBtn.textContent = state.isPlaying ? '⏸' : '▶';
    dom.playBtn.setAttribute('aria-label', t(state.isPlaying ? 'ariaPause' : 'ariaPlay'));
    dom.playBtn.title = t(state.isPlaying ? 'ariaPause' : 'ariaPlay');
  }

  function sourceLabelKey(source) {
    if (source === 'netease') return 'sourceNetease';
    if (source === 'qq') return 'sourceQQ';
    if (source === 'joox') return 'sourceJoox';
    return 'sourceKuwo';
  }

  /* ============================ 语言 ============================ */

  function setLanguage(lang) {
    if (lang !== 'zh' && lang !== 'en') lang = 'zh';
    state.language = lang;
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (e) {}

    document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
    document.title = t('appTitle') + ' - yrd Music';

    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (key) el.textContent = t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      if (key) el.placeholder = t(key);
    });

    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.dataset.i18nTitle;
      if (key) el.title = t(key);
    });

    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.dataset.i18nAria;
      if (key) el.setAttribute('aria-label', t(key));
    });

    if (dom.playlistSelect) renderPlaylistOptions();
    updatePlaylistInfoLabel();
    setPlayerStatus(state.statusKey);
    setSearchStatus(state.searchStatusKey);
    updatePlayButtonUI();
    updateMainFavButton();

    if (state.currentTrack) {
      state.lyricLines = state.currentTrack.lrc ? API.parseLRC(state.currentTrack.lrc) : state.lyricLines;
      renderLyrics();
      renderMiniSearchList();
      renderPlaylistList();
    }
  }

  /* ============================ 数据序列化 / 本地存储 ============================ */

  function serializeTrack(track) {
    if (!track) return null;
    const keys = [
      'uid', 'source', 'displayIndex', 'keyword', 'songid', 'songMid', 'qqId', 'qqSearchKey', 'qqIndex',
      'jooxIndex', 'jooxSongId', 'jooxSongMid', 'title', 'artist', 'album', 'cover', 'pageUrl',
      'quality', 'qualityLabel', 'qqQualityText', 'jooxQualityText', 'pay'
    ];
    const out = {};
    keys.forEach(k => {
      if (track[k] !== undefined && track[k] !== null && track[k] !== '') out[k] = track[k];
    });
    out.detailsLoaded = false;
    out.audioUrl = null;
    out.lrc = null;
    out.lrcUrl = null;
    return out.uid ? out : null;
  }

  function deserializeTrack(raw) {
    if (raw && raw.source === 'migu') return null;
    const track = serializeTrack(raw);
    if (!track) return null;
    track.detailsLoaded = false;
    track.audioUrl = null;
    track.lrc = null;
    track.lrcUrl = null;
    return track;
  }

  function getLibrarySnapshot() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      favorites: state.favorites.map(serializeTrack).filter(Boolean),
      playlists: state.playlists.map(pl => ({
        id: pl.id,
        name: pl.name,
        tracks: (pl.tracks || []).map(serializeTrack).filter(Boolean)
      }))
    };
  }

  function saveLibraryToStorage() {
    try {
      localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(getLibrarySnapshot()));
    } catch (e) {
      console.warn('save library failed', e);
    }
  }

  function rebuildLibraryTrackMap() {
    [...state.favorites, ...state.playlists.flatMap(pl => pl.tracks || [])].forEach(track => {
      if (track && track.uid && !state.trackMap.has(track.uid)) {
        state.trackMap.set(track.uid, track);
      }
    });
  }

  function loadLibraryFromStorage() {
    try {
      const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state.favorites = Array.isArray(data.favorites)
        ? data.favorites.map(deserializeTrack).filter(Boolean)
        : [];
      state.playlists = Array.isArray(data.playlists)
        ? data.playlists.map((pl, idx) => ({
            id: pl.id || ('pl-cached-' + idx + '-' + Date.now()),
            name: pl.name || (state.language === 'zh' ? '未命名歌单' : 'Untitled Playlist'),
            tracks: Array.isArray(pl.tracks) ? pl.tracks.map(deserializeTrack).filter(Boolean) : []
          }))
        : [];
      rebuildLibraryTrackMap();
    } catch (e) {
      console.warn('load library failed', e);
    }
  }

  function exportPlaylistData() {
    const payload = getLibrarySnapshot();
    const hasAny = payload.favorites.length || payload.playlists.length;
    if (!hasAny) {
      showToast(t('toastPlaylistExportEmpty'));
      return;
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'pikachu-music-playlists-' + date + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(t('toastPlaylistExported'));
  }

  function mergeImportedTracks(targetList, rawTracks) {
    let added = 0;
    if (!Array.isArray(rawTracks)) return added;

    rawTracks.forEach(raw => {
      const imported = deserializeTrack(raw);
      if (!imported || !imported.uid) return;

      const track = state.trackMap.get(imported.uid) || imported;
      if (!state.trackMap.has(track.uid)) state.trackMap.set(track.uid, track);

      if (!targetList.some(item => item.uid === track.uid)) {
        targetList.push(track);
        added++;
      }
    });

    return added;
  }

  function importPlaylistData(data) {
    if (!data || typeof data !== 'object') throw new Error('invalid import data');

    let addedFavorites = 0;
    let addedPlaylists = 0;
    let addedPlaylistTracks = 0;

    addedFavorites = mergeImportedTracks(state.favorites, data.favorites);

    const importedPlaylists = Array.isArray(data.playlists) ? data.playlists : [];
    importedPlaylists.forEach((pl, idx) => {
      if (!pl || typeof pl !== 'object') return;

      const fallbackName = state.language === 'zh' ? '导入歌单' : 'Imported Playlist';
      const name = (pl.name || fallbackName).toString().trim() || fallbackName;
      const rawId = (pl.id || '').toString().trim();

      let target = rawId ? state.playlists.find(item => item.id === rawId) : null;
      if (!target) target = state.playlists.find(item => item.name === name);

      if (!target) {
        let id = rawId || ('pl-import-' + Date.now() + '-' + idx + '-' + Math.random().toString(16).slice(2));
        if (state.playlists.some(item => item.id === id)) {
          id = 'pl-import-' + Date.now() + '-' + idx + '-' + Math.random().toString(16).slice(2);
        }
        target = { id: id, name: name, tracks: [] };
        state.playlists.push(target);
        addedPlaylists++;
      }

      addedPlaylistTracks += mergeImportedTracks(target.tracks, pl.tracks);
    });

    const totalAdded = addedFavorites + addedPlaylists + addedPlaylistTracks;
    const hasUsableData = (Array.isArray(data.favorites) && data.favorites.length) || importedPlaylists.length;
    if (!hasUsableData) {
      return { empty: true, addedFavorites: addedFavorites, addedPlaylists: addedPlaylists, addedPlaylistTracks: addedPlaylistTracks, totalAdded: totalAdded };
    }

    rebuildLibraryTrackMap();
    renderPlaylistOptions();
    saveLibraryToStorage();
    renderPlaylistList();
    updateMainFavButton();

    return { empty: false, addedFavorites: addedFavorites, addedPlaylists: addedPlaylists, addedPlaylistTracks: addedPlaylistTracks, totalAdded: totalAdded };
  }

  function handleImportPlaylistFile(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const stat = importPlaylistData(data);
        if (stat.empty) {
          showToast(t('toastPlaylistImportEmpty'));
        } else {
          const msg = state.language === 'zh'
            ? `${t('toastPlaylistImported')}：新增 ${stat.addedPlaylists} 个歌单，${stat.addedFavorites} 首收藏，${stat.addedPlaylistTracks} 首歌单歌曲。`
            : `${t('toastPlaylistImported')}: ${stat.addedPlaylists} playlists, ${stat.addedFavorites} favorites, ${stat.addedPlaylistTracks} playlist tracks added.`;
          showToast(msg);
        }
      } catch (err) {
        console.error('import playlist failed', err);
        showToast(t('toastPlaylistImportError'));
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      showToast(t('toastPlaylistImportError'));
      input.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  function renderPlaylistOptions() {
    if (!dom.playlistSelect) return;
    const prev = dom.playlistSelect.value || state.playContext.playlistId;
    dom.playlistSelect.innerHTML = '';

    if (!state.playlists.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = state.language === 'zh' ? '暂无歌单' : 'No playlist';
      dom.playlistSelect.appendChild(opt);
      state.playContext.playlistId = null;
      return;
    }

    state.playlists.forEach(pl => {
      const opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.name;
      dom.playlistSelect.appendChild(opt);
    });

    const nextValue = state.playlists.some(pl => pl.id === prev) ? prev : state.playlists[0].id;
    dom.playlistSelect.value = nextValue;
    state.playContext.playlistId = nextValue;
  }

  /* ============================ 聚合搜索 ============================ */

  function addSearchTracks(list) {
    let added = 0;
    (list || []).forEach(track => {
      if (!track || !track.uid || state.trackMap.has(track.uid)) return;
      state.trackMap.set(track.uid, track);
      state.searchResults.push(track);
      added++;
    });
    return added;
  }

  async function searchAllSources(reset) {
    if (!state.searchKeyword) {
      showToast(t('toastNeedKeyword'));
      return;
    }
    const enabled = Object.keys(state.enabledSources).filter(k => state.enabledSources[k]);
    if (!enabled.length) {
      showToast(t('searchStatusNoSource'));
      return;
    }

    const token = ++searchToken;

    if (reset) {
      Object.keys(state.perSourceCurrentLimit).forEach(k => state.perSourceCurrentLimit[k] = state.perSourceLimit);
      Object.keys(state.perSourcePage).forEach(k => state.perSourcePage[k] = 1);

      state.searchResults = [];
      state.trackMap.clear();
      state.noMoreResults = false;
      if (dom.searchMiniList) dom.searchMiniList.scrollTop = 0;
      if (dom.playlistMain) dom.playlistMain.scrollTop = 0;
    }

    state.searchInProgress = true;
    setSearchStatus('searchStatusSearching');

    const kw = state.searchKeyword;
    const tasks = [];
    for (const s of enabled) {
      const limit = state.perSourceCurrentLimit[s] || state.perSourceLimit;
      if (s === 'netease') tasks.push(API.searchNetease(kw, state.perSourcePage.netease || 1, state.perSourceLimit));
      if (s === 'qq') tasks.push(API.searchQQ(kw, limit));
      if (s === 'kuwo') tasks.push(API.searchKuwo(kw, limit));
      if (s === 'joox') tasks.push(API.searchJoox(kw, limit));
    }

    let added = 0;
    try {
      const results = await Promise.all(tasks);
      if (token !== searchToken) return; // 已有更新的搜索，丢弃旧结果
      results.forEach(list => { added += addSearchTracks(list); });
    } catch (e) {
      console.error(e);
      if (token === searchToken) showToast(t('toastSearchError'));
    }

    if (token !== searchToken) return;

    state.searchInProgress = false;
    setSearchStatus('searchStatusDone');
    dom.searchCount.textContent = state.searchResults.length.toString();
    renderMiniSearchList();
    renderPlaylistList();

    if (!state.currentTrack && state.searchResults.length) {
      playFromList('results', 0);
    }
    if (!reset) {
      if (added === 0) {
        state.noMoreResults = true;
        showToast(t('toastNoMore'));
      } else {
        state.noMoreResults = false;
      }
    }
  }

  function canAutoLoadMore() {
    return !state.searchInProgress && !state.noMoreResults;
  }

  function requestMoreResults() {
    const enabled = Object.keys(state.enabledSources).filter(k => state.enabledSources[k]);
    if (!enabled.length) return;

    enabled.forEach(src => {
      if (src === 'netease') {
        state.perSourcePage.netease = (state.perSourcePage.netease || 1) + 1;
      } else {
        state.perSourceCurrentLimit[src] = (state.perSourceCurrentLimit[src] || state.perSourceLimit) + state.perSourceLimit;
      }
    });

    searchAllSources(false);
  }

  /* ============================ 详情补全 ============================ */

  async function ensureTrackDetails(track) {
    if (track.detailsLoaded && track.audioUrl && (track.lrc || !track.lrcUrl)) return;
    setPlayerStatus('playerStatusLoading');
    if (track.source === 'netease') await API.fetchNeteaseDetails(track);
    else if (track.source === 'kuwo') await API.fetchKuwoDetails(track);
    else if (track.source === 'joox') await API.fetchJooxDetails(track);
    else await API.fetchQQDetails(track);
  }

  /* ============================ 歌词 ============================ */

  function renderLyrics() {
    const wrap = dom.lyricsInner;
    wrap.innerHTML = '';
    state.currentLyricIndex = -1;
    const track = state.currentTrack;
    const titleLine = document.createElement('div');
    titleLine.className = 'lyrics-title-line';
    if (track) {
      titleLine.textContent = (track.title || '') + (track.artist ? ' - ' + track.artist : '');
    }
    wrap.appendChild(titleLine);

    const arr = state.lyricLines;
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.id = 'lyrics-empty';
      empty.className = 'lyrics-empty';
      empty.textContent = t('lyricsEmpty');
      wrap.appendChild(empty);
      return;
    }
    arr.forEach((ln, i) => {
      const div = document.createElement('div');
      div.className = 'lyrics-line';
      div.dataset.index = i;
      div.textContent = ln.text;
      wrap.appendChild(div);
    });
  }

  function updateLyricsHighlight(time) {
    const lines = state.lyricLines;
    if (!lines.length) return;
    let idx = state.currentLyricIndex;
    if (idx < 0 || idx >= lines.length || time < lines[idx].time || (idx + 1 < lines.length && time >= lines[idx + 1].time)) {
      idx = lines.findIndex((l, i) => {
        const nxt = lines[i + 1];
        if (!nxt) return time >= l.time - 0.05;
        return time >= l.time - 0.05 && time < nxt.time - 0.05;
      });
    }
    if (idx < 0 || idx === state.currentLyricIndex) return;
    state.currentLyricIndex = idx;
    const wrap = dom.lyricsInner;
    wrap.querySelectorAll('.lyrics-line.active').forEach(el => el.classList.remove('active'));
    const act = wrap.querySelector(`.lyrics-line[data-index="${idx}"]`);
    if (act) {
      act.classList.add('active');
      const box = dom.lyricsContainer;
      box.scrollTo({ top: act.offsetTop - box.clientHeight * 0.45, behavior: 'smooth' });
    }
  }

  /* ============================ 收藏 / 播放 ============================ */

  function isFavorite(track) {
    if (!track) return false;
    return state.favorites.some(x => x.uid === track.uid);
  }

  function updateMainFavButton() {
    if (!dom.favBtn) return;
    const tr = state.currentTrack;
    const active = isFavorite(tr);
    dom.favBtn.classList.toggle('btn-fav-active', active);
    dom.favBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    dom.favBtn.title = t('ariaFav');
  }

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      const artwork = track && track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (track && track.title) || '',
        artist: (track && track.artist) || '',
        album: (track && track.album) || '',
        artwork: artwork
      });
    } catch (e) {
      // 某些浏览器对 artwork 有限制，忽略即可
    }
  }

  function updateProgressUI(cur, dur) {
    if (!dom.progressBar) return;
    dom.currentTime.textContent = formatTime(cur);
    dom.totalTime.textContent = formatTime(dur || 0);
    if (dur > 0) {
      const r = Math.min(1, Math.max(0, cur / dur));
      dom.progressBar.style.transform = 'scaleX(' + r + ')';
      const w = dom.progressWrapper.clientWidth;
      dom.progressHandle.style.left = (w * r) + 'px';
      dom.progressWrapper.setAttribute('aria-valuenow', String(Math.round(r * 100)));
      dom.progressWrapper.setAttribute('aria-valuetext', formatTime(cur) + ' / ' + formatTime(dur));
    } else {
      dom.progressWrapper.setAttribute('aria-valuenow', '0');
    }
  }

  async function playTrack(track, context) {
    if (!track) return;
    const token = ++playToken;
    state.currentTrack = track;
    state.playContext = context || state.playContext;

    const applyUI = () => {
      dom.trackTitle.textContent = track.title || '';
      dom.trackArtist.textContent = track.artist || '';

      const sk = track.source;
      dom.trackSourcePill.style.display = 'inline-flex';
      dom.trackSourcePill.className = 'source-pill source-' + sk;
      dom.trackSourcePill.innerHTML = '';
      const dot = document.createElement('span');
      dot.className = 'source-dot ' + sk;
      const txt = document.createElement('span');
      txt.textContent = t(sourceLabelKey(sk));
      dom.trackSourcePill.appendChild(dot);
      dom.trackSourcePill.appendChild(txt);

      if (track.qualityLabel) {
        dom.trackQualityPill.style.display = 'inline-block';
        dom.trackQualityPill.textContent = track.qualityLabel;
      } else {
        dom.trackQualityPill.style.display = 'none';
      }

      if (track.cover) {
        dom.coverImg.src = track.cover;
        dom.coverImg.style.display = 'block';
        dom.coverPlaceholder.style.display = 'none';
      } else {
        dom.coverImg.removeAttribute('src');
        dom.coverImg.style.display = 'none';
        dom.coverPlaceholder.style.display = 'flex';
      }

      updateMediaSession(track);
    };

    setPlayerStatus('playerStatusLoading');
    applyUI();

    state.lyricLines = track.lrc ? API.parseLRC(track.lrc) : [];
    renderLyrics();
    updateMainFavButton();

    try {
      await ensureTrackDetails(track);
      if (token !== playToken) return; // 用户已切到别的歌

      applyUI();
      state.lyricLines = track.lrc ? API.parseLRC(track.lrc) : [];
      renderLyrics();

      if (!track.audioUrl) {
        showToast(t('toastPlayError'));
        setPlayerStatus('playerStatusIdle');
        return;
      }

      dom.audio.src = track.audioUrl;
      dom.audio.currentTime = 0;
      try {
        await dom.audio.play();
        state.isPlaying = true;
        updatePlayButtonUI();
        setPlayerStatus('playerStatusPlaying');
      } catch (playErr) {
        if (playErr && playErr.name === 'NotAllowedError') {
          // 移动端浏览器可能拦截自动播放：保持已加载状态，等待用户点播放
          state.isPlaying = false;
          updatePlayButtonUI();
          setPlayerStatus('playerStatusPaused');
        } else {
          throw playErr;
        }
      }
    } catch (e) {
      console.error(e);
      if (token === playToken) {
        showToast(t('toastPlayError'));
        setPlayerStatus('playerStatusIdle');
      }
    }

    renderMiniSearchList();
    renderPlaylistList();
  }

  function getActiveList() {
    const tp = state.playContext.type;
    if (tp === 'results') {
      let list = getInterleavedSearchList();
      if (!list.length && state.searchResults.length) {
        list = [...state.searchResults];
      }
      return list;
    }
    if (tp === 'favorites') return state.favorites;
    if (tp === 'playlist') {
      const pl = state.playlists.find(p => p.id === state.playContext.playlistId);
      return pl ? pl.tracks : [];
    }
    return getInterleavedSearchList();
  }

  function playFromList(type, index, plId) {
    let list;
    if (type === 'results') list = getInterleavedSearchList();
    else if (type === 'favorites') list = state.favorites;
    else {
      const pl = state.playlists.find(p => p.id === plId);
      list = pl ? pl.tracks : [];
    }
    if (!list.length) {
      if (type !== 'results') showToast(t('toastPlaylistEmpty'));
      return;
    }
    if (index < 0) index = list.length - 1;
    if (index >= list.length) index = 0;
    state.playContext = { type: type, index: index, playlistId: plId || null };
    playTrack(list[index], state.playContext);
  }

  function playNext(direction) {
    const list = getActiveList();
    if (!list.length) return;
    let idx = state.playContext.index ?? -1;
    if (idx < 0 || idx >= list.length) idx = 0;

    if (state.playMode === 'single') {
      dom.audio.currentTime = 0;
      dom.audio.play().catch(() => {});
      return;
    }
    if (state.playMode === 'shuffle') {
      if (list.length === 1) {
        idx = 0;
      } else {
        let newIdx;
        do { newIdx = Math.floor(Math.random() * list.length); } while (newIdx === idx);
        idx = newIdx;
      }
    } else {
      idx = (idx + (direction === 'prev' ? -1 : 1) + list.length) % list.length;
    }
    playFromList(state.playContext.type, idx, state.playContext.playlistId);
  }

  function togglePlayPause() {
    if (!dom.audio.src) {
      if (state.currentTrack) showToast(t('toastDownloadNotReady'));
      return;
    }
    if (state.isPlaying) dom.audio.pause();
    else dom.audio.play().catch(e => console.error(e));
  }

  function toggleFavoriteCurrent() {
    const tr = state.currentTrack;
    if (!tr) return;
    const i = state.favorites.findIndex(x => x.uid === tr.uid);
    if (i >= 0) {
      state.favorites.splice(i, 1);
      showToast(t('toastRemovedFavorite'));
    } else {
      state.favorites.push(tr);
      showToast(t('toastAddedFavorite'));
    }
    saveLibraryToStorage();
    updateMainFavButton();
    renderPlaylistList();
  }

  function handleDownloadCurrent() {
    const tr = state.currentTrack;
    if (!tr || !tr.audioUrl) {
      showToast(t('toastDownloadNotReady'));
      return;
    }
    const a = document.createElement('a');
    a.href = tr.audioUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function addCurrentToPlaylist() {
    const plId = dom.playlistSelect.value;
    if (!plId) {
      showToast(t('toastNeedPlaylistSelected'));
      return;
    }
    const track = state.currentTrack;
    if (!track) {
      showToast(t('toastNoCurrentTrack'));
      return;
    }
    const pl = state.playlists.find(p => p.id === plId);
    if (!pl) {
      showToast(t('toastNeedPlaylistSelected'));
      return;
    }
    if (pl.tracks.some(tk => tk.uid === track.uid)) {
      showToast(t('toastAlreadyInList'));
      return;
    }
    pl.tracks.push(track);
    saveLibraryToStorage();
    renderPlaylistList();
    showToast(t('toastAddedToPlaylist'));
  }

  function deleteSelectedPlaylist() {
    const plId = dom.playlistSelect.value;
    if (!plId) {
      showToast(t('toastNeedPlaylistSelected'));
      return;
    }
    const idx = state.playlists.findIndex(p => p.id === plId);
    if (idx < 0) {
      showToast(t('toastNeedPlaylistSelected'));
      return;
    }
    if (!window.confirm(t('confirmDeletePlaylist'))) return;

    state.playlists.splice(idx, 1);
    const next = state.playlists[Math.min(idx, state.playlists.length - 1)] || state.playlists[0] || null;
    state.playContext.playlistId = next ? next.id : null;
    if (state.playContext.type === 'playlist' && !next) {
      state.playContext.index = -1;
    }
    renderPlaylistOptions();
    if (next) dom.playlistSelect.value = next.id;
    saveLibraryToStorage();
    renderPlaylistList();
    showToast(t('toastPlaylistDeleted'));
  }

  function removeTrackFromCurrentPlaylist(trackUid) {
    const plId = dom.playlistSelect.value;
    const pl = state.playlists.find(p => p.id === plId);
    if (!pl) return;
    const idx = pl.tracks.findIndex(tk => tk.uid === trackUid);
    if (idx < 0) return;
    if (!window.confirm(t('confirmRemoveTrack'))) return;

    const removed = pl.tracks.splice(idx, 1)[0];
    if (state.playContext.type === 'playlist' && state.playContext.playlistId === plId) {
      if (state.currentTrack && removed && state.currentTrack.uid === removed.uid) {
        state.playContext.index = pl.tracks.length ? Math.min(idx, pl.tracks.length - 1) : -1;
      } else if (idx < state.playContext.index) {
        state.playContext.index -= 1;
      } else if (state.playContext.index >= pl.tracks.length) {
        state.playContext.index = pl.tracks.length - 1;
      }
    }
    saveLibraryToStorage();
    renderPlaylistList();
    showToast(t('toastTrackRemovedFromPlaylist'));
  }

  /* ============================ 渲染 ============================ */

  function renderMiniSearchList() {
    const wrap = dom.searchMiniList;
    wrap.innerHTML = '';
    const out = getInterleavedSearchList();
    out.forEach((track, i) => {
      const item = document.createElement('div');
      item.className = 'search-mini-item ripple-target';
      item.setAttribute('role', 'button');
      item.tabIndex = 0;

      const meta = document.createElement('div');
      meta.className = 'mini-meta-main';
      const tt = document.createElement('div');
      tt.className = 'mini-title';
      tt.textContent = track.title || 'Unknown';
      const ar = document.createElement('div');
      ar.className = 'mini-artist';
      ar.textContent = track.artist || '';
      meta.appendChild(tt);
      meta.appendChild(ar);

      const right = document.createElement('div');
      right.className = 'mini-right';
      const badge = document.createElement('div');
      badge.className = 'mini-badge';
      badge.textContent = '#' + (i + 1);
      const src = document.createElement('div');
      src.className = 'mini-source';
      const dot = document.createElement('span');
      dot.className = 'source-dot ' + track.source;
      const txt = document.createElement('span');
      txt.textContent = t(sourceLabelKey(track.source));
      src.appendChild(dot);
      src.appendChild(txt);
      right.appendChild(badge);
      right.appendChild(src);

      item.appendChild(meta);
      item.appendChild(right);

      const play = () => {
        const visible = getInterleavedSearchList();
        const idx = visible.findIndex(x => x.uid === track.uid);
        playFromList('results', idx);
      };
      item.addEventListener('click', play);
      item.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          play();
        }
      });
      wrap.appendChild(item);
    });
  }

  function updatePlaylistInfoLabel() {
    const tab = document.querySelector('.playlist-tab.active')?.dataset.tab || 'results';
    if (!dom.playlistInfo) return;
    if (tab === 'results') dom.playlistInfo.textContent = t('playlistInfoResults');
    else if (tab === 'favorites') dom.playlistInfo.textContent = t('playlistInfoFavorites');
    else {
      const pl = state.playlists.find(p => p.id === dom.playlistSelect.value);
      const base = t('playlistInfoPlaylist');
      dom.playlistInfo.textContent = pl ? (base + ' · ' + pl.name) : base;
    }
  }

  function renderPlaylistList() {
    const wrap = dom.playlistList;
    wrap.innerHTML = '';
    const activeTab = document.querySelector('.playlist-tab.active')?.dataset.tab || 'results';
    let list = [];
    if (activeTab === 'results') {
      list = getInterleavedSearchList();
      if (!list.length && state.searchResults.length) {
        list = [...state.searchResults];
      }
      dom.playlistSelectRow.style.display = 'none';
    } else if (activeTab === 'favorites') {
      list = state.favorites;
      dom.playlistSelectRow.style.display = 'none';
    } else {
      dom.playlistSelectRow.style.display = 'flex';
      renderPlaylistOptions();
      if (!state.playlists.length) {
        updatePlaylistInfoLabel();
        dom.playlistMain.classList.remove('has-tracks');
        return;
      }
      const pl = state.playlists.find(p => p.id === dom.playlistSelect.value) || state.playlists[0];
      dom.playlistSelect.value = pl.id;
      state.playContext.playlistId = pl.id;
      list = pl.tracks;
    }
    updatePlaylistInfoLabel();
    dom.playlistMain.classList.toggle('has-tracks', list.length > 0);

    list.forEach((track, idx) => {
      const item = document.createElement('div');
      item.className = 'track-item ripple-target';
      if (state.currentTrack && state.currentTrack.uid === track.uid) item.classList.add('playing');

      const index = document.createElement('div');
      index.className = 'track-index';
      index.textContent = idx + 1;

      const meta = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'track-meta-title';
      title.textContent = track.title || 'Unknown';
      const sub = document.createElement('div');
      sub.className = 'track-meta-sub';
      const aSpan = document.createElement('span');
      aSpan.textContent = track.artist || '';
      const sSpan = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'source-dot ' + track.source;
      const txt = document.createElement('span');
      txt.textContent = t(sourceLabelKey(track.source));
      sSpan.appendChild(dot);
      sSpan.appendChild(txt);
      sub.appendChild(aSpan);
      sub.appendChild(sSpan);
      meta.appendChild(title);
      meta.appendChild(sub);

      const act = document.createElement('div');
      act.className = 'track-actions';
      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'btn btn-secondary btn-icon ripple-target';
      pBtn.textContent = '▶';
      pBtn.setAttribute('aria-label', t('ariaPlay'));
      pBtn.title = t('ariaPlay');

      const fBtn = document.createElement('button');
      fBtn.type = 'button';
      fBtn.className = 'btn btn-secondary btn-icon ripple-target';
      fBtn.textContent = '❤';
      fBtn.setAttribute('aria-label', t('ariaFav'));
      fBtn.title = t('ariaFav');
      if (isFavorite(track)) fBtn.classList.add('btn-fav-active');

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-ghost btn-icon ripple-target';
      removeBtn.textContent = '×';
      removeBtn.title = t('removeFromPlaylist');
      removeBtn.setAttribute('aria-label', t('removeFromPlaylist'));

      pBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (activeTab === 'results') {
          const visible = getInterleavedSearchList();
          const i = visible.findIndex(x => x.uid === track.uid);
          playFromList('results', i);
        } else if (activeTab === 'favorites') {
          const i = state.favorites.findIndex(x => x.uid === track.uid);
          playFromList('favorites', i);
        } else {
          const plId = dom.playlistSelect.value;
          const pl = state.playlists.find(p => p.id === plId);
          const i = pl ? pl.tracks.findIndex(x => x.uid === track.uid) : -1;
          playFromList('playlist', i, plId);
        }
      });

      fBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const i = state.favorites.findIndex(x => x.uid === track.uid);
        if (i >= 0) {
          state.favorites.splice(i, 1);
          showToast(t('toastRemovedFavorite'));
        } else {
          state.favorites.push(track);
          showToast(t('toastAddedFavorite'));
        }
        saveLibraryToStorage();
        renderPlaylistList();
        updateMainFavButton();
      });

      removeBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        removeTrackFromCurrentPlaylist(track.uid);
      });

      act.appendChild(pBtn);
      act.appendChild(fBtn);
      if (activeTab === 'playlists') act.appendChild(removeBtn);

      item.appendChild(index);
      item.appendChild(meta);
      item.appendChild(act);
      item.addEventListener('click', () => pBtn.click());
      wrap.appendChild(item);
    });
  }

  /* ============================ 歌单弹窗 ============================ */

  function openPlaylistModal() {
    dom.playlistModal.classList.add('show');
    dom.playlistNameInput.value = '';
    setTimeout(() => dom.playlistNameInput.focus(), 50);
  }

  function closePlaylistModal() {
    dom.playlistModal.classList.remove('show');
  }

  function createPlaylist() {
    let name = dom.playlistNameInput.value.trim();
    if (!name) name = state.language === 'zh' ? '未命名歌单' : 'Untitled Playlist';
    const id = 'pl-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const pl = { id: id, name: name, tracks: [] };
    state.playlists.push(pl);
    state.playContext.playlistId = pl.id;
    renderPlaylistOptions();
    dom.playlistSelect.value = pl.id;
    saveLibraryToStorage();
    closePlaylistModal();
    renderPlaylistList();
    showToast(t('toastPlaylistCreated'));
  }

  /* ============================ 背景粒子 & 水波纹 ============================ */

  function setupParticles() {
    const canvas = $('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const parts = [];
    const N = window.innerWidth < 700 ? 46 : 90;
    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: 1 + Math.random() * 2.5,
        baseR: 1 + Math.random() * 2.5,
        hue: 200 + Math.random() * 120,
        a: 0.22 + Math.random() * 0.3
      });
    }

    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      window.addEventListener('mousemove', e => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      });
    }

    const reduced = isReducedMotion();

    function draw() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const pulse = 1 + audioLevel * 2.2;
      for (const p of parts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.baseR * pulse, 0, Math.PI * 2);
        const light = Math.min(80, 60 + audioLevel * 40);
        ctx.fillStyle = `hsla(${p.hue},70%,${light}%,${p.a})`;
        ctx.fill();
      }
      ctx.lineWidth = 0.45;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i];
          const b = parts[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 100) {
            const al = 0.10 * (1 - d / 100) * (0.6 + audioLevel * 1.5);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(120,160,255,${al})`;
            ctx.stroke();
          }
        }
      }
    }

    if (reduced) {
      draw();
      return;
    }

    function tick() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      const pulse = 1 + audioLevel * 2.2;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.hue += 0.08;
        if (p.x < -40) p.x = window.innerWidth + 40;
        if (p.x > window.innerWidth + 40) p.x = -40;
        if (p.y < -40) p.y = window.innerHeight + 40;
        if (p.y > window.innerHeight + 40) p.y = -40;
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const push = Math.max(0, 140 - dist) / 140;
        p.x += dx * 0.011 * push;
        p.y += dy * 0.011 * push;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.baseR * pulse, 0, Math.PI * 2);
        const light = Math.min(80, 60 + audioLevel * 40);
        ctx.fillStyle = `hsla(${p.hue},70%,${light}%,${p.a})`;
        ctx.fill();
      }
      ctx.lineWidth = 0.45;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i];
          const b = parts[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 100) {
            const al = 0.10 * (1 - d / 100) * (0.6 + audioLevel * 1.5);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(120,160,255,${al})`;
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(tick);
    }
    tick();
  }

  function setupRipple() {
    document.addEventListener('pointerdown', e => {
      const target = e.target.closest('.ripple-target, .btn, .track-item, .search-mini-item');
      if (!target) return;
      if (target.classList.contains('progress-bar-wrapper')) return;

      const rect = target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const max = Math.max(rect.width, rect.height);

      const outer = document.createElement('span');
      outer.className = 'ripple-circle';
      outer.style.left = x + 'px';
      outer.style.top = y + 'px';
      outer.style.width = outer.style.height = (max * 2) + 'px';

      const inner = document.createElement('span');
      inner.className = 'ripple-circle-inner';
      inner.style.left = x + 'px';
      inner.style.top = y + 'px';
      inner.style.width = inner.style.height = (max * 1.4) + 'px';

      target.appendChild(outer);
      target.appendChild(inner);
      setTimeout(() => outer.remove(), 800);
      setTimeout(() => inner.remove(), 800);
    });
  }

  /* ============================ DOM / 事件绑定 ============================ */

  function setupDOM() {
    dom.searchInput = $('search-input');
    dom.searchBtn = $('search-btn');
    dom.limitSelect = $('limit-select');
    dom.loadMoreBtn = $('load-more-btn');
    dom.searchStatus = $('search-status');
    dom.searchCount = $('search-count');
    dom.searchMiniList = $('search-mini-list');

    dom.coverImg = $('cover-img');
    dom.coverPlaceholder = document.querySelector('.cover-placeholder');
    dom.trackTitle = $('track-title');
    dom.trackArtist = $('track-artist');
    dom.trackSourcePill = $('track-source-pill');
    dom.trackQualityPill = $('track-quality-pill');
    dom.playerStatus = $('player-status');
    dom.playBtn = $('play-btn');
    dom.prevBtn = $('prev-btn');
    dom.nextBtn = $('next-btn');
    dom.favBtn = $('fav-btn');
    dom.downloadBtn = $('download-btn');
    dom.audio = $('audio');
    dom.currentTime = $('current-time');
    dom.totalTime = $('total-time');
    dom.progressWrapper = $('progress-bar-wrapper');
    dom.progressBar = $('progress-bar');
    dom.progressHandle = $('progress-handle');
    dom.volumeSlider = $('volume-slider');
    dom.lyricsInner = $('lyrics-inner');
    dom.lyricsContainer = document.querySelector('.lyrics-container');

    dom.playlistMain = document.querySelector('.playlist-main');
    dom.playlistList = $('playlist-list');
    dom.playlistInfo = $('playlist-info');
    dom.playlistSelectRow = $('playlist-select-row');
    dom.playlistSelect = $('playlist-select');
    dom.deletePlaylistBtn = $('delete-playlist-btn');
    dom.newPlaylistBtn = $('new-playlist-btn');
    dom.importPlaylistBtn = $('import-playlist-btn');
    dom.importPlaylistInput = $('import-playlist-input');
    dom.exportPlaylistBtn = $('export-playlist-btn');
    dom.addCurrentBtn = $('add-current-btn');

    dom.playlistModal = $('playlist-modal');
    dom.playlistNameInput = $('playlist-name-input');
    dom.playlistConfirmBtn = $('playlist-confirm-btn');
    dom.playlistCancelBtn = $('playlist-cancel-btn');
    dom.playlistCloseBtn = $('playlist-close');

    dom.shortcutToggleBtn = $('shortcut-toggle-btn');
    dom.shortcutModal = $('shortcut-modal');
    dom.shortcutCloseBtn = $('shortcut-close');
  }

  function setPlaymodeUI() {
    document.querySelectorAll('.playmode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === state.playMode);
      btn.setAttribute('aria-pressed', btn.dataset.mode === state.playMode ? 'true' : 'false');
    });
  }

  function updateTabsUI(activeTab) {
    document.querySelectorAll('.playlist-tab').forEach(el => {
      const active = el === activeTab;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  function seekToRatio(ratio) {
    const dur = dom.audio.duration || 0;
    if (!(dur > 0)) return;
    const r = Math.min(1, Math.max(0, ratio));
    dom.audio.currentTime = dur * r;
    updateProgressUI(dom.audio.currentTime, dur);
  }

  function seekToClientX(clientX) {
    const rect = dom.progressWrapper.getBoundingClientRect();
    if (!rect.width) return;
    seekToRatio((clientX - rect.left) / rect.width);
  }

  function setupProgressDrag() {
    dom.progressWrapper.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      progressDragging = true;
      try { dom.progressWrapper.setPointerCapture(e.pointerId); } catch (err) {}
      seekToClientX(e.clientX);
    });
    dom.progressWrapper.addEventListener('pointermove', e => {
      if (!progressDragging) return;
      seekToClientX(e.clientX);
    });
    const endDrag = e => {
      if (!progressDragging) return;
      progressDragging = false;
      try { dom.progressWrapper.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    dom.progressWrapper.addEventListener('pointerup', endDrag);
    dom.progressWrapper.addEventListener('pointercancel', endDrag);
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play', () => dom.audio.play().catch(() => {}));
      navigator.mediaSession.setActionHandler('pause', () => dom.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playNext('prev'));
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext('next'));
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        dom.audio.currentTime = Math.max(0, (dom.audio.currentTime || 0) - 10);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        dom.audio.currentTime = (dom.audio.currentTime || 0) + 10;
      });
    } catch (e) {
      // 浏览器不支持某些 action，忽略
    }
  }

  function setupEvents() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
    });

    dom.searchBtn.addEventListener('click', () => {
      state.searchKeyword = dom.searchInput.value.trim();
      state.noMoreResults = false;
      searchAllSources(true);
    });

    dom.searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        state.searchKeyword = dom.searchInput.value.trim();
        state.noMoreResults = false;
        searchAllSources(true);
      }
    });

    document.querySelectorAll('.source-chip input').forEach(cb => {
      cb.addEventListener('change', () => {
        state.enabledSources[cb.dataset.source] = cb.checked;
      });
    });

    dom.limitSelect.addEventListener('change', () => {
      state.perSourceLimit = parseInt(dom.limitSelect.value, 10) || 10;
    });

    dom.loadMoreBtn.addEventListener('click', () => {
      const enabled = Object.keys(state.enabledSources).filter(k => state.enabledSources[k]);
      if (!enabled.length) {
        showToast(t('searchStatusNoSource'));
        return;
      }
      if (state.searchInProgress) return;

      enabled.forEach(s => {
        if (s === 'netease') {
          state.perSourcePage.netease = (state.perSourcePage.netease || 1) + 1;
        } else {
          state.perSourceCurrentLimit[s] = (state.perSourceCurrentLimit[s] || state.perSourceLimit) + state.perSourceLimit;
        }
      });

      state.noMoreResults = false;
      searchAllSources(false);
    });

    dom.searchMiniList.addEventListener('scroll', () => {
      if (!canAutoLoadMore()) return;
      if (dom.searchMiniList.scrollTop + dom.searchMiniList.clientHeight >= dom.searchMiniList.scrollHeight - 10) {
        requestMoreResults();
      }
    }, { passive: true });

    dom.playlistMain.addEventListener('scroll', () => {
      const activeTab = document.querySelector('.playlist-tab.active')?.dataset.tab || 'results';
      if (activeTab !== 'results') return;
      if (!canAutoLoadMore()) return;
      if (dom.playlistMain.scrollTop + dom.playlistMain.clientHeight >= dom.playlistMain.scrollHeight - 10) {
        requestMoreResults();
      }
    }, { passive: true });

    // 手机端播放列表在自身容器内滚动，滚到底部时自动加载更多结果
    dom.playlistList.addEventListener('scroll', () => {
      const activeTab = document.querySelector('.playlist-tab.active')?.dataset.tab || 'results';
      if (activeTab !== 'results') return;
      if (!canAutoLoadMore()) return;
      if (dom.playlistList.scrollTop + dom.playlistList.clientHeight >= dom.playlistList.scrollHeight - 10) {
        requestMoreResults();
      }
    }, { passive: true });

    dom.playBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => playNext('prev'));
    dom.nextBtn.addEventListener('click', () => playNext('next'));
    dom.favBtn.addEventListener('click', toggleFavoriteCurrent);
    dom.downloadBtn.addEventListener('click', handleDownloadCurrent);

    dom.volumeSlider.addEventListener('input', () => {
      dom.audio.volume = parseFloat(dom.volumeSlider.value);
      if (dom.audio.volume > 0 && state.muted) {
        state.muted = false;
        dom.audio.muted = false;
      }
    });

    dom.audio.addEventListener('timeupdate', () => {
      const cur = dom.audio.currentTime || 0;
      const dur = dom.audio.duration || 0;
      updateProgressUI(cur, dur);
      const intensity = Math.abs(Math.sin(cur * 2.3));
      audioLevel = 0.3 + 0.7 * intensity * (dom.audio.volume || 1);
      updateLyricsHighlight(cur);
    });

    dom.audio.addEventListener('loadedmetadata', () => {
      updateProgressUI(dom.audio.currentTime || 0, dom.audio.duration || 0);
    });

    dom.audio.addEventListener('play', () => {
      state.isPlaying = true;
      updatePlayButtonUI();
      setPlayerStatus('playerStatusPlaying');
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    });

    dom.audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updatePlayButtonUI();
      setPlayerStatus('playerStatusPaused');
      audioLevel = 0;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    });

    dom.audio.addEventListener('ended', () => {
      audioLevel = 0;
      playNext('next');
    });

    dom.audio.addEventListener('error', () => {
      if (!dom.audio.src) return;
      console.warn('audio error', dom.audio.error);
      if (Date.now() - lastPlayErrorAt < 4000) return;
      lastPlayErrorAt = Date.now();
      state.isPlaying = false;
      updatePlayButtonUI();
      setPlayerStatus('playerStatusIdle');
      showToast(t('toastPlayError'));
    });

    setupProgressDrag();
    setupMediaSession();

    document.querySelectorAll('.playlist-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        updateTabsUI(tab);
        const tName = tab.dataset.tab;
        if (tName === 'results') {
          state.playContext.type = 'results';
          state.playContext.playlistId = null;
        } else if (tName === 'favorites') {
          state.playContext.type = 'favorites';
          state.playContext.playlistId = null;
        } else {
          state.playContext.type = 'playlist';
          if (state.playlists.length && !state.playContext.playlistId) state.playContext.playlistId = state.playlists[0].id;
        }
        renderPlaylistList();
        const list = getActiveList();
        if (!state.currentTrack && list.length) playFromList(state.playContext.type, 0, state.playContext.playlistId);
      });
    });

    dom.deletePlaylistBtn.addEventListener('click', deleteSelectedPlaylist);
    dom.newPlaylistBtn.addEventListener('click', openPlaylistModal);
    dom.importPlaylistBtn.addEventListener('click', () => dom.importPlaylistInput.click());
    dom.importPlaylistInput.addEventListener('change', handleImportPlaylistFile);
    dom.exportPlaylistBtn.addEventListener('click', exportPlaylistData);
    dom.playlistConfirmBtn.addEventListener('click', createPlaylist);
    dom.playlistCancelBtn.addEventListener('click', closePlaylistModal);
    dom.playlistCloseBtn.addEventListener('click', closePlaylistModal);
    dom.playlistModal.addEventListener('click', e => {
      if (e.target === dom.playlistModal) closePlaylistModal();
    });
    dom.playlistNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        createPlaylist();
      }
    });
    dom.playlistSelect.addEventListener('change', () => {
      state.playContext.playlistId = dom.playlistSelect.value;
      renderPlaylistList();
    });
    dom.addCurrentBtn.addEventListener('click', addCurrentToPlaylist);

    dom.shortcutToggleBtn.addEventListener('click', () => {
      dom.shortcutModal.classList.add('show');
    });
    dom.shortcutCloseBtn.addEventListener('click', () => {
      dom.shortcutModal.classList.remove('show');
    });
    dom.shortcutModal.addEventListener('click', e => {
      if (e.target === dom.shortcutModal) dom.shortcutModal.classList.remove('show');
    });

    document.querySelectorAll('.playmode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.playMode = btn.dataset.mode;
        setPlaymodeUI();
        if (state.playMode === 'list') showToast(t('toastPlaymodeList'));
        else if (state.playMode === 'single') showToast(t('toastPlaymodeSingle'));
        else showToast(t('toastPlaymodeShuffle'));
      });
    });

    document.addEventListener('keydown', e => {
      const active = document.activeElement;
      const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (active && active.isContentEditable);
      // 焦点在按钮 / 链接 / role=button 上时，Space 交给元素自身处理，避免“原生点击 + 全局快捷键”双重触发
      const nativeSpaceTarget = !!(active && (tag === 'button' || tag === 'a' || active.getAttribute('role') === 'button'));
      const playlistOpen = dom.playlistModal.classList.contains('show');
      const shortcutOpen = dom.shortcutModal.classList.contains('show');

      if (e.key === 'Escape') {
        if (playlistOpen) closePlaylistModal();
        if (shortcutOpen) dom.shortcutModal.classList.remove('show');
        return;
      }

      if (playlistOpen || shortcutOpen) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === 'Space' && !typing && !nativeSpaceTarget) {
        e.preventDefault();
        togglePlayPause();
      }
      if (e.key === 'ArrowRight' && !typing) {
        e.preventDefault();
        dom.audio.currentTime = (dom.audio.currentTime || 0) + 5;
      }
      if (e.key === 'ArrowLeft' && !typing) {
        e.preventDefault();
        dom.audio.currentTime = Math.max(0, (dom.audio.currentTime || 0) - 5);
      }
      if (e.key === 'ArrowUp' && !typing) {
        e.preventDefault();
        dom.audio.volume = Math.min(1, (dom.audio.volume || 0) + 0.05);
        dom.volumeSlider.value = dom.audio.volume;
      }
      if (e.key === 'ArrowDown' && !typing) {
        e.preventDefault();
        dom.audio.volume = Math.max(0, (dom.audio.volume || 0) - 0.05);
        dom.volumeSlider.value = dom.audio.volume;
      }
      if ((e.key === 'n' || e.key === 'N') && !typing) playNext('next');
      if ((e.key === 'p' || e.key === 'P') && !typing) playNext('prev');
      if ((e.key === 'f' || e.key === 'F') && !typing) toggleFavoriteCurrent();
      if ((e.key === 'l' || e.key === 'L') && !typing) {
        state.lyricsAlt = !state.lyricsAlt;
        dom.lyricsContainer.classList.toggle('alt-style', state.lyricsAlt);
        showToast(t('toastLyricStyleSwitched'));
      }
      if ((e.key === 'm' || e.key === 'M') && !typing) {
        state.muted = !state.muted;
        dom.audio.muted = state.muted;
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        dom.searchInput.focus();
        dom.searchInput.select();
      }
    });
  }

  /* ============================ 初始化 ============================ */

  function init() {
    setupDOM();
    try {
      const lg = localStorage.getItem(LANG_STORAGE_KEY);
      if (lg) state.language = lg;
    } catch (e) {}
    loadLibraryFromStorage();
    setupParticles();
    setupRipple();
    setupEvents();
    setLanguage(state.language);
    renderPlaylistOptions();
    renderPlaylistList();
    setPlaymodeUI();
    dom.audio.volume = parseFloat(dom.volumeSlider.value) || 0.8;
    updatePlayButtonUI();
    updateMainFavButton();
    updateProgressUI(0, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

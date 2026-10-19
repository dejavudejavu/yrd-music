/*
 * 音乐平台接口层
 * ---------------------------------------------------------------------------
 * 说明：接口地址、参数与调用方式与原站（charlespikachu/musicsquare）完全一致，
 * 仅把各平台搜索函数改为返回歌曲数组，由 app.js 统一去重与渲染。
 *
 *   网易云：https://api.qijieya.cn/meting/
 *   QQ音乐：https://tang.api.s01s.cn/music_open_api.php
 *   酷我：  https://oiapi.net/api/Kuwo
 *   JOOX：  https://apicx.asia/api/joox_music
 */
(function () {
  'use strict';

  const JOOX_TOKEN = 'f84ao9lMF_q7husBWRfgUw';
  const JOOX_BR = 4;

  /* ============================ 工具函数 ============================ */

  function pickQueryParam(rawUrl, key) {
    if (!rawUrl) return '';
    try {
      return new URL(rawUrl, window.location.href).searchParams.get(key) || '';
    } catch (e) {
      const m = String(rawUrl).match(new RegExp('[?&]' + key + '=([^&]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    }
  }

  function inferQualityFromUrl(url) {
    if (!url) return { tag: null, label: '' };
    const base = url.split('?')[0].toLowerCase();
    const m = base.match(/\.([a-z0-9]+)$/);
    const ext = m ? m[1] : '';
    const losslessExts = ['flac', 'wav', 'ape', 'alac', 'aiff'];
    if (losslessExts.includes(ext)) {
      return { tag: 'lossless', label: 'LOSSLESS' };
    }
    // 其他一律当作 320K 显示
    return { tag: '320k', label: '320K' };
  }

  // GitHub Pages 等 HTTPS 站点会拦截 http 音频（混合内容），统一升级为 https。
  function toHttps(url) {
    return typeof url === 'string' && /^http:\/\//i.test(url) ? url.replace(/^http:/i, 'https:') : url;
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  /* ============================ 网易云 ============================ */

  // 网易云搜索：qijieya meting search
  async function searchNetease(kw, page, num) {
    const requestLimit = Math.max(1, page || 1) * Math.max(1, num || 10);
    const url = `https://api.qijieya.cn/meting/?type=search&id=${encodeURIComponent(kw)}&limit=${encodeURIComponent(requestLimit)}&server=netease`;
    const out = [];

    try {
      const json = await fetchJSON(url);
      if (!Array.isArray(json)) return out;

      json.forEach((it, idx) => {
        const songId = pickQueryParam(it.url, 'id') || `${kw}-${idx + 1}`;
        out.push({
          uid: `netease-${songId}`,
          source: 'netease',
          displayIndex: idx + 1,
          keyword: kw,

          songid: songId,
          title: it.name || '',
          artist: it.artist || '',
          album: '',

          cover: toHttps(it.pic) || null,
          audioUrl: toHttps(it.url) || null,
          lrc: null,
          lrcUrl: toHttps(it.lrc) || null,

          detailsLoaded: false,
          quality: null,
          qualityLabel: null
        });
      });
    } catch (e) {
      console.error('netease(qijieya meting)', e);
    }
    return out;
  }

  /* ============================ QQ 音乐 ============================ */

  // QQ 搜索：tang 的 QQ 音乐搜索 API（只拿列表，不拿 url）
  async function searchQQ(kw, limit) {
    const url =
      `https://tang.api.s01s.cn/music_open_api.php` +
      `?msg=${encodeURIComponent(kw)}` +
      `&type=json`;
    const out = [];

    try {
      const json = await fetchJSON(url);
      // 兼容：既支持直接数组，也支持 { data: [...] } 这种包装
      const data = Array.isArray(json) ? json : (Array.isArray(json && json.data) ? json.data : []);
      if (!data.length) return out;

      data.slice(0, limit || data.length).forEach((it, idx) => {
        const mid = it.song_mid;
        if (!mid) return;

        const indexInList = idx + 1; // 1-based：作为 qqIndex / displayIndex

        out.push({
          uid: `qq-${mid}`,
          source: 'qq',

          // 用于交错显示的排序
          displayIndex: indexInList,

          // 记录检索关键词（详情再请求要用同一个 msg）
          keyword: kw,
          qqSearchKey: kw,

          // 这首在 QQ 搜索结果里的序号，用作 n
          qqIndex: indexInList,

          // 元信息
          qqId: mid,
          songid: mid,
          songMid: mid,

          title: it.song_title || '',
          artist: it.singer_name || '',
          album: '',

          cover: null, // 新接口没给封面

          // 搜索阶段没有 url 和 lrc
          audioUrl: null,
          lrc: null,
          lrcUrl: null,

          detailsLoaded: false,

          quality: null,
          qualityLabel: null,

          // 新接口返回 pay（如“付费”）
          qqQualityText: it.pay || null,
          pay: it.pay || null
        });
      });
    } catch (e) {
      console.error('qq search (tang)', e);
    }

    return out;
  }

  /* ============================ 酷我 ============================ */

  // 酷我搜索：OIAPI
  async function searchKuwo(kw, limit) {
    const url = `https://oiapi.net/api/Kuwo?msg=${encodeURIComponent(kw)}&page=1&limit=${encodeURIComponent(limit)}`;
    const out = [];

    try {
      const json = await fetchJSON(url);
      const data = Array.isArray(json && json.data) ? json.data : [];
      if (!data.length) return out;

      data.forEach((it, idx) => {
        const rid = (it.rid ?? '').toString();
        if (!rid) return;

        out.push({
          uid: `kuwo-${rid}`,
          source: 'kuwo',
          displayIndex: idx + 1,
          keyword: kw,
          songid: rid,

          title: it.song || '',
          artist: it.singer || '',
          album: it.album || '',

          cover: toHttps(it.picture) || null,
          audioUrl: null,
          lrc: null,
          lrcUrl: null,
          detailsLoaded: false,
          quality: null,
          qualityLabel: null
        });
      });
    } catch (e) {
      console.error('kuwo search (OIAPI)', e);
    }
    return out;
  }

  /* ============================ JOOX ============================ */

  async function searchJoox(kw, limit) {
    const url = `https://apicx.asia/api/joox_music?msg=${encodeURIComponent(kw)}&token=${encodeURIComponent(JOOX_TOKEN)}&br=${encodeURIComponent(JOOX_BR)}`;
    const out = [];

    try {
      const json = await fetchJSON(url);
      const songs = json && json.code === 200 && json.data && Array.isArray(json.data.songs) ? json.data.songs : [];
      songs.slice(0, limit || songs.length).forEach((it, idx) => {
        const songMid = it.songmid || '';
        const songId = it['歌曲ID'] || songMid || (idx + 1);

        out.push({
          uid: `joox-${songMid || songId}`,
          source: 'joox',
          displayIndex: idx + 1,
          keyword: kw,
          jooxIndex: idx + 1,
          songid: songId,
          songMid: songMid,

          title: it['歌曲名称'] || '',
          artist: it['歌手'] || '',
          album: it['专辑'] || '',

          cover: null,
          audioUrl: null,
          lrc: it['歌词内容'] || null,
          lrcUrl: null,
          detailsLoaded: false,
          quality: null,
          qualityLabel: null
        });
      });
    } catch (e) {
      console.error('joox search', e);
    }
    return out;
  }

  /* ============================ 各平台详情 ============================ */

  // 网易云详情：搜索结果已返回播放、封面、歌词接口，这里只补全缓存歌曲和歌词内容
  async function fetchNeteaseDetails(track) {
    if (track.songid) {
      if (!track.audioUrl) {
        track.audioUrl = `https://api.qijieya.cn/meting/?server=netease&type=url&id=${encodeURIComponent(track.songid)}`;
      }
      if (!track.lrcUrl) {
        track.lrcUrl = `https://api.qijieya.cn/meting/?server=netease&type=lrc&id=${encodeURIComponent(track.songid)}`;
      }
    }

    if (track.audioUrl) {
      const q = inferQualityFromUrl(track.audioUrl);
      track.quality = q.tag;
      track.qualityLabel = q.label;
    }

    if (!track.lrc && track.lrcUrl) {
      try {
        const lr = await fetch(track.lrcUrl);
        const contentType = (lr.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('json')) {
          const lj = await lr.json();
          track.lrc =
            (typeof lj === 'string' ? lj : null) ||
            (lj && lj.lrc) ||
            (lj && lj.lyric) ||
            (lj && lj.data && lj.data.lrc) ||
            (lj && lj.data && lj.data.lyric) ||
            (lj && typeof lj.data === 'string' ? lj.data : null) ||
            track.lrc ||
            null;
        } else {
          track.lrc = await lr.text();
        }
      } catch (e) {
        console.warn('netease(qijieya meting) lyric fetch failed', e);
      }
    }

    track.detailsLoaded = true;
  }

  function pickBestQQPlayUrl(d) {
    // lossless
    if (d.song_play_url_sq) return { url: d.song_play_url_sq, tag: 'lossless', label: 'LOSSLESS', text: `SQ ${d.kbps_sq || ''}`.trim() };
    if (d.song_play_url_pq) return { url: d.song_play_url_pq, tag: 'lossless', label: 'LOSSLESS', text: `PQ ${d.kbps_pq || ''}`.trim() };

    // other variants
    if (d.song_play_url_accom) return { url: d.song_play_url_accom, tag: 'hq', label: 'HQ', text: `ACCOM ${d.kbps_accom || ''}`.trim() };
    if (d.song_play_url_hq) return { url: d.song_play_url_hq, tag: 'hq', label: 'HQ', text: `HQ ${d.kbps_hq || ''}`.trim() };

    if (d.song_play_url_standard) return { url: d.song_play_url_standard, tag: 'standard', label: 'STD', text: `STD ${d.kbps_standard || ''}`.trim() };
    if (d.song_play_url_fq) return { url: d.song_play_url_fq, tag: 'low', label: 'LOW', text: `FQ ${d.kbps_fq || ''}`.trim() };

    // fallback
    if (d.song_play_url) return { url: d.song_play_url, tag: null, label: null, text: null };

    return { url: null, tag: null, label: null, text: null };
  }

  // QQ 详情：根据搜索时的关键词 + song_mid(mid) 拿 url + lrc（tang API）
  async function fetchQQDetails(track) {
    // 优先用搜索时用过的关键词，保证和原始排序一致
    const msg =
      (track.qqSearchKey || track.keyword || '').trim() ||
      ((track.title || '') + ' ' + (track.artist || '')).trim();

    // 新接口用 mid：优先 qqId/songMid/songid
    const mid = (track.qqId || track.songMid || track.songid || '').toString().trim();
    if (!mid) return;

    const url =
      `https://tang.api.s01s.cn/music_open_api.php` +
      `?msg=${encodeURIComponent(msg)}` +
      `&type=json` +
      `&mid=${encodeURIComponent(mid)}`;

    try {
      const d = await fetchJSON(url);

      // 基本校验：必须是对象且有 song_mid
      if (!d || typeof d !== 'object' || !d.song_mid) {
        throw new Error('qq detail error (invalid response)');
      }

      // 更新基础信息
      track.title = d.song_title || d.song_name || track.title;
      track.artist = d.singer_name || track.artist;
      track.album = d.album_name || d.album_title || track.album || '';
      track.cover = toHttps(d.album_pic || d.singer_pic || track.cover);
      track.pageUrl = toHttps(d.song_h5_url || track.pageUrl);

      // 播放链接（按优先级挑一个）
      const best = pickBestQQPlayUrl(d);
      track.audioUrl = toHttps(best.url) || track.audioUrl;

      // 歌词
      track.lrc = d.song_lyric || d.lyric || track.lrc;

      // 文本信息
      track.qqQualityText = best.text || (d.vip ? `VIP:${d.vip}` : null) || track.qqQualityText;

      // quality / label：先用我们自己的选择，再用 URL 兜底
      if (best.tag && best.label) {
        track.quality = best.tag;
        track.qualityLabel = best.label;
      }

      if (track.audioUrl) {
        const q = inferQualityFromUrl(track.audioUrl);
        if (q && q.label) {
          track.quality = q.tag;
          track.qualityLabel = q.label;
        }
      }

      track.detailsLoaded = true;
    } catch (e) {
      console.error('qq detail (tang)', e);
      // 失败的话不要把 detailsLoaded 置 true，下次还有机会重试
    }
  }

  async function fetchKuwoDetails(track) {
    const n = track.displayIndex || 1;
    const api = `https://oiapi.net/api/Kuwo?msg=${encodeURIComponent(track.keyword)}&n=${encodeURIComponent(n)}&br=1`;
    const j = await fetchJSON(api);
    if (!j || !j.data || Array.isArray(j.data)) throw new Error('kuwo OIAPI detail failed');

    const d = j.data;
    Object.assign(track, {
      title: d.song || track.title,
      artist: d.singer || track.artist,
      album: d.album || track.album,
      cover: toHttps(d.picture) || track.cover,
      songid: (d.rid ?? track.songid),
      audioUrl: toHttps(d.url) || track.audioUrl,
      lrc: d.lyric || d.lrc || d.lyrics || track.lrc || null,
      lrcUrl: null,
      detailsLoaded: true
    });

    // OIAPI br=1 请求无损；优先根据接口返回的 level / format 判断，URL 后缀作为兜底
    const qualityText = `${d.level || ''} ${d.format || ''}`.toLowerCase();
    if (/lossless|无损|flac|wav|ape|alac|aiff|zp|sq/.test(qualityText)) {
      track.quality = 'lossless';
      track.qualityLabel = 'LOSSLESS';
    } else if (track.audioUrl) {
      const q = inferQualityFromUrl(track.audioUrl);
      track.quality = q.tag;
      track.qualityLabel = q.label;
    }
  }

  // 逐级探测 JOOX 播放链接：HEAD 优先，失败再试 Range GET
  async function probeJooxAudioUrl(u) {
    if (!u) return false;

    async function request(method, extraOptions) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(u, Object.assign({
          method,
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        }, extraOptions || {}));
        return res && (res.ok || res.status === 206 || (res.status >= 200 && res.status < 400));
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      if (await request('HEAD')) return true;
    } catch (e) {
      // 部分音乐 CDN 不允许 HEAD，改用很小的 Range GET
    }

    try {
      return await request('GET', { headers: { Range: 'bytes=0-0' } });
    } catch (e) {
      return false;
    }
  }

  async function fetchJooxDetails(track) {
    const n = track.jooxIndex || track.displayIndex || 1;
    const url = `https://apicx.asia/api/joox_music?msg=${encodeURIComponent(track.keyword)}&n=${encodeURIComponent(n)}&token=${encodeURIComponent(JOOX_TOKEN)}&br=${encodeURIComponent(JOOX_BR)}`;
    const j = await fetchJSON(url);
    if (!j || j.code !== 200 || !j.data) throw new Error('joox detail failed');

    const d = j.data;
    const playLinks = d['播放链接'] || {};

    const order = ['Atmos全景声', '无损FLAC', 'Hi-Res无损', '母带无损', 'OGG 320', 'MP3 320', 'AAC 192', 'OGG 192', 'MP3 128', 'AAC 96', 'AAC 48'];

    // 并行探测，避免逐个 3 秒超时导致等待过久
    const candidates = order
      .filter(name => !!playLinks[name])
      .map(name => ({ name: name, url: playLinks[name] }));

    const probes = await Promise.all(candidates.map(c => probeJooxAudioUrl(c.url).catch(() => false)));
    const available = candidates.filter((c, i) => probes[i]);

    // 若全部探测失败（常见于 CDN 禁止跨域探测），仍回退到优先级别的第一条链接，
    // 交给 <audio> 实际播放来判断，避免“有链接却无法播放”。
    const pool = available.length ? available : candidates;
    const best = pickJooxPlayUrlFromPool(pool);

    Object.assign(track, {
      title: d['歌曲名称'] || track.title,
      artist: d['歌手'] || track.artist,
      album: d['专辑'] || track.album,
      songid: d['歌曲ID'] || track.songid,
      songMid: d.songmid || track.songMid,
      audioUrl: toHttps(best.url) || track.audioUrl,
      lrc: d['歌词内容'] || track.lrc || null,
      lrcUrl: null,
      jooxQualityText: best.text || track.jooxQualityText || null,
      detailsLoaded: true
    });

    if (best.tag && best.label) {
      track.quality = best.tag;
      track.qualityLabel = best.label;
    } else if (track.audioUrl) {
      const q = inferQualityFromUrl(track.audioUrl);
      track.quality = q.tag;
      track.qualityLabel = q.label;
    }
  }

  function pickJooxPlayUrlFromPool(pool) {
    if (!pool.length) return { url: null, tag: null, label: null, text: null };
    const chosen = pool[0];
    const name = chosen.name;
    const u = chosen.url;

    if (/母带|无损|flac|hi-res|atmos/i.test(name) || /\.flac(?:\?|$)/i.test(u)) {
      return { url: u, tag: 'lossless', label: 'LOSSLESS', text: name };
    }
    const m = name.match(/(\d+)$/);
    if (m) return { url: u, tag: m[1] + 'k', label: m[1] + 'K', text: name };
    return { url: u, tag: null, label: null, text: name };
  }

  /* ============================ 歌词解析 ============================ */

  function parseLRC(txt) {
    if (!txt) return [];
    const lines = txt.split(/\r?\n/);
    const reg = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/;
    const out = [];
    for (const line of lines) {
      const m = reg.exec(line);
      if (!m) continue;
      const min = parseInt(m[1], 10) || 0;
      const sec = parseInt(m[2], 10) || 0;
      const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
      const time = min * 60 + sec + ms / 1000;
      const text = line.replace(reg, '').trim();
      if (text) out.push({ time: time, text: text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /* ============================ 导出 ============================ */

  window.PikachuAPI = {
    JOOX_TOKEN: JOOX_TOKEN,
    JOOX_BR: JOOX_BR,
    inferQualityFromUrl: inferQualityFromUrl,
    toHttps: toHttps,
    pickQueryParam: pickQueryParam,
    parseLRC: parseLRC,

    searchNetease: searchNetease,
    searchQQ: searchQQ,
    searchKuwo: searchKuwo,
    searchJoox: searchJoox,

    fetchNeteaseDetails: fetchNeteaseDetails,
    fetchQQDetails: fetchQQDetails,
    fetchKuwoDetails: fetchKuwoDetails,
    fetchJooxDetails: fetchJooxDetails
  };
})();

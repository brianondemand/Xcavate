// ==UserScript==
// @name         Xcavate
// @namespace    https://github.com/YOUR-USERNAME/Xcavate
// @version      1.1.0
// @description  Download images, videos and GIFs from X (Twitter) posts in one click, with a task queue, ZIP bundling, optional GIF conversion and custom file names.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://m.x.com/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      x.com
// @connect      twimg.com
// @connect      video.twimg.com
// @connect      pbs.twimg.com
// @connect      abs.twimg.com
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Xcavate
 * A media-only derivative of "BetterX" by 流萤可爱捏 (Iskongkongyo), MIT licensed.
 * Everything except the media download feature was removed; the download pipeline
 * (network capture, queue, ZIP writer, GIF encoder) was kept and reworked.
 *
 * Sections: 1 Utils · 2 Settings · 3 Diagnostics · 4 Media registry + network capture ·
 *           5 On-demand lookup · 6 Naming · 7 Transfer, ZIP, GIF · 8 Job queue ·
 *           9 Page integration · 10 Panel UI · 11 Boot
 */
(function () {
    'use strict';

    const VERSION = '1.1.0';
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    /* ==================================================================
     * 1. UTILS
     * ================================================================== */
    const now = () => Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const uniq = (list) => [...new Set(list.filter(Boolean))];
    const isMobile = () => window.innerWidth <= 640 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    function clampInt(v, min, max, fallback) {
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
    }

    function h(tag, attrs = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of kids.flat()) {
            if (c == null || c === false) continue;
            e.append(c.nodeType ? c : document.createTextNode(String(c)));
        }
        return e;
    }

    function fmtBytes(value) {
        const b = Math.max(0, Number(value) || 0);
        if (b < 1024) return b.toFixed(0) + ' B';
        if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }

    function fmtDate(value) {
        const d = new Date(value || now());
        const date = Number.isFinite(d.getTime()) ? d : new Date();
        const p = (n) => String(n).padStart(2, '0');
        return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) + '_' + p(date.getHours()) + '-' + p(date.getMinutes()) + '-' + p(date.getSeconds());
    }

    let toastHost = null;
    function toast(msg, type, ms) {
        const show = () => {
            if (!toastHost) { toastHost = h('div', { class: 'xc-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
            const t = h('div', { class: 'xc-toast ' + (type || '') }, msg);
            toastHost.append(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms || 4000);
        };
        if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
    }

    // Conservative guard for the user-supplied rename regex (file names are short, but still).
    function isSafeRegex(src) {
        if (!src) return true;
        if (src.length > 100) return false;
        if (/\\[1-9k]/.test(src)) return false;
        if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) return false;
        if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) return false;
        try { new RegExp(src, 'g'); return true; } catch (e) { return false; }
    }

    /* ==================================================================
     * 2. SETTINGS
     * ================================================================== */
    const DEFAULTS = {
        zip: true,
        gifFormat: 'mp4',
        gifQuality: 'high',
        trackDownloaded: false,
        fileTemplate: '{handle}_{id}',
        zipTemplate: '{handle}_{id}',
        nameRegex: '',
        nameReplacement: '',
        concurrency: 2,
        timeoutSec: 360,
        networkCapture: true,
        showButton: true,
        fabPos: null
    };

    function sanitizeSettings(raw) {
        const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : DEFAULTS[k]);
        const str = (k, max) => (typeof r[k] === 'string' ? r[k].slice(0, max) : DEFAULTS[k]);
        const regex = str('nameRegex', 100);
        return {
            zip: bool('zip'),
            gifFormat: r.gifFormat === 'gif' ? 'gif' : 'mp4',
            gifQuality: r.gifQuality === 'standard' ? 'standard' : 'high',
            trackDownloaded: bool('trackDownloaded'),
            fileTemplate: str('fileTemplate', 180).trim() || DEFAULTS.fileTemplate,
            zipTemplate: str('zipTemplate', 180).trim() || DEFAULTS.zipTemplate,
            nameRegex: isSafeRegex(regex) ? regex : '',
            nameReplacement: str('nameReplacement', 100),
            concurrency: clampInt(r.concurrency, 1, 6, DEFAULTS.concurrency),
            timeoutSec: clampInt(r.timeoutSec, 5, 600, DEFAULTS.timeoutSec),
            networkCapture: bool('networkCapture'),
            showButton: bool('showButton'),
            fabPos: r.fabPos && Number.isFinite(r.fabPos.right) && Number.isFinite(r.fabPos.bottom)
                ? { right: clampInt(r.fabPos.right, 0, 5000, 16), bottom: clampInt(r.fabPos.bottom, 0, 5000, 84) } : null
        };
    }

    const Settings = {
        data: sanitizeSettings(GM_getValue('xc_settings', {})),
        get(k) { return this.data[k]; },
        patch(partial) {
            this.data = sanitizeSettings(Object.assign({}, this.data, partial));
            GM_setValue('xc_settings', this.data);
        }
    };

    // The "already downloaded" index is stored separately so saving it can never overwrite settings.
    const MAX_DOWNLOADED = 5000;
    const Downloaded = {
        ids: new Set((GM_getValue('xc_downloaded', []) || []).filter((x) => /^\d{1,30}$/.test(String(x))).map(String)),
        has(id) { return Settings.get('trackDownloaded') && this.ids.has(String(id)); },
        add(id) {
            id = String(id);
            if (!/^\d{1,30}$/.test(id)) return;
            this.ids.delete(id);
            this.ids.add(id);
            while (this.ids.size > MAX_DOWNLOADED) this.ids.delete(this.ids.values().next().value);
            GM_setValue('xc_downloaded', [...this.ids]);
        },
        clear() { this.ids.clear(); GM_setValue('xc_downloaded', []); }
    };

    /* ==================================================================
     * 3. DIAGNOSTICS (never logs usernames, text or URLs)
     * ================================================================== */
    const Diag = {
        log: [],
        push(level, area, msg) {
            this.log.push({ t: new Date().toISOString(), level, area, msg: String(msg).replace(/https?:\/\/\S+/g, '<url>') });
            if (this.log.length > 200) this.log.splice(0, 50);
        },
        report() {
            return JSON.stringify({
                version: VERSION,
                userAgent: navigator.userAgent,
                settings: Settings.data,
                registry: { media: mediaRegistry.size, cards: cardRegistry.size, posters: posterRegistry.size },
                hooks: hookCounts,
                log: this.log.slice(-60)
            }, null, 2);
        }
    };

    /* ==================================================================
     * 4. MEDIA REGISTRY + NETWORK CAPTURE
     *    X's own API responses contain the real media URLs. We read them as
     *    they pass through the page's fetch/XHR and remember them by post id.
     * ================================================================== */
    const MAX_REGISTRY = 2000;
    const mediaRegistry = new Map();   // statusId -> { photos, gifs, videos }
    const cardRegistry = new Map();    // statusId -> { photos, gifs, videos } (link cards)
    const posterRegistry = new Map();  // poster key -> { type, url }

    function boundedSet(map, key, value) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        while (map.size > MAX_REGISTRY) map.delete(map.keys().next().value);
    }
    function touchGet(map, key) {
        if (!map.has(key)) return null;
        const v = map.get(key);
        map.delete(key);
        map.set(key, v);
        return v;
    }

    function posterKey(rawUrl) {
        if (!rawUrl) return '';
        try {
            const u = new URL(String(rawUrl), 'https://pbs.twimg.com');
            if (!/(?:^|\.)twimg\.com$/i.test(u.hostname)) return '';
            const dir = u.pathname.match(/\/(amplify_tw_video_thumb|amplify_video_thumb|ext_tw_video_thumb)\/([A-Za-z0-9_-]+)/i);
            if (dir) return dir[1].toLowerCase() + ':' + dir[2];
            const gif = u.pathname.match(/\/tweet_video_thumb\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?$/i);
            return gif ? 'tweet_video_thumb:' + gif[1] : '';
        } catch (e) { return ''; }
    }

    function registerPoster(media, mp4Url) {
        const key = posterKey(media && (media.media_url_https || media.media_url));
        if (!key || !mp4Url) return;
        boundedSet(posterRegistry, key, { type: media.type === 'animated_gif' ? 'gif' : 'video', url: mp4Url });
    }

    function videoArea(url) {
        const m = String(url || '').match(/\/(\d{3,4})x(\d{3,4})\//);
        return m ? Number(m[1]) * Number(m[2]) : 0;
    }
    function videoLabel(url) {
        const m = String(url || '').match(/\/(\d{3,4})x(\d{3,4})\//);
        return m ? m[1] + 'x' + m[2] : 'best available';
    }

    // Highest quality MP4: highest bitrate first, resolution as the tie-breaker.
    function bestMp4(media) {
        const variants = media && media.video_info && Array.isArray(media.video_info.variants) ? media.video_info.variants : [];
        const mp4s = variants.filter((v) => v && v.content_type === 'video/mp4' && v.url);
        mp4s.sort((a, b) => ((b.bitrate || 0) - (a.bitrate || 0)) || (videoArea(b.url) - videoArea(a.url)));
        return mp4s[0] ? mp4s[0].url : '';
    }

    function registerMedia(id, mediaArr) {
        if (!id || !Array.isArray(mediaArr) || !mediaArr.length) return;
        const key = String(id);
        const entry = touchGet(mediaRegistry, key) || { photos: [], gifs: [], videos: [] };
        for (const m of mediaArr) {
            if (!m || typeof m !== 'object') continue;
            if (m.type === 'photo' && m.media_url_https) entry.photos.push(m.media_url_https);
            else if (m.type === 'video' || m.type === 'animated_gif') {
                const url = bestMp4(m);
                if (!url) continue;
                (m.type === 'animated_gif' ? entry.gifs : entry.videos).push(url);
                registerPoster(m, url);
            }
        }
        entry.photos = uniq(entry.photos); entry.gifs = uniq(entry.gifs); entry.videos = uniq(entry.videos);
        boundedSet(mediaRegistry, key, entry);
    }

    function pickEntityMedia(m, acc) {
        if (!m || typeof m !== 'object') return false;
        if (m.type === 'photo' && m.media_url_https) { acc.photos.push(m.media_url_https); return true; }
        if (m.type === 'video' || m.type === 'animated_gif') {
            const url = bestMp4(m);
            if (!url) return false;
            (m.type === 'animated_gif' ? acc.gifs : acc.videos).push(url);
            registerPoster(m, url);
            return true;
        }
        return false;
    }

    function harvestCard(id, card) {
        if (!id || !card || typeof card !== 'object') return;
        const legacy = card.legacy || card;
        const bvs = legacy.binding_values;
        const entries = [];
        if (Array.isArray(bvs)) { for (const e of bvs) if (e && e.key) entries.push(e); }
        else if (bvs && typeof bvs === 'object') { for (const k in bvs) entries.push({ key: k, value: bvs[k] }); }
        if (!entries.length) return;
        const acc = { photos: [], gifs: [], videos: [] };
        const thumbs = [];
        let real = false;
        for (const e of entries) {
            const val = e.value || {};
            if (e.key === 'unified_card' && val.string_value) {
                try {
                    const uc = JSON.parse(val.string_value);
                    const me = uc && uc.media_entities;
                    if (me && typeof me === 'object') for (const mk in me) if (pickEntityMedia(me[mk], acc)) real = true;
                } catch (err) { /* ignore */ }
            }
            const sv = val.string_value;
            if (typeof sv === 'string' && sv.indexOf('.mp4') !== -1 && /^https?:/i.test(sv)) { acc.videos.push(sv); real = true; }
            if (val.image_value && val.image_value.url) thumbs.push({ key: e.key || '', url: val.image_value.url, w: val.image_value.width || 0 });
        }
        if (!real && thumbs.length) {
            const score = (t) => (/large|orig|full/i.test(t.key) ? 100000 : 0) + (t.w || 0);
            thumbs.sort((a, b) => score(b) - score(a));
            acc.photos.push(thumbs[0].url);
        }
        if (!acc.photos.length && !acc.gifs.length && !acc.videos.length) return;
        const key = String(id);
        const entry = touchGet(cardRegistry, key) || { photos: [], gifs: [], videos: [] };
        entry.photos = uniq([...entry.photos, ...acc.photos]);
        entry.gifs = uniq([...entry.gifs, ...acc.gifs]);
        entry.videos = uniq([...entry.videos, ...acc.videos]);
        boundedSet(cardRegistry, key, entry);
    }

    // Visit one JSON node; push its children onto the stack (iterative, so deep JSON can't overflow).
    function visitNode(value, depth, stack) {
        if (!value || typeof value !== 'object' || depth > 40) return;
        if (!Array.isArray(value)) {
            const ext = value.extended_entities;
            if (value.id_str && ext && Array.isArray(ext.media)) registerMedia(value.id_str, ext.media);
            if (value.card && typeof value.card === 'object') {
                const cid = value.rest_id || value.id_str || (value.legacy && value.legacy.id_str);
                if (cid) { try { harvestCard(String(cid), value.card); } catch (e) { /* ignore */ } }
            }
        }
        const children = Array.isArray(value) ? value : Object.values(value);
        for (let i = children.length - 1; i >= 0; i--) {
            const c = children[i];
            if (c && typeof c === 'object') stack.push({ v: c, d: depth + 1 });
            if (stack.length > 400000) break;
        }
    }

    function walkSync(root, maxNodes) {
        const stack = [{ v: root, d: 0 }];
        let n = 0;
        while (stack.length && n < maxNodes) { const s = stack.pop(); n++; visitNode(s.v, s.d, stack); }
    }

    // Large responses are processed in small slices so the page never freezes.
    const MAX_RESPONSE_CHARS = 8000000;
    const MAX_JOB_NODES = 250000;
    const harvestQueue = [];
    let harvestPending = false;

    function pumpHarvest() {
        if (harvestPending || !harvestQueue.length) return;
        harvestPending = true;
        setTimeout(() => {
            harvestPending = false;
            let budget = 1500;
            while (harvestQueue.length && budget > 0) {
                const job = harvestQueue[0];
                while (job.stack.length && budget > 0 && job.n < MAX_JOB_NODES) {
                    const s = job.stack.pop(); job.n++; budget--;
                    try { visitNode(s.v, s.d, job.stack); } catch (e) { /* ignore */ }
                }
                if (!job.stack.length || job.n >= MAX_JOB_NODES) harvestQueue.shift();
            }
            if (harvestQueue.length) pumpHarvest();
        }, 0);
    }

    function enqueueHarvest(root) {
        if (!root || typeof root !== 'object' || harvestQueue.length >= 6) return;
        harvestQueue.push({ stack: [{ v: root, d: 0 }], n: 0 });
        pumpHarvest();
    }

    function tryHarvestText(text) {
        if (!text || text.length > MAX_RESPONSE_CHARS) return;
        if (text.indexOf('extended_entities') === -1 && text.indexOf('binding_values') === -1) return;
        try { enqueueHarvest(JSON.parse(text)); } catch (e) { /* not JSON */ }
    }

    const hookCounts = { fetch: 0, xhrOpen: 0, xhrSend: 0 };
    const API_URL_RE = /(graphql|\/2\/timeline|\/i\/api\/)/i;

    function declaredTooLarge(getHeader) {
        try { const n = Number(getHeader('content-length')); return Number.isFinite(n) && n > MAX_RESPONSE_CHARS; }
        catch (e) { return false; }
    }

    function harvestXhr(xhr) {
        const url = xhr && xhr.__xcUrl ? String(xhr.__xcUrl) : '';
        if (!API_URL_RE.test(url)) return;
        try {
            if (typeof xhr.getResponseHeader === 'function' && declaredTooLarge((n) => xhr.getResponseHeader(n))) return;
            const type = xhr.responseType;
            if (type === '' || type === 'text') tryHarvestText(xhr.responseText);
            else if (type === 'json' && xhr.response && typeof xhr.response === 'object') enqueueHarvest(xhr.response);
            else if (type === 'arraybuffer' && xhr.response && xhr.response.byteLength <= MAX_RESPONSE_CHARS) {
                tryHarvestText(new TextDecoder('utf-8').decode(new Uint8Array(xhr.response)));
            } else if (type === 'blob' && xhr.response && typeof xhr.response.text === 'function' && xhr.response.size <= MAX_RESPONSE_CHARS) {
                xhr.response.text().then(tryHarvestText).catch(() => { });
            }
        } catch (e) { /* never break the page */ }
    }

    function installHooks() {
        if (!Settings.get('networkCapture')) return;
        try {
            const orig = W.fetch;
            if (orig && !orig.__xcHooked && hookCounts.fetch < 4) {
                const hooked = function (...args) {
                    const p = orig.apply(this, args);
                    try {
                        p.then((res) => {
                            try {
                                if (!res || !res.clone || !API_URL_RE.test(res.url || '')) return;
                                if (res.headers && declaredTooLarge((n) => res.headers.get(n))) return;
                                const ct = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
                                if (ct && !/(?:json|javascript|text)/i.test(ct)) return;
                                res.clone().text().then(tryHarvestText).catch(() => { });
                            } catch (e) { /* ignore */ }
                        }).catch(() => { });
                    } catch (e) { /* ignore */ }
                    return p;
                };
                hooked.__xcHooked = true;
                W.fetch = hooked;
                if (W.fetch === hooked) hookCounts.fetch++;
            }
        } catch (e) { Diag.push('error', 'hook', 'fetch: ' + e.message); }
        try {
            const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
            if (proto && proto.open && !proto.open.__xcHooked && hookCounts.xhrOpen < 4) {
                const origOpen = proto.open;
                const hookedOpen = function (method, url) { this.__xcUrl = url; return origOpen.apply(this, arguments); };
                hookedOpen.__xcHooked = true;
                proto.open = hookedOpen;
                if (proto.open === hookedOpen) hookCounts.xhrOpen++;
            }
            if (proto && proto.send && !proto.send.__xcHooked && hookCounts.xhrSend < 4) {
                const origSend = proto.send;
                const hookedSend = function () {
                    try { this.addEventListener('load', () => harvestXhr(this), { once: true }); } catch (e) { /* ignore */ }
                    return origSend.apply(this, arguments);
                };
                hookedSend.__xcHooked = true;
                proto.send = hookedSend;
                if (proto.send === hookedSend) hookCounts.xhrSend++;
            }
        } catch (e) { Diag.push('error', 'hook', 'xhr: ' + e.message); }
    }

    /* ==================================================================
     * 5. ON-DEMAND LOOKUP (when a video's URL wasn't captured)
     * ================================================================== */
    const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
    const FALLBACK_QUERY_ID = 'zAz9764BcLZOJ0JU2wrd1A';
    const DETAIL_FEATURES = { creator_subscriptions_tweet_preview_api_enabled: true, premium_content_api_read_enabled: false, communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true, responsive_web_grok_analyze_button_fetch_trends_enabled: false, responsive_web_grok_analyze_post_followups_enabled: false, responsive_web_jetfuel_frame: false, responsive_web_grok_share_attachment_enabled: true, articles_preview_enabled: true, responsive_web_edit_tweet_api_enabled: true, graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true, longform_notetweets_consumption_enabled: true, longform_notetweets_inline_media_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true, tweet_awards_web_tipping_enabled: false, responsive_web_grok_show_grok_translated_post: false, responsive_web_grok_analysis_button_from_backend: false, creator_subscriptions_quote_tweet_preview_enabled: false, freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true, tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, longform_notetweets_rich_text_read_enabled: true, profile_label_improvements_pcf_label_in_post_enabled: true, rweb_tipjar_consumption_enabled: true, verified_phone_label_enabled: false, responsive_web_grok_image_annotation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_enhance_cards_enabled: false };

    function cookie(name) {
        const prefix = name + '=';
        try {
            const part = String(document.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix));
            return part ? decodeURIComponent(part.slice(prefix.length)) : '';
        } catch (e) { return ''; }
    }

    function gmGet(url, headers, asJson) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            GM_xmlhttpRequest({
                method: 'GET', url, headers: headers || {}, timeout: 30000,
                responseType: asJson ? 'json' : undefined,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) { reject(new Error('HTTP ' + r.status)); return; }
                    if (!asJson) { resolve(r.responseText); return; }
                    let body = r.response;
                    if (typeof body === 'string' || !body) { try { body = JSON.parse(r.responseText); } catch (e) { reject(e); return; } }
                    resolve(body);
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Timed out'))
            });
        });
    }

    // X rotates GraphQL query ids. Read the current one from X's own scripts (cached 24 h),
    // and fall back to a known id if that fails.
    let queryIdPromise = null;
    function resolveQueryId() {
        const cached = GM_getValue('xc_qid', null);
        if (cached && cached.id && now() - cached.t < 86400000) return Promise.resolve(cached.id);
        if (!queryIdPromise) {
            queryIdPromise = (async () => {
                const sources = [...document.querySelectorAll('script[src]')].map((s) => s.src)
                    .filter((u) => /^https:\/\/abs\.twimg\.com\/responsive-web\//.test(u) && /\.js(\?|$)/.test(u)).slice(0, 25);
                for (const src of sources) {
                    try {
                        const js = await gmGet(src, {}, false);
                        const m = js.match(/queryId:"([A-Za-z0-9_-]{15,30})",operationName:"TweetResultByRestId"/);
                        if (m) { GM_setValue('xc_qid', { id: m[1], t: now() }); return m[1]; }
                    } catch (e) { /* try the next script */ }
                }
                return FALLBACK_QUERY_ID;
            })().finally(() => { queryIdPromise = null; });
        }
        return queryIdPromise;
    }

    function lookupHeaders() {
        const headers = {
            authorization: BEARER,
            'x-twitter-client-language': 'en',
            'x-twitter-active-user': 'yes',
            'content-type': 'application/json'
        };
        const csrf = cookie('ct0');
        const guest = cookie('gt');
        if (csrf) headers['x-csrf-token'] = csrf;
        if (guest) headers['x-guest-token'] = guest; else headers['x-twitter-auth-type'] = 'OAuth2Session';
        return headers;
    }

    const lookupJobs = new Map();
    function lookupPostMedia(statusId) {
        const id = String(statusId || '');
        if (!id) return Promise.resolve(false);
        if (lookupJobs.has(id)) return lookupJobs.get(id);
        const variables = { tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false };
        const toggles = { withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false };
        const task = (async () => {
            const ids = uniq([await resolveQueryId(), FALLBACK_QUERY_ID]);
            for (const qid of ids) {
                const url = 'https://x.com/i/api/graphql/' + qid + '/TweetResultByRestId?variables=' + encodeURIComponent(JSON.stringify(variables))
                    + '&features=' + encodeURIComponent(JSON.stringify(DETAIL_FEATURES)) + '&fieldToggles=' + encodeURIComponent(JSON.stringify(toggles));
                try {
                    const payload = await gmGet(url, lookupHeaders(), true);
                    walkSync(payload, 12000);
                    const reg = mediaRegistry.get(id) || cardRegistry.get(id);
                    if (reg && (reg.photos.length || reg.gifs.length || reg.videos.length)) return true;
                } catch (e) {
                    Diag.push('warn', 'lookup', 'query id attempt failed: ' + e.message);
                    if (qid !== FALLBACK_QUERY_ID) GM_setValue('xc_qid', null);
                }
            }
            return false;
        })().finally(() => lookupJobs.delete(id));
        lookupJobs.set(id, task);
        return task;
    }

    /* ==================================================================
     * 6. COLLECTING MEDIA FOR A POST + NAMING
     * ================================================================== */
    const AGE_PLACEHOLDER_RE = /\/media\/GxJIrSUagAAK-ZP\b/;

    function extOfUrl(u, def) {
        try {
            const url = new URL(u, 'https://pbs.twimg.com');
            const fmt = url.searchParams.get('format');
            if (fmt && /^[a-z0-9]{2,4}$/i.test(fmt)) return fmt.toLowerCase();
            const m = url.pathname.match(/\.([a-zA-Z0-9]{2,4})$/);
            if (m) return m[1].toLowerCase();
        } catch (e) { /* ignore */ }
        return def || 'bin';
    }

    // Timeline thumbnails are often requested as webp. The upload is almost always jpg (or png),
    // so ask for that instead of a re-encoded webp.
    function photoFormat(u) {
        let ext = '';
        try {
            const url = new URL(u, 'https://pbs.twimg.com');
            const m = url.pathname.match(/\.([a-zA-Z0-9]{2,4})$/);
            ext = m ? m[1].toLowerCase() : (url.searchParams.get('format') || '').toLowerCase();
        } catch (e) { /* ignore */ }
        if (ext === 'jpeg') ext = 'jpg';
        return ext === 'png' ? 'png' : 'jpg';
    }
    // Original first, then progressively smaller sizes in case the original is refused.
    function photoVariants(u) {
        const base = String(u).split('?')[0];
        const fmt = photoFormat(u);
        return ['orig', '4096x4096', 'large'].map((name) => base + '?format=' + fmt + '&name=' + name);
    }
    function photoKey(u) {
        const m = String(u || '').match(/\/media\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : String(u || '').split('?')[0];
    }

    function collectMedia(article, statusId) {
        const out = { photos: [], gifs: [], videos: [] };
        const seenPhoto = new Set(), seenGif = new Set(), seenVideo = new Set();
        const addPhoto = (u) => { if (!u) return; const k = photoKey(u); if (seenPhoto.has(k)) return; seenPhoto.add(k); out.photos.push(u); };
        const addGif = (u) => { if (!u || seenGif.has(u)) return; seenGif.add(u); out.gifs.push(u); };
        const addVideo = (u) => { if (!u || seenVideo.has(u)) return; seenVideo.add(u); out.videos.push(u); };

        const reg = statusId ? touchGet(mediaRegistry, String(statusId)) : null;
        if (reg) { reg.photos.forEach(addPhoto); reg.gifs.forEach(addGif); reg.videos.forEach(addVideo); }

        article.querySelectorAll('video').forEach((video) => {
            const src = video.currentSrc || video.src || video.getAttribute('src') || '';
            if (!/^https:\/\/video\.twimg\.com\//i.test(src)) return;
            if (/video\.twimg\.com\/tweet_video\//i.test(src)) addGif(src);
            else if (/video\.twimg\.com\/(?:ext_tw_video|amplify_tw_video|amplify_video)\//i.test(src)) addVideo(src);
        });

        article.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]').forEach((img) => {
            const src = img.currentSrc || img.src || '';
            if (AGE_PLACEHOLDER_RE.test(src)) return;
            if (/pbs\.twimg\.com\/media\//.test(src)) addPhoto(src);
        });

        article.querySelectorAll('video[poster]').forEach((v) => {
            const g = (v.getAttribute('poster') || '').match(/tweet_video_thumb\/([A-Za-z0-9_-]+)\.(?:jpg|png|webp)/);
            if (g) addGif('https://video.twimg.com/tweet_video/' + g[1] + '.mp4');
        });

        article.querySelectorAll('video[poster], img[src*="/amplify_tw_video_thumb/"], img[src*="/amplify_video_thumb/"], img[src*="/ext_tw_video_thumb/"], img[src*="/tweet_video_thumb/"]').forEach((el) => {
            const key = posterKey(el.getAttribute('poster') || el.currentSrc || el.src || '');
            const matched = key ? touchGet(posterRegistry, key) : null;
            if (!matched || !matched.url) return;
            if (matched.type === 'gif') addGif(matched.url); else addVideo(matched.url);
        });
        return out;
    }

    function collectItems(article, statusId) {
        const media = collectMedia(article, statusId);
        const convert = Settings.get('gifFormat') === 'gif';
        const items = [];
        const addGif = (url) => items.push({ url, ext: convert ? 'gif' : 'mp4', mediaType: 'gif', convertToGif: convert, quality: convert ? 'converted' : 'original mp4' });
        const addPhoto = (u) => { const v = photoVariants(u); items.push({ url: v[0], fallbacks: v.slice(1), ext: photoFormat(u), mediaType: 'image', quality: 'original' }); };
        const addVideo = (u) => items.push({ url: u, ext: 'mp4', mediaType: 'video', quality: videoLabel(u) });
        media.photos.forEach(addPhoto);
        media.gifs.forEach(addGif);
        media.videos.forEach(addVideo);
        if (!items.length) {
            const card = statusId ? touchGet(cardRegistry, String(statusId)) : null;
            if (card) {
                card.photos.forEach((u) => items.push({ url: u, ext: extOfUrl(u, 'jpg'), mediaType: 'image', quality: 'link preview' }));
                card.gifs.forEach(addGif);
                card.videos.forEach(addVideo);
            }
        }
        return items;
    }

    // ---- file names
    const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    function sanitizeName(value, fallback) {
        let n = String(value == null ? '' : value);
        try { n = n.normalize('NFC'); } catch (e) { /* ignore */ }
        n = n.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/\s+/g, ' ').trim();
        n = n.replace(/^[. ]+/, '');
        if (RESERVED_WIN.test(n)) n = '_' + n;
        n = n.slice(0, 150).replace(/[. ]+$/, '');
        return n || fallback || 'xcavate';
    }

    function renderTemplate(template, values) {
        return String(template || '').replace(/\{([a-z]+)\}/gi, (all, k) => {
            const key = k.toLowerCase();
            return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all;
        });
    }

    function applyRegex(name, source, replacement) {
        if (!source || !isSafeRegex(source)) return name;
        try { return String(name).slice(0, 200).replace(new RegExp(source, 'g'), String(replacement || '')); }
        catch (e) { return name; }
    }

    function sourceName(item) {
        let raw = '';
        try { raw = new URL(item.url).pathname.split('/').pop() || ''; } catch (e) { /* ignore */ }
        raw = raw.replace(new RegExp('\\.' + String(item.ext || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), '');
        return sanitizeName(raw, 'media');
    }

    function nameBase(job, purpose, item) {
        const zip = purpose === 'zip';
        const values = {
            name: job.displayName || job.handle,
            handle: job.handle,
            id: job.statusId,
            date: fmtDate(job.postDate || job.createdAt),
            text: String(job.postText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'no-text',
            type: zip ? 'zip' : (item.mediaType || 'media'),
            file: zip ? 'media' : sourceName(item),
            index: zip ? '' : String((item.index || 0) + 1)
        };
        const rendered = renderTemplate(zip ? job.zipTemplate : job.fileTemplate, values);
        return sanitizeName(applyRegex(rendered, job.nameRegex, job.nameReplacement), values.handle + '_' + values.id);
    }

    function withExt(base, ext) {
        const e = String(ext || 'bin').replace(/^\.+/, '').toLowerCase() || 'bin';
        const dup = new RegExp('\\.' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
        return String(base || 'download').replace(dup, '') + '.' + e;
    }

    function itemFilename(job, item) {
        let base = nameBase(job, 'file', item);
        if (job.items.length > 1 && !/\{index\}/i.test(job.fileTemplate)) base = sanitizeName(base + '_' + ((item.index || 0) + 1), base);
        return withExt(base, item.ext);
    }
    const zipFilename = (job) => withExt(nameBase(job, 'zip'), 'zip');

    /* ==================================================================
     * 7. TRANSFER, ZIP WRITER, GIF ENCODER
     * ================================================================== */
    function cancelledError() { const e = new Error('Download cancelled'); e.code = 'CANCELLED'; return e; }
    function timeoutError() { const e = new Error('Download timed out'); e.code = 'TIMEOUT'; return e; }

    function fetchBlob(url, opts) {
        opts = opts || {};
        const timeoutMs = Settings.get('timeoutSec') * 1000;
        if (opts.signal && opts.signal.aborted) return Promise.reject(cancelledError());
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                let settled = false, request = null;
                const finish = (fn, v) => {
                    if (settled) return;
                    settled = true;
                    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
                    if (opts.onRequest) opts.onRequest(request, false);
                    fn(v);
                };
                const onAbort = () => { try { if (request && request.abort) request.abort(); } catch (e) { /* ignore */ } finish(reject, cancelledError()); };
                try {
                    request = GM_xmlhttpRequest({
                        method: 'GET', url, responseType: 'arraybuffer', timeout: timeoutMs,
                        onprogress: (e) => { if (!settled && opts.onProgress) opts.onProgress(Number(e.loaded) || 0, Number(e.total) || 0, e.lengthComputable === true); },
                        onload: (r) => {
                            if (opts.signal && opts.signal.aborted) { finish(reject, cancelledError()); return; }
                            if (r.status >= 200 && r.status < 300 && r.response) {
                                const ct = ((r.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i) || [])[1];
                                finish(resolve, new Blob([r.response], ct ? { type: ct.trim() } : undefined));
                            } else finish(reject, new Error('HTTP ' + r.status));
                        },
                        onerror: () => finish(reject, new Error('Network error')),
                        ontimeout: () => finish(reject, timeoutError()),
                        onabort: () => finish(reject, cancelledError())
                    });
                    if (opts.onRequest) opts.onRequest(request, true);
                    if (opts.signal) { opts.signal.addEventListener('abort', onAbort, { once: true }); if (opts.signal.aborted) onAbort(); }
                } catch (e) { finish(reject, e); }
            });
        }
        return (async () => {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            let timedOut = false;
            const relay = () => { if (controller) controller.abort(); };
            if (opts.signal && controller) opts.signal.addEventListener('abort', relay, { once: true });
            const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
            try {
                const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const total = Number(res.headers.get('content-length')) || 0;
                const type = res.headers.get('content-type') || '';
                if (res.body && res.body.getReader) {
                    const reader = res.body.getReader();
                    const chunks = [];
                    let loaded = 0;
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) break;
                        chunks.push(part.value); loaded += part.value.byteLength;
                        if (opts.onProgress) opts.onProgress(loaded, total, total > 0);
                    }
                    return new Blob(chunks, type ? { type } : undefined);
                }
                const blob = await res.blob();
                if (opts.onProgress) opts.onProgress(blob.size, blob.size, true);
                return blob;
            } catch (e) {
                if (opts.signal && opts.signal.aborted) throw cancelledError();
                if (timedOut || (e && e.name === 'AbortError')) throw timeoutError();
                if (e && /^HTTP /.test(e.message || '')) throw e;
                throw new Error('Download failed. Use a userscript manager that supports GM_xmlhttpRequest.');
            } finally {
                if (timer) clearTimeout(timer);
                if (opts.signal && controller) opts.signal.removeEventListener('abort', relay);
            }
        })();
    }

    async function fetchBlobWithRetry(url, opts) {
        let last = null;
        for (let attempt = 0; attempt <= 1; attempt++) {
            try { return await fetchBlob(url, opts); }
            catch (e) {
                last = e;
                if (e && e.code === 'CANCELLED') throw e;
                if (attempt >= 1 || /^HTTP 4\d\d/.test((e && e.message) || '')) throw e;
                if (opts && opts.onRetry) opts.onRetry();
            }
        }
        throw last || new Error('Download failed');
    }

    // Try the best URL first; if X refuses it, fall back to the next size.
    async function fetchWithFallbacks(item, opts) {
        const urls = [item.url].concat(item.fallbacks || []);
        let last = null;
        for (let i = 0; i < urls.length; i++) {
            try { return await fetchBlobWithRetry(urls[i], opts); }
            catch (e) {
                last = e;
                if (e && e.code === 'CANCELLED') throw e;
                if (i < urls.length - 1) Diag.push('warn', 'download', 'size refused, trying a smaller one');
            }
        }
        throw last || new Error('Download failed');
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    const blobToBuffer = (blob) => (blob.arrayBuffer ? blob.arrayBuffer() : new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error('Read failed'));
        fr.readAsArrayBuffer(blob);
    }));

    // ---- ZIP (store only: photos and videos are already compressed)
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
        return t;
    })();
    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function dosDateTime(date) {
        const d = Number.isFinite(date.getTime()) ? date : new Date();
        const year = Math.max(1980, Math.min(2107, d.getFullYear()));
        return {
            time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F),
            date: ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
        };
    }
    function zipLimitError() { const e = new Error('Too large for a classic ZIP; files will be saved separately'); e.code = 'ZIP_LIMIT'; return e; }

    function buildZip(files) {
        const MAX = 0xFFFFFFFF;
        if (files.length > 0xFFFF) throw zipLimitError();
        const enc = new TextEncoder();
        const stamp = dosDateTime(new Date());
        const chunks = [], central = [];
        let offset = 0, centralSize = 0;
        for (const f of files) {
            const nameB = enc.encode(f.name), size = f.data.length;
            if (size > MAX || nameB.length > 0xFFFF || offset + 30 + nameB.length + size > MAX) throw zipLimitError();
            const crc = crc32(f.data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
            lh.setUint16(10, stamp.time, true); lh.setUint16(12, stamp.date, true); lh.setUint32(14, crc, true);
            lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nameB.length, true);
            chunks.push(new Uint8Array(lh.buffer), nameB, f.data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
            ch.setUint16(12, stamp.time, true); ch.setUint16(14, stamp.date, true); ch.setUint32(16, crc, true);
            ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nameB.length, true);
            ch.setUint32(42, offset, true);
            central.push(new Uint8Array(ch.buffer), nameB);
            offset += 30 + nameB.length + size;
            centralSize += 46 + nameB.length;
        }
        if (offset + centralSize + 22 > MAX) throw zipLimitError();
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
        end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
        return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
    }

    // ---- GIF (X serves "GIFs" as MP4; this converts them in the browser)
    const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

    // Median-cut palette (256 colours) from sampled RGB triplets.
    function medianCutPalette(rgb, K) {
        const n = Math.floor(rgb.length / 3);
        const palette = new Uint8Array(K * 3);
        if (!n) return palette;
        const idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        const measure = (b) => {
            let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
            for (let i = b.lo; i < b.hi; i++) {
                const q = idx[i] * 3, r = rgb[q], g = rgb[q + 1], bl = rgb[q + 2];
                if (r < r0) r0 = r; if (r > r1) r1 = r;
                if (g < g0) g0 = g; if (g > g1) g1 = g;
                if (bl < b0) b0 = bl; if (bl > b1) b1 = bl;
            }
            const rr = r1 - r0, gg = g1 - g0, bb = b1 - b0;
            b.ch = rr >= gg && rr >= bb ? 0 : (gg >= bb ? 1 : 2);
            b.score = Math.max(rr, gg, bb) * (b.hi - b.lo);
        };
        const boxes = [{ lo: 0, hi: n }];
        measure(boxes[0]);
        while (boxes.length < K) {
            let bi = -1, best = 0;
            for (let i = 0; i < boxes.length; i++) {
                if (boxes[i].hi - boxes[i].lo > 1 && boxes[i].score > best) { best = boxes[i].score; bi = i; }
            }
            if (bi < 0) break;
            const b = boxes[bi], ch = b.ch;
            idx.subarray(b.lo, b.hi).sort((x, y) => rgb[x * 3 + ch] - rgb[y * 3 + ch]);
            const mid = b.lo + ((b.hi - b.lo) >> 1);
            const a = { lo: b.lo, hi: mid }, c = { lo: mid, hi: b.hi };
            measure(a); measure(c);
            boxes[bi] = a; boxes.push(c);
        }
        boxes.forEach((b, k) => {
            let r = 0, g = 0, bl = 0;
            const cnt = b.hi - b.lo;
            for (let i = b.lo; i < b.hi; i++) { const q = idx[i] * 3; r += rgb[q]; g += rgb[q + 1]; bl += rgb[q + 2]; }
            palette[k * 3] = Math.round(r / cnt); palette[k * 3 + 1] = Math.round(g / cnt); palette[k * 3 + 2] = Math.round(bl / cnt);
        });
        for (let k = boxes.length; k < K; k++) { palette[k * 3] = palette[0]; palette[k * 3 + 1] = palette[1]; palette[k * 3 + 2] = palette[2]; }
        return palette;
    }

    // 32x32x32 lookup: nearest palette entry for any colour (5 bits per channel).
    function buildLut(palette) {
        const lut = new Uint8Array(32768);
        for (let r = 0; r < 32; r++) {
            for (let g = 0; g < 32; g++) {
                for (let b = 0; b < 32; b++) {
                    const R = (r << 3) | 4, G = (g << 3) | 4, B = (b << 3) | 4;
                    let bestK = 0, bestD = Infinity;
                    for (let k = 0; k < 256; k++) {
                        const dr = R - palette[k * 3], dg = G - palette[k * 3 + 1], db = B - palette[k * 3 + 2];
                        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
                        if (d < bestD) { bestD = d; bestK = k; }
                    }
                    lut[(r << 10) | (g << 5) | b] = bestK;
                }
            }
        }
        return lut;
    }

    function quantizeLut(rgba, width, lut) {
        const px = new Uint8Array(rgba.length >> 2);
        for (let i = 0; i < px.length; i++) {
            const x = i % width, y = (i / width) | 0;
            const adj = (BAYER4[((y & 3) << 2) | (x & 3)] - 7.5) * 1.1;
            const o = i << 2;
            const r = Math.max(0, Math.min(255, rgba[o] + adj));
            const g = Math.max(0, Math.min(255, rgba[o + 1] + adj));
            const b = Math.max(0, Math.min(255, rgba[o + 2] + adj));
            px[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
        }
        return px;
    }

    function gifLzw(indices) {
        const CLEAR = 256, END = 257;
        let size = 9, next = 258, dict = new Map(), buf = 0, bits = 0;
        const out = [];
        const put = (code) => {
            buf |= code << bits; bits += size;
            while (bits >= 8) { out.push(buf & 0xFF); buf >>>= 8; bits -= 8; }
        };
        put(CLEAR);
        if (indices.length) {
            let prefix = indices[0];
            for (let i = 1; i < indices.length; i++) {
                const suffix = indices[i], key = prefix * 256 + suffix, found = dict.get(key);
                if (found !== undefined) { prefix = found; continue; }
                put(prefix);
                if (next < 4096) {
                    dict.set(key, next++);
                    if (next > (1 << size) && size < 12) size++;
                } else { put(CLEAR); dict = new Map(); size = 9; next = 258; }
                prefix = suffix;
            }
            put(prefix);
        }
        // The decoder adds one more table entry after the last code; if that crosses a code-size
        // boundary the end marker must already use the wider size.
        if (next >= (1 << size) && size < 12) size++;
        put(END);
        if (bits > 0) out.push(buf & 0xFF);
        return new Uint8Array(out);
    }

    function gifEncoder(width, height, palette) {
        const parts = [];
        const bytes = (...v) => parts.push(Uint8Array.from(v));
        const word = (v) => bytes(v & 0xFF, (v >>> 8) & 0xFF);
        parts.push(new TextEncoder().encode('GIF89a'));
        word(width); word(height);
        bytes(0xF7, 0x00, 0x00);
        parts.push(palette);
        parts.push(Uint8Array.from([0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00]));
        return {
            addFrame(indices, delayCs) {
                const delay = Math.max(1, Math.min(65535, Math.round(delayCs) || 1));
                bytes(0x21, 0xF9, 0x04, 0x04, delay & 0xFF, (delay >>> 8) & 0xFF, 0x00, 0x00);
                bytes(0x2C, 0, 0, 0, 0); word(width); word(height); bytes(0x00, 0x08);
                const data = gifLzw(indices);
                for (let o = 0; o < data.length; o += 255) {
                    const block = data.subarray(o, Math.min(o + 255, data.length));
                    bytes(block.length); parts.push(block);
                }
                bytes(0x00);
            },
            finish() { bytes(0x3B); return new Blob(parts, { type: 'image/gif' }); }
        };
    }

    function waitVideo(video, eventName, signal) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => {
                video.removeEventListener(eventName, ok); video.removeEventListener('error', fail);
                if (signal) signal.removeEventListener('abort', abort);
                if (timer) clearTimeout(timer);
            };
            const done = (fn, v) => { cleanup(); fn(v); };
            const ok = () => done(resolve);
            const fail = () => done(reject, new Error('Could not decode the GIF video'));
            const abort = () => done(reject, cancelledError());
            video.addEventListener(eventName, ok, { once: true });
            video.addEventListener('error', fail, { once: true });
            if (signal) signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => done(reject, new Error('GIF conversion timed out')), 30000);
            if (signal && signal.aborted) abort();
        });
    }

    async function mp4ToGif(blob, opts) {
        opts = opts || {};
        const high = Settings.get('gifQuality') === 'high';
        const MAX_DIM = high ? 720 : 480, FPS = high ? 15 : 10, MAX_FRAMES = high ? 300 : 180;
        const video = document.createElement('video');
        const url = URL.createObjectURL(blob);
        video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
        try {
            if (video.readyState < 1) { const w = waitVideo(video, 'loadedmetadata', opts.signal); video.load(); await w; }
            if (video.readyState < 2) await waitVideo(video, 'loadeddata', opts.signal);
            const duration = Number(video.duration), sw = video.videoWidth, sh = video.videoHeight;
            if (!Number.isFinite(duration) || duration <= 0 || !sw || !sh) throw new Error('Could not read the GIF video size');
            const scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
            const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale));
            const frames = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration * FPS)));
            const step = duration / frames;
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
            if (!ctx) throw new Error('Canvas not available');

            const grab = async (t) => {
                if (opts.signal && opts.signal.aborted) throw cancelledError();
                const at = Math.min(Math.max(0, duration - 0.001), t);
                if (!(Math.abs(video.currentTime - at) < 0.002 && video.readyState >= 2)) {
                    const seeked = waitVideo(video, 'seeked', opts.signal);
                    video.currentTime = at;
                    await seeked;
                }
                ctx.drawImage(video, 0, 0, width, height);
                return ctx.getImageData(0, 0, width, height).data;
            };

            // Pass 1: sample a few frames to build one good 256-colour palette for the whole GIF.
            const samples = Math.min(8, frames);
            const stride = Math.max(1, Math.floor((width * height * samples) / 60000));
            const sampled = [];
            for (let s = 0; s < samples; s++) {
                const d = await grab((s + 0.5) * duration / samples);
                for (let i = 0; i < width * height; i += stride) { const o = i * 4; sampled.push(d[o], d[o + 1], d[o + 2]); }
            }
            const palette = medianCutPalette(Uint8Array.from(sampled), 256);
            const lut = buildLut(palette);

            // Pass 2: encode every frame.
            const enc = gifEncoder(width, height, palette);
            for (let f = 0; f < frames; f++) {
                const d = await grab((f + 0.5) * step);
                enc.addFrame(quantizeLut(d, width, lut), step * 100);
                if (opts.onProgress) opts.onProgress(f + 1, frames);
            }
            return enc.finish();
        } finally {
            video.removeAttribute('src');
            try { video.load(); } catch (e) { /* ignore */ }
            URL.revokeObjectURL(url);
        }
    }

    /* ==================================================================
     * 8. JOB QUEUE
     * ================================================================== */
    const ZIP_MEMORY_DESKTOP = 384 * 1024 * 1024;
    const ZIP_MEMORY_MOBILE = 128 * 1024 * 1024;
    const jobs = new Map();            // statusId -> job
    const pendingLookups = new Set();  // statusIds being looked up
    const transferQueue = [];
    let activeTransfers = 0;
    let uiRaf = 0;

    const isActive = (job) => !!job && ['queued', 'downloading', 'packing', 'saving', 'cancelling'].includes(job.status);

    function jobProgress(job) {
        let loaded = 0, total = 0, known = job.progress.length > 0;
        for (const p of job.progress) { loaded += p.loaded || 0; total += p.total || 0; if (!p.known) known = false; }
        return { loaded, total, known, percent: known && total > 0 ? Math.max(0, Math.min(100, Math.round(loaded / total * 100))) : 0 };
    }

    function describeJob(job, compact) {
        const p = jobProgress(job);
        if (job.status === 'queued') return compact ? '…' : 'Queued';
        if (job.progress.some((x) => x.status === 'gif')) return compact ? 'GIF' : 'Converting to GIF';
        if (job.status === 'packing') return compact ? 'ZIP' : 'Packing ' + job.packDone + '/' + job.packTotal;
        if (job.status === 'saving') return compact ? 'Save' : 'Saving';
        if (job.status === 'cancelling') return compact ? '…' : 'Cancelling';
        if (job.status === 'done') return job.failed ? 'Done, ' + job.failed + ' failed' : 'Done';
        if (job.status === 'cancelled') return job.saved ? 'Cancelled (' + job.saved + ' saved)' : 'Cancelled';
        if (job.status === 'error') return 'Failed: ' + job.error;
        if (p.known) return p.percent + '%';
        if (p.loaded > 0) return fmtBytes(p.loaded);
        return compact ? '⬇' : 'Downloading ' + job.completed + '/' + job.items.length;
    }

    function scheduleUi() {
        if (uiRaf) return;
        uiRaf = requestAnimationFrame(() => { uiRaf = 0; refreshUi(); });
    }
    const touch = (job) => { job.updatedAt = now(); scheduleUi(); };

    function pumpTransfers() {
        const limit = Settings.get('concurrency');
        while (activeTransfers < limit && transferQueue.length) {
            const entry = transferQueue.shift();
            if (entry.job.cancelRequested) { entry.reject(cancelledError()); continue; }
            activeTransfers++;
            Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => { activeTransfers--; pumpTransfers(); });
        }
    }
    function withSlot(job, task) {
        return new Promise((resolve, reject) => { transferQueue.push({ job, task, resolve, reject }); pumpTransfers(); });
    }

    function cancelJob(statusId) {
        const job = jobs.get(String(statusId || ''));
        if (!isActive(job) || job.cancelRequested) return;
        job.cancelRequested = true;
        job.status = 'cancelling';
        job.controllers.forEach((c) => { try { c.abort(); } catch (e) { /* ignore */ } });
        job.requests.forEach((r) => { try { if (r && r.abort) r.abort(); } catch (e) { /* ignore */ } });
        for (let i = transferQueue.length - 1; i >= 0; i--) {
            if (transferQueue[i].job === job) { const q = transferQueue.splice(i, 1)[0]; q.reject(cancelledError()); }
        }
        touch(job);
    }

    function scheduleCleanup(job, ms) {
        if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
        job.cleanupTimer = setTimeout(() => {
            if (jobs.get(job.statusId) === job && !isActive(job)) jobs.delete(job.statusId);
            scheduleUi();
        }, ms);
    }

    function saveOne(job, res) {
        saveBlob(res.blob, itemFilename(job, res));
        res.blob = null;
        job.saved++;
        touch(job);
    }

    async function runJob(job) {
        job.status = 'downloading';
        touch(job);
        const memoryLimit = isMobile() ? ZIP_MEMORY_MOBILE : ZIP_MEMORY_DESKTOP;
        const retained = [];
        let retainedBytes = 0;
        let individual = job.zip === false;

        const accept = (res) => {
            if (job.items.length === 1) { job.status = 'saving'; saveOne(job, res); return; }
            if (!individual && retainedBytes + res.blob.size > memoryLimit) {
                individual = true; job.fallback = true;
                retained.splice(0).forEach((r) => saveOne(job, r));
                retainedBytes = 0;
            }
            if (individual) saveOne(job, res);
            else { retained.push(res); retainedBytes += res.blob.size; }
        };

        const outcomes = await Promise.all(job.items.map((item, index) => withSlot(job, async () => {
            if (job.cancelRequested) throw cancelledError();
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (controller) job.controllers.add(controller);
            const prog = job.progress[index];
            prog.status = 'downloading';
            try {
                let blob = await fetchWithFallbacks(item, {
                    signal: controller ? controller.signal : null,
                    onRequest: (req, active) => {
                        if (!req) return;
                        if (active) { job.requests.add(req); if (job.cancelRequested && req.abort) { try { req.abort(); } catch (e) { /* ignore */ } } }
                        else job.requests.delete(req);
                    },
                    onProgress: (loaded, total, known) => {
                        if (job.cancelRequested) return;
                        prog.loaded = loaded; prog.total = known ? total : 0; prog.known = known && total > 0;
                        touch(job);
                    },
                    onRetry: () => { prog.loaded = 0; prog.total = 0; prog.known = false; touch(job); }
                });
                if (item.convertToGif) {
                    prog.status = 'gif';
                    touch(job);
                    blob = await mp4ToGif(blob, { signal: controller ? controller.signal : null });
                }
                prog.loaded = blob.size; prog.total = blob.size; prog.known = true; prog.status = 'done';
                job.completed++;
                const res = { blob, ext: item.ext, mediaType: item.mediaType, url: item.url, index };
                accept(res);
                return { ok: true };
            } catch (error) {
                prog.status = error && error.code === 'CANCELLED' ? 'cancelled' : 'error';
                return { ok: false, error };
            } finally {
                if (controller) job.controllers.delete(controller);
                touch(job);
            }
        }).catch((error) => ({ ok: false, error }))));

        if (job.cancelRequested) {
            retained.forEach((r) => { r.blob = null; });
            job.status = 'cancelled';
            touch(job); scheduleCleanup(job, 5000);
            return;
        }

        const failures = outcomes.filter((o) => !o.ok && (!o.error || o.error.code !== 'CANCELLED'));
        job.failed = failures.length;
        if (!job.saved && !retained.length) {
            job.status = 'error';
            job.error = failures[0] && failures[0].error ? failures[0].error.message : 'All downloads failed';
            touch(job); scheduleCleanup(job, 30000);
            return;
        }

        if (!individual && retained.length === 1) {
            saveOne(job, retained[0]);
            retained.length = 0;
        } else if (!individual && retained.length > 1) {
            job.status = 'packing'; job.packDone = 0; job.packTotal = retained.length;
            touch(job);
            const files = [], names = new Set();
            try {
                for (const res of retained) {
                    if (job.cancelRequested) throw cancelledError();
                    const data = new Uint8Array(await blobToBuffer(res.blob));
                    res.blob = null;
                    let name = itemFilename(job, res), n = 1;
                    while (names.has(name)) name = withExt(name.replace(/\.[^.]+$/, '') + '_' + (n++), res.ext);
                    names.add(name);
                    files.push({ name, data, res });
                    job.packDone++; touch(job);
                }
                job.status = 'saving';
                saveBlob(buildZip(files), zipFilename(job));
                job.saved = files.length;
                files.length = 0;
            } catch (error) {
                if (error && error.code === 'CANCELLED') {
                    retained.forEach((r) => { r.blob = null; });
                    job.status = 'cancelled'; touch(job); scheduleCleanup(job, 5000);
                    return;
                }
                // ZIP failed (usually size): save every file separately instead of losing them.
                job.fallback = true;
                job.status = 'saving';
                for (const f of files) { saveBlob(new Blob([f.data]), f.name); job.saved++; }
                for (const res of retained) if (res.blob) saveOne(job, res);
                if (error && error.code !== 'ZIP_LIMIT') Diag.push('error', 'zip', error.message);
            }
            retained.length = 0;
        }

        job.status = 'done';
        job.error = '';
        if (job.saved > 0) Downloaded.add(job.statusId);
        touch(job); scheduleCleanup(job, 8000);
        toast(job.fallback ? 'Download complete: saved ' + job.saved + ' files separately' : 'Download complete' + (job.failed ? ', ' + job.failed + ' failed' : ''), job.failed ? 'warn' : 'ok');
    }

    function qualitySummary(items) {
        const parts = [];
        const images = items.filter((i) => i.mediaType === 'image').length;
        if (images) parts.push(images + ' image' + (images > 1 ? 's' : '') + ' (original)');
        items.filter((i) => i.mediaType === 'video').forEach((i) => parts.push('video ' + (i.quality || 'best')));
        const gifs = items.filter((i) => i.mediaType === 'gif').length;
        if (gifs) parts.push(gifs + ' GIF' + (gifs > 1 ? 's' : ''));
        return parts.join(' · ');
    }

    function startJob(items, meta) {
        const id = String(meta.statusId);
        const previous = jobs.get(id);
        if (isActive(previous)) { Panel.open('tasks'); return previous; }
        if (previous && previous.cleanupTimer) clearTimeout(previous.cleanupTimer);
        const s = Settings.data;
        const job = {
            statusId: id, handle: meta.handle, displayName: meta.displayName, postText: meta.postText, postDate: meta.postDate,
            items: items.map((it, i) => Object.assign({}, it, { index: i })),
            fileTemplate: s.fileTemplate, zipTemplate: s.zipTemplate, nameRegex: s.nameRegex, nameReplacement: s.nameReplacement,
            zip: s.zip,
            progress: items.map(() => ({ loaded: 0, total: 0, known: false, status: 'queued' })),
            status: 'queued', createdAt: now(), updatedAt: now(), completed: 0, failed: 0, saved: 0, packDone: 0, packTotal: 0,
            fallback: false, cancelRequested: false, controllers: new Set(), requests: new Set(), cleanupTimer: null, error: ''
        };
        job.title = nameBase(job, 'zip');
        job.quality = qualitySummary(job.items);
        jobs.set(id, job);
        scheduleUi();
        runJob(job).catch((error) => {
            job.status = error && error.code === 'CANCELLED' ? 'cancelled' : 'error';
            job.error = (error && error.message) || 'Unknown error';
            touch(job); scheduleCleanup(job, job.status === 'cancelled' ? 5000 : 30000);
        });
        return job;
    }

    function retryJob(statusId) {
        const prev = jobs.get(String(statusId || ''));
        if (!prev || isActive(prev)) return;
        startJob(prev.items, { statusId: prev.statusId, handle: prev.handle, displayName: prev.displayName, postText: prev.postText, postDate: prev.postDate });
    }

    /* ==================================================================
     * 9. PAGE INTEGRATION
     * ================================================================== */
    const ICON_DL = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';
    const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    function getStatusId(article) {
        const timeLink = [...article.querySelectorAll('time')].map((t) => t.closest('a[href*="/status/"]')).find(Boolean);
        const link = timeLink || article.querySelector('a[href*="/status/"]');
        const m = link && (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
        return m ? m[1] : null;
    }

    function getAuthor(article) {
        const spans = [...article.querySelectorAll('[data-testid="User-Name"] span')].map((s) => (s.textContent || '').trim());
        let handle = (spans.find((t) => /^@\w{1,15}$/.test(t)) || '').replace(/^@/, '');
        if (!handle) {
            const link = article.querySelector('a[href*="/status/"]');
            const m = link && (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
            if (m) handle = m[1];
        }
        const displayName = spans.find((t) => t && !/^@/.test(t) && t !== '·') || '';
        return { handle: handle || 'x', displayName };
    }

    function getPostText(article) {
        return [...article.querySelectorAll('[data-testid="tweetText"]')].map((e) => (e.innerText || '').trim()).filter(Boolean).join('\n').slice(0, 2000);
    }

    function mayHaveVideo(article) {
        return !!article.querySelector('video, [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="playButton"], img[src*="ext_tw_video_thumb"], img[src*="amplify_tw_video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"]');
    }
    function lacksVideoUrl(article, statusId) {
        if (!mayHaveVideo(article)) return false;
        const reg = mediaRegistry.get(String(statusId)) || cardRegistry.get(String(statusId));
        return !reg || !((reg.videos && reg.videos.length) || (reg.gifs && reg.gifs.length));
    }

    // Look the post up when we have no captured data, so we download the real originals
    // instead of whatever size the timeline happened to show.
    function needsLookup(article, statusId) {
        if (lacksVideoUrl(article, statusId)) return true;
        const hasMedia = !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"]');
        return hasMedia && !mediaRegistry.has(String(statusId));
    }

    async function handleDownloadClick(article) {
        const statusId = getStatusId(article);
        if (!statusId) { toast('Could not tell which post this is.', 'warn'); return; }
        if (pendingLookups.has(statusId)) { toast('Still looking up the original media…'); return; }
        if (isActive(jobs.get(statusId))) { Panel.open('tasks'); return; }
        if (Downloaded.has(statusId) && !window.confirm('Media from this post was downloaded before. Download again?')) return;

        let items = collectItems(article, statusId);
        if (needsLookup(article, statusId)) {
            pendingLookups.add(statusId);
            scheduleUi();
            toast('Looking up the original media…');
            try { if (await lookupPostMedia(statusId)) items = collectItems(article, statusId); }
            catch (e) { Diag.push('warn', 'lookup', e.message); }
            finally { pendingLookups.delete(statusId); scheduleUi(); }
        }
        if (!items.length) {
            toast('No downloadable media found. For video, play it once and try again. If this keeps happening, check that network capture is on in settings.', 'warn', 7000);
            return;
        }
        const author = getAuthor(article);
        startJob(items, {
            statusId, handle: author.handle, displayName: author.displayName, postText: getPostText(article),
            postDate: (article.querySelector('time') && article.querySelector('time').getAttribute('datetime')) || ''
        });
    }

    function topLevel(article, selector) {
        return [...article.querySelectorAll(selector)].find((el) => !el.closest || el.closest('article') === article) || null;
    }

    function guestPlacement(article) {
        const reply = topLevel(article, '[data-engagement-action="reply"]');
        const repost = topLevel(article, '[data-engagement-action="retweet"]');
        const like = topLevel(article, '[data-engagement-action="like"]');
        const share = topLevel(article, '[data-engagement-action="share"]');
        const row = reply && reply.parentElement;
        if (!row || !repost || repost.parentElement !== row || !like || like.parentElement !== row || !share) return null;
        let trailing = share;
        for (let d = 0; d < 4 && trailing.parentElement && trailing.parentElement !== row; d++) trailing = trailing.parentElement;
        return trailing.parentElement === row ? { host: row, before: trailing } : null;
    }

    // X puts bookmark + share in one cluster at the end of the action row. Joining that cluster
    // keeps our button aligned with the native icons instead of becoming an extra spaced item.
    function shareCluster(group) {
        const kids = [...group.children].filter((c) => !c.classList.contains('xc-controls'));
        const last = kids[kids.length - 1];
        if (!last) return null;
        const inner = [...last.children].filter((c) => !c.classList.contains('xc-controls'));
        return inner.length >= 2 && last.querySelector('button, [role="button"]') ? last : null;
    }

    function matchIconColor(group, controls) {
        const ref = group.querySelector('[data-testid="reply"] svg, [data-testid="like"] svg, [data-testid="bookmark"] svg')
            || [...group.querySelectorAll('svg')].find((s) => !s.closest('.xc-controls'));
        if (!ref) return;
        const color = getComputedStyle(ref).color;
        if (color) controls.style.setProperty('--xc-icon', color);
    }

    function placeControls(article, controls) {
        const group = topLevel(article, '[role="group"]');
        if (group) {
            controls.classList.remove('guest', 'floating'); controls.classList.add('in-group');
            const host = shareCluster(group);
            if (host) {
                if (controls.parentElement !== host || host.firstElementChild !== controls) host.insertBefore(controls, host.firstElementChild);
            } else if (controls.parentElement !== group) group.appendChild(controls);
            matchIconColor(group, controls);
            return;
        }
        const guest = guestPlacement(article);
        if (guest) {
            controls.classList.remove('floating'); controls.classList.add('in-group', 'guest');
            if (controls.parentElement !== guest.host || controls.nextSibling !== guest.before) guest.host.insertBefore(controls, guest.before);
            matchIconColor(guest.host, controls);
            return;
        }
        controls.classList.remove('in-group', 'guest'); controls.classList.add('floating');
        controls.style.removeProperty('--xc-icon');
        if (!article.style.position) article.style.position = 'relative';
        if (controls.parentElement !== article) article.appendChild(controls);
    }

    function injectButtons(scope) {
        const root = scope && scope.querySelectorAll ? scope : document;
        const articles = root.matches && root.matches('article') ? [root] : [...root.querySelectorAll('article')];
        for (const article of articles) {
            if (article.closest('#xc-root') || article.closest('[data-testid="notification"]')) continue;
            const statusId = getStatusId(article);
            const existing = article.querySelector('.xc-controls');
            if (existing) {
                if (statusId) existing.dataset.statusId = statusId;
                placeControls(article, existing);
                continue;
            }
            if (!statusId) continue;
            const hasDomMedia = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"], img[src*="pbs.twimg.com/media/"], video[poster]');
            if (!hasDomMedia && !mediaRegistry.has(statusId) && !cardRegistry.has(statusId)) continue;

            const controls = h('span', { class: 'xc-controls', 'data-status-id': statusId });
            const dl = h('button', { class: 'xc-dl', type: 'button', title: 'Download media', 'aria-label': 'Download media' });
            dl.innerHTML = ICON_DL;
            dl.dataset.rk = 'idle';
            dl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handleDownloadClick(article); }, true);
            const cancel = h('button', { class: 'xc-cancel', type: 'button', title: 'Cancel download', 'aria-label': 'Cancel download', hidden: true }, '×');
            cancel.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); cancelJob(controls.dataset.statusId); }, true);
            controls.append(dl, cancel);
            placeControls(article, controls);
        }
        scheduleUi();
    }

    function refreshUi() {
        document.querySelectorAll('.xc-controls[data-status-id]').forEach((control) => {
            const id = control.dataset.statusId || '';
            const job = jobs.get(id);
            const dl = control.querySelector('.xc-dl');
            const cancel = control.querySelector('.xc-cancel');
            if (!dl) return;
            const active = isActive(job), looking = pendingLookups.has(id);
            const before = !active && !looking && Downloaded.has(id);
            const p = jobProgress(job || { progress: [] });
            dl.classList.toggle('progress', active || looking);
            dl.classList.toggle('before', before);
            dl.style.setProperty('--xc-deg', p.percent * 3.6 + 'deg');
            const rk = looking ? 'text:…'
                : (job && job.status === 'done' ? 'done' : (job && !before ? 'text:' + describeJob(job, true) : (before ? 'done' : 'idle')));
            if (dl.dataset.rk !== rk) {
                dl.dataset.rk = rk;
                if (rk === 'idle') dl.innerHTML = ICON_DL;
                else if (rk === 'done') dl.innerHTML = ICON_OK;
                else dl.textContent = rk.slice(5);
            }
            const label = looking ? 'Looking up original media' : (job ? describeJob(job, false) : (before ? 'Downloaded before; click to download again' : 'Download media'));
            dl.title = label; dl.setAttribute('aria-label', label);
            if (cancel) cancel.hidden = !active;
        });
        Panel.refresh();
    }

    /* ==================================================================
     * 10. PANEL UI (tasks + settings)
     * ================================================================== */
    GM_addStyle(`
    #xc-root{--xc-bg:#fff;--xc-fg:#0f1419;--xc-mut:#536471;--xc-bd:#cfd9de;--xc-ac:#1d9bf0;position:fixed;right:16px;bottom:84px;z-index:2147483000;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--xc-fg)}
    @media (prefers-color-scheme:dark){#xc-root{--xc-bg:#16181c;--xc-fg:#e7e9ea;--xc-mut:#8b98a5;--xc-bd:#2f3336}}
    #xc-fab{position:relative;display:grid;place-items:center;width:46px;height:46px;padding:0;border-radius:50%;border:0;background:var(--xc-ac);color:#fff;cursor:grab;box-shadow:0 3px 14px rgba(0,0,0,.35);touch-action:none;user-select:none;-webkit-user-select:none}
    #xc-fab.drag{cursor:grabbing;opacity:.9}
    #xc-fab svg{width:22px;height:22px;pointer-events:none}
    #xc-fab .xc-badge{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;border-radius:9px;background:#f4212e;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 4px}
    #xc-fab .xc-badge[hidden]{display:none}
    #xc-root.xc-hidefab #xc-fab{display:none}
    #xc-panel{position:fixed;overflow:auto;background:var(--xc-bg);border:1px solid var(--xc-bd);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.4);z-index:2147483001}
    .xc-ph{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--xc-bd);position:sticky;top:0;background:var(--xc-bg)}
    .xc-ph b{flex:1;font-size:15px}
    .xc-tab{background:none;border:0;color:var(--xc-mut);padding:4px 9px;border-radius:7px;cursor:pointer;font:inherit}
    .xc-tab[aria-selected=true]{background:var(--xc-bd);color:var(--xc-fg)}
    .xc-pb{padding:10px 12px;display:flex;flex-direction:column;gap:9px}
    .xc-row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    .xc-row label{flex:1}
    .xc-in,.xc-sel{background:var(--xc-bg);color:var(--xc-fg);border:1px solid var(--xc-bd);border-radius:7px;padding:5px 7px;font:inherit}
    .xc-in.full{width:100%;box-sizing:border-box}
    .xc-help{color:var(--xc-mut);font-size:12px;line-height:1.4}
    .xc-btn{background:var(--xc-bd);color:var(--xc-fg);border:0;border-radius:7px;padding:5px 10px;cursor:pointer;font:inherit}
    .xc-btn.pri{background:var(--xc-ac);color:#fff}
    .xc-btn:focus-visible,.xc-tab:focus-visible,#xc-fab:focus-visible,.xc-dl:focus-visible{outline:2px solid var(--xc-ac);outline-offset:2px}
    .xc-job{display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--xc-bd)}
    .xc-job .xc-jm{flex:1;min-width:0}
    .xc-job .xc-jm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
    .xc-job .xc-jm span{color:var(--xc-mut);font-size:12px}
    .xc-controls{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;align-self:center;margin:0 2px;color:var(--xc-icon,rgb(83,100,113))}
    .xc-controls.guest{flex:1 1 0%;min-width:0;margin:0}
    .xc-controls.floating{position:absolute;top:8px;right:8px;z-index:5;background:rgba(0,0,0,.62);border-radius:999px;padding:2px;margin:0;--xc-icon:#fff;color:#fff}
    .xc-dl,.xc-cancel{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:0;background:transparent;color:inherit;border-radius:50%;cursor:pointer;font:700 11px/1 -apple-system,BlinkMacSystemFont,sans-serif;transition:background-color .15s,color .15s}
    .xc-dl svg{width:18.75px;height:18.75px;display:block;pointer-events:none}
    .xc-dl:hover,.xc-dl:focus-visible{background:rgba(29,155,240,.1);color:rgb(29,155,240)}
    .xc-dl.progress{color:rgb(29,155,240);background:conic-gradient(rgba(29,155,240,.28) var(--xc-deg,0deg),transparent 0)}
    .xc-dl.before{color:rgb(29,155,240)}
    .xc-cancel{width:24px;height:24px;color:rgb(244,33,46);font-size:16px}
    .xc-cancel:hover{background:rgba(244,33,46,.12)}
    .xc-cancel[hidden]{display:none!important}
    article[data-testid="notification"] .xc-controls{display:none!important}
    .xc-toasts{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483600;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
    .xc-toast{background:#15181c;color:#fff;padding:9px 15px;border-radius:10px;font:13px -apple-system,sans-serif;max-width:80vw;transition:opacity .3s;box-shadow:0 6px 24px rgba(0,0,0,.4)}
    .xc-toast.ok{background:#15803d}.xc-toast.warn{background:#b45309}.xc-toast.error{background:#b91c1c}
    @media (prefers-reduced-motion:reduce){.xc-toast,.xc-dl{transition:none}}
    `);

    const SETTING_FIELDS = [
        { k: 'zip', label: 'Bundle multiple files into a ZIP', type: 'bool' },
        { k: 'gifFormat', label: 'Save GIF posts as', type: 'select', options: [['mp4', 'MP4 (original, best quality)'], ['gif', 'GIF (converted in your browser, slower)']] },
        { k: 'gifQuality', label: 'GIF conversion quality', type: 'select', options: [['high', 'High (up to 720 px, 15 fps)'], ['standard', 'Standard (up to 480 px, 10 fps)']] },
        { k: 'trackDownloaded', label: 'Remember downloaded posts (ask before repeating)', type: 'bool' },
        { k: 'concurrency', label: 'Parallel downloads (1–6)', type: 'number', min: 1, max: 6 },
        { k: 'timeoutSec', label: 'Download timeout (seconds)', type: 'number', min: 5, max: 600 },
        { k: 'networkCapture', label: 'Capture media from X network responses (reload to apply)', type: 'bool' },
        { k: 'showButton', label: 'Show the floating button', type: 'bool' }
    ];

    const Panel = {
        root: null, panel: null, body: null, tab: 'tasks', fab: null, badge: null,

        defaultPos() { return { right: 16, bottom: isMobile() ? 150 : 84 }; },

        // The floating button can be dragged anywhere; its position is remembered.
        applyPos() {
            if (!this.root) return;
            const p = Settings.get('fabPos') || this.defaultPos();
            const size = 46, m = 6;
            this.root.style.right = Math.max(m, Math.min(window.innerWidth - size - m, p.right)) + 'px';
            this.root.style.bottom = Math.max(m, Math.min(window.innerHeight - size - m, p.bottom)) + 'px';
            this.positionPanel();
        },

        build() {
            this.badge = h('span', { class: 'xc-badge', hidden: true });
            this.fab = h('button', { id: 'xc-fab', type: 'button', title: 'Xcavate (drag to move)', 'aria-label': 'Open Xcavate' }, this.badge);
            this.fab.insertAdjacentHTML('afterbegin', ICON_DL);
            this.root = h('div', { id: 'xc-root' }, this.fab);
            document.body.append(this.root);
            this.bindDrag();
            this.applyVisibility();
            this.applyPos();
            window.addEventListener('resize', () => this.applyPos());
        },

        bindDrag() {
            const fab = this.fab;
            let start = null;
            fab.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                const r = this.root.getBoundingClientRect();
                start = { id: e.pointerId, x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, moved: false };
                try { fab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            });
            fab.addEventListener('pointermove', (e) => {
                if (!start || start.id !== e.pointerId) return;
                const dx = e.clientX - start.x, dy = e.clientY - start.y;
                if (!start.moved && Math.hypot(dx, dy) < 5) return;
                start.moved = true;
                fab.classList.add('drag');
                this.root.style.right = Math.max(6, Math.min(window.innerWidth - 52, start.right - dx)) + 'px';
                this.root.style.bottom = Math.max(6, Math.min(window.innerHeight - 52, start.bottom - dy)) + 'px';
                this.positionPanel();
            });
            const end = (e) => {
                if (!start || start.id !== e.pointerId) return;
                const moved = start.moved;
                start = null;
                fab.classList.remove('drag');
                try { fab.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                if (moved) {
                    const r = this.root.getBoundingClientRect();
                    Settings.patch({ fabPos: { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) } });
                } else if (e.type === 'pointerup') this.toggle();
            };
            fab.addEventListener('pointerup', end);
            fab.addEventListener('pointercancel', end);
            fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(); } });
        },

        // Open the panel on whichever side has room, next to the button.
        positionPanel() {
            if (!this.panel || !this.root) return;
            const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
            const r = this.root.getBoundingClientRect();
            const width = Math.min(420, vw - pad * 2);
            let left = r.left + r.width / 2 > vw / 2 ? r.right - width : r.left;
            left = Math.max(pad, Math.min(vw - width - pad, left));
            const st = this.panel.style;
            st.width = width + 'px';
            st.left = left + 'px';
            if (r.top > vh / 2) { st.top = 'auto'; st.bottom = (vh - r.top + 10) + 'px'; st.maxHeight = Math.max(160, r.top - 10 - pad) + 'px'; }
            else { st.bottom = 'auto'; st.top = (r.bottom + 10) + 'px'; st.maxHeight = Math.max(160, vh - r.bottom - 10 - pad) + 'px'; }
        },

        applyVisibility() { if (this.root) this.root.classList.toggle('xc-hidefab', !Settings.get('showButton')); },
        toggle() { if (this.panel) this.close(); else this.open(this.tab); },
        open(tab) {
            if (!this.root) return;
            this.tab = tab || this.tab;
            if (!this.panel) {
                this.panel = h('div', { id: 'xc-panel', role: 'dialog', 'aria-label': 'Xcavate' });
                this.root.append(this.panel);
            }
            this.render();
            this.positionPanel();
        },
        close() { if (this.panel) { this.panel.remove(); this.panel = null; this.body = null; } },
        render() {
            if (!this.panel) return;
            const tabBtn = (id, label) => h('button', { class: 'xc-tab', type: 'button', 'aria-selected': this.tab === id ? 'true' : 'false', onclick: () => { this.tab = id; this.render(); } }, label);
            this.body = h('div', { class: 'xc-pb' });
            this.panel.replaceChildren(
                h('div', { class: 'xc-ph' }, h('b', {}, 'Xcavate'), tabBtn('tasks', 'Tasks'), tabBtn('settings', 'Settings'),
                    h('button', { class: 'xc-tab', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '✕')),
                this.body);
            this.renderBody();
        },
        renderBody() {
            if (!this.body) return;
            this.body.replaceChildren(...(this.tab === 'tasks' ? this.tasksView() : this.settingsView()));
        },
        refresh() {
            const active = [...jobs.values()].filter(isActive).length;
            if (this.badge) { this.badge.hidden = active === 0; this.badge.textContent = String(active); }
            if (this.panel && this.tab === 'tasks') this.renderBody();
        },
        tasksView() {
            const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
            if (!list.length) return [h('div', { class: 'xc-help' }, 'No downloads yet. Use the download button in the action row of any post with media.')];
            return list.map((job) => h('div', { class: 'xc-job' },
                h('div', { class: 'xc-jm' }, h('b', { title: job.title }, job.title), h('span', {}, describeJob(job, false) + (job.quality ? ' · ' + job.quality : ''))),
                isActive(job) && job.status !== 'cancelling' ? h('button', { class: 'xc-btn', type: 'button', onclick: () => cancelJob(job.statusId) }, 'Cancel') : null,
                job.status === 'error' || job.status === 'cancelled' ? h('button', { class: 'xc-btn', type: 'button', onclick: () => retryJob(job.statusId) }, 'Retry') : null));
        },
        settingsView() {
            const rows = SETTING_FIELDS.map((f) => {
                let input;
                if (f.type === 'bool') {
                    input = h('input', { type: 'checkbox', checked: !!Settings.get(f.k), onchange: (e) => { Settings.patch({ [f.k]: e.target.checked }); this.applyVisibility(); scheduleUi(); } });
                } else if (f.type === 'select') {
                    input = h('select', { class: 'xc-sel', onchange: (e) => Settings.patch({ [f.k]: e.target.value }) },
                        f.options.map(([v, l]) => { const o = h('option', { value: v }, l); if (Settings.get(f.k) === v) o.selected = true; return o; }));
                } else {
                    input = h('input', { class: 'xc-in', type: 'number', min: f.min, max: f.max, value: Settings.get(f.k), style: 'width:80px', onchange: (e) => { Settings.patch({ [f.k]: e.target.value }); e.target.value = Settings.get(f.k); pumpTransfers(); } });
                }
                return h('div', { class: 'xc-row' }, h('label', {}, f.label), input);
            });

            const fileIn = h('input', { class: 'xc-in full', value: Settings.get('fileTemplate'), maxlength: 180, spellcheck: false });
            const zipIn = h('input', { class: 'xc-in full', value: Settings.get('zipTemplate'), maxlength: 180, spellcheck: false });
            const reIn = h('input', { class: 'xc-in full', value: Settings.get('nameRegex'), maxlength: 100, spellcheck: false, placeholder: 'e.g. [\\s_]+' });
            const repIn = h('input', { class: 'xc-in full', value: Settings.get('nameReplacement'), maxlength: 100, spellcheck: false, placeholder: 'e.g. _' });
            const preview = h('div', { class: 'xc-help' });
            const updatePreview = () => {
                const demo = {
                    handle: 'example', displayName: 'Example User', statusId: '1234567890', postText: 'Sample post text', postDate: '2026-01-02T03:04:05Z', createdAt: now(),
                    fileTemplate: fileIn.value || DEFAULTS.fileTemplate, zipTemplate: zipIn.value || DEFAULTS.zipTemplate,
                    nameRegex: isSafeRegex(reIn.value) ? reIn.value : '', nameReplacement: repIn.value,
                    items: [{ url: 'https://pbs.twimg.com/media/Abc123.jpg', ext: 'jpg', mediaType: 'image', index: 0 }, { url: 'https://pbs.twimg.com/media/Def456.jpg', ext: 'jpg', mediaType: 'image', index: 1 }]
                };
                preview.textContent = 'Preview: ' + itemFilename(demo, demo.items[0]) + '  ·  ' + zipFilename(demo);
            };
            [fileIn, zipIn, reIn, repIn].forEach((i) => i.addEventListener('input', updatePreview));
            updatePreview();

            const save = h('button', {
                class: 'xc-btn pri', type: 'button', onclick: () => {
                    if (reIn.value && !isSafeRegex(reIn.value)) { toast('That regex is invalid or too risky, so it was not saved.', 'warn'); return; }
                    Settings.patch({ fileTemplate: fileIn.value, zipTemplate: zipIn.value, nameRegex: reIn.value, nameReplacement: repIn.value });
                    toast('Naming saved', 'ok');
                }
            }, 'Save naming');

            return [
                ...rows,
                h('div', { class: 'xc-help' }, 'File naming. Variables: {handle} {name} {id} {date} {text} {type} {file} {index}'),
                h('label', {}, 'File name', fileIn), h('label', {}, 'ZIP name', zipIn),
                h('label', {}, 'Regex replace (optional)', reIn), h('label', {}, 'Replace with', repIn),
                preview,
                h('div', { class: 'xc-row' }, save,
                    h('button', { class: 'xc-btn', type: 'button', onclick: () => { Settings.patch({ fabPos: null }); this.applyPos(); toast('Button position reset', 'ok'); } }, 'Reset button position'),
                    h('button', { class: 'xc-btn', type: 'button', onclick: () => { GM_setClipboard(Diag.report(), 'text'); toast('Debug info copied', 'ok'); } }, 'Copy debug info'),
                    h('button', { class: 'xc-btn', type: 'button', onclick: () => { if (window.confirm('Forget all downloaded posts?')) { Downloaded.clear(); scheduleUi(); toast('History cleared', 'ok'); } } }, 'Clear history'))
            ];
        }
    };

    /* ==================================================================
     * 11. BOOT
     * ================================================================== */
    installHooks();

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Xcavate: open panel', () => Panel.open('tasks'));
        GM_registerMenuCommand('Xcavate: show / hide floating button', () => { Settings.patch({ showButton: !Settings.get('showButton') }); Panel.applyVisibility(); });
        GM_registerMenuCommand('Xcavate: toggle network capture (reloads page)', () => { Settings.patch({ networkCapture: !Settings.get('networkCapture') }); location.reload(); });
    }

    function startObserver() {
        const pending = new Set();
        let timer = null;
        const flush = () => {
            timer = null;
            const roots = [...pending];
            pending.clear();
            for (const root of roots) {
                if (!root.isConnected) continue;
                const article = root.closest ? root.closest('article') : null;
                injectButtons(article || root);
            }
        };
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (node.id === 'xc-root' || (node.closest && node.closest('#xc-root'))) continue;
                    pending.add(node);
                }
                if (m.type === 'childList' && m.target instanceof HTMLElement && !m.target.closest('#xc-root') && m.addedNodes.length) pending.add(m.target);
            }
            if (pending.size && !timer) timer = setTimeout(flush, 120);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        injectButtons(document);
    }

    function boot() {
        Panel.build();
        startObserver();
        window.addEventListener('keydown', (e) => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); Panel.toggle(); }
            else if (e.key === 'Escape' && Panel.panel) Panel.close();
        });
        setInterval(installHooks, 5000); // re-apply if another script replaced our hooks (capped)
        Diag.push('info', 'boot', 'ready v' + VERSION);
    }

    function waitForBody() {
        if (document.body) { boot(); return; }
        const t = setInterval(() => { if (document.body) { clearInterval(t); boot(); } }, 100);
    }
    waitForBody();
})();

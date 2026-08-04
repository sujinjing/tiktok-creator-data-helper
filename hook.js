/**
 * 达人数据助手 - 劫持脚本
 * 该脚本专门运行在页面的主世界上下文中（world: MAIN）
 * 用以规避 CSP 限制，实时拦截页面请求并在页面上下文中执行视频解析下载
 */

const API_EVENT_TYPE = 'TIKTOK_API_DATA_EVENT';
const DOWNLOAD_REQUEST_TYPE = 'TIKTOK_HELPER_DOWNLOAD_REQUEST';
const DOWNLOAD_STATUS_TYPE = 'TIKTOK_HELPER_DOWNLOAD_STATUS';

(function() {
  console.log("[达人数据助手] hook.js 劫持脚本已成功在主世界加载，开始劫持网络请求...");
  hijackFetchRequests();
  hijackXhrRequests();
  initCommerceLinkCapture();
  initDownloadBridge();
})();

/**
 * 改写页面原生的 window.fetch 方法，拦截特定接口的数据包并发送页面消息（支持 Request 对象）
 */
function hijackFetchRequests() {
  const originFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originFetch(...args);
    let url = args[0];

    // 兼容 args[0] 为 Request 对象的情况
    if (url && typeof url === 'object' && typeof url.url === 'string') {
      url = url.url;
    }

    // 拦截列表、详情以及 TikTok Shop 商品相关接口，复用页面自己生成的签名与登录态。
    if (shouldCaptureTikTokApi(url)) {
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (shouldForwardTikTokApiResponse(url, text, clone.headers.get('content-type') || '')) {
          postCapturedTikTokApi(url, text);
        }
      } catch (e) {
        // 忽略克隆或转换错误
      }
    }
    return response;
  };
}

/**
 * 劫持 XMLHttpRequest 的 send 和 open 方法，实时捕获传统的 Ajax 异步通信数据并发送消息（支持 URL 对象）
 */
function hijackXhrRequests() {
  const originOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url ? url.toString() : '';
    return originOpen.apply(this, arguments);
  };

  const originSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      const url = this._url;
      if (shouldCaptureTikTokApi(url)) {
        try {
          const text = this.responseText;
          if (shouldForwardTikTokApiResponse(url, text, this.getResponseHeader('content-type') || '')) {
            postCapturedTikTokApi(url, text);
          }
        } catch (e) {
          // 忽略转换异常
        }
      }
    });
    return originSend.apply(this, arguments);
  };
}

/**
 * 判断接口响应里是否可能包含视频元数据。
 * @param {string} url - 请求地址
 * @returns {boolean} 是否需要转发给隔离世界解析
 */
function shouldCaptureTikTokApi(url) {
  if (typeof url !== 'string') return false;
  if ([
    '/api/post/item_list',
    '/api/user/item_list',
    '/api/user/post',
    '/api/creator/item_list',
    '/api/profile/item_list',
    '/api/user/collection_list',
    '/api/favorite/item_list',
    '/api/item/detail',
    '/api/recommend/item_list',
    '/api/related/item_list',
    '/player/api/v1/items'
  ].some((pattern) => url.includes(pattern))) {
    return true;
  }

  try {
    const parsed = new URL(url, location.origin);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.endsWith('tiktok.com') &&
        /\/api\/(?:post|user|creator|profile)\/.+(?:item[_-]?list|posts?)(?:\/|$)/.test(path)) {
      return true;
    }
  } catch (error) {
    // 无法解析的 URL 继续交给电商接口规则判断。
  }

  return isCommerceFocusedApiUrl(url);
}

/**
 * 商品接口路径会随地区和版本变化，因此使用稳定的业务关键词匹配页面真实请求。
 */
function isCommerceFocusedApiUrl(url) {
  try {
    const rawUrl = String(url || '');
    if (/^tiktok:\/\//i.test(rawUrl)) {
      return /shopping|product|goods|pdp|product_id/i.test(rawUrl);
    }
    const parsed = new URL(rawUrl, location.origin);
    const host = parsed.hostname.toLowerCase();
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (!host.endsWith('tiktok.com') && !host.endsWith('tiktokshop.com') && !host.endsWith('tiktokv.com')) {
      return false;
    }
    if (/\/api\/(?:log|report|event|track|monitor|search)/.test(path)) return false;
    return /(?:^|[\/_-])(product|goods|shop|commerce|ecommerce|anchor|pdp|sku|seller)(?:[\/_?=&-]|$)/.test(path) ||
      /\/view\/product\//.test(path);
  } catch (error) {
    return false;
  }
}

function shouldForwardTikTokApiResponse(url, text, contentType) {
  const body = String(text || '');
  if (!body || body.length > 8 * 1024 * 1024) return false;
  if (!isCommerceFocusedApiUrl(url)) return true;

  const type = String(contentType || '').toLowerCase();
  if (type.includes('json')) return true;
  return /product_id|productId|goods_id|placeholder_product_id|shop_anchor|tiktok_shop|product_model|promotion_model/i.test(body);
}

function postCapturedTikTokApi(url, text) {
  window.postMessage({
    type: API_EVENT_TYPE,
    text,
    url: String(url || ''),
    videoId: getCurrentTikTokVideoId(),
    commerceFocused: isCommerceFocusedApiUrl(url)
  }, '*');
}

function getCurrentTikTokVideoId() {
  const match = String(location.pathname || '').match(/\/video\/(\d{8,})/);
  return match ? match[1] : '';
}

function initCommerceLinkCapture() {
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!target || !isCommerceFocusedApiUrl(target.href)) return;
    postCapturedTikTokApi(target.href, '{}');
  }, true);
}

/**
 * 监听隔离世界发来的下载请求，并在页面主世界里执行真实下载流程
 */
function initDownloadBridge() {
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== DOWNLOAD_REQUEST_TYPE) return;

    const { requestId, videoId, filename, preferredUrl, mode, detailUrl, includeCommerceDetail } = event.data;
    handleDownloadRequest({ requestId, videoId, filename, preferredUrl, mode, detailUrl, includeCommerceDetail }).catch((error) => {
      postDownloadStatus(requestId, 'error', error && error.message ? error.message : '下载失败');
    });
  });
}

/**
 * 在主世界中解析出真实媒体地址并下载为本地文件
 * @param {Object} payload - 下载参数
 */
async function handleDownloadRequest(payload) {
  const { requestId, videoId, filename, preferredUrl, mode, detailUrl, includeCommerceDetail } = payload;
  if (!requestId) return;
  if (!videoId) {
    throw new Error('缺少视频 ID，无法解析下载地址');
  }

  const commerceOnly = mode === 'resolveCommerce';
  postDownloadStatus(requestId, 'started', commerceOnly ? '正在解析视频挂车商品...' : '正在解析视频下载地址...');

  let mediaUrl = '';
  let products = [];
  let commerceMeta = {
    sourceStatuses: []
  };
  if (!commerceOnly) {
    try {
      const playerPayload = await fetchTikTokPlayerPayload(videoId);
      mediaUrl = extractBestMediaUrl(playerPayload);
      products = extractCommerceProducts(playerPayload);
      commerceMeta = normalizeCommerceMeta(
        mergeCommerceMeta(commerceMeta, {
          ...extractCommerceMeta(playerPayload),
          sourceStatuses: [buildSourceStatus('player', products.length ? 'products' : 'no-products')]
        }),
        products
      );
    } catch (error) {
      console.warn('[达人数据助手] 通过播放器接口解析下载地址失败，准备使用兜底地址。', error);
      commerceMeta = mergeCommerceMeta(commerceMeta, {
        sourceStatuses: [buildSourceStatus('player', 'error', error && error.message ? error.message : '')]
      });
    }
  }

  if ((commerceOnly || includeCommerceDetail) && (!products.length || commerceMeta.isCommerceVideo || commerceMeta.productHints > 0)) {
    try {
      postDownloadStatus(requestId, 'started', '正在补充解析视频挂车商品...');
      const detailCommerce = await fetchVideoDetailCommerce(videoId, detailUrl);
      products = mergeCommerceProducts(products, detailCommerce.products || []);
      commerceMeta = normalizeCommerceMeta(
        mergeCommerceMeta(commerceMeta, detailCommerce.commerceMeta),
        products
      );
    } catch (error) {
      console.warn('[达人数据助手] 视频详情商品解析失败，继续使用已有商品信息。', error);
      commerceMeta = normalizeCommerceMeta(
        mergeCommerceMeta(commerceMeta, {
          sourceStatuses: [buildSourceStatus('detail-commerce', 'error', error && error.message ? error.message : '')]
        }),
        products
      );
    }
  }

  if (commerceOnly) {
    postDownloadStatus(requestId, 'success', '挂车商品解析完成', { mediaUrl, products, commerceMeta });
    return;
  }

  if (!mediaUrl && preferredUrl) {
    mediaUrl = preferredUrl;
  }
  if (!mediaUrl) {
    throw new Error('未解析到可用的视频下载地址');
  }

  if (mode === 'resolveUrl') {
    postDownloadStatus(requestId, 'success', '下载地址解析完成', { mediaUrl, products, commerceMeta });
    return;
  }

  postDownloadStatus(requestId, 'success', '下载地址解析完成', { mediaUrl, filename: filename || `tiktok_${videoId}.mp4`, products, commerceMeta });
}

/**
 * 发起 TikTok 播放器接口请求，参考 video-parser-expert 项目的解析链路
 * @param {string} videoId - 视频 ID
 * @returns {Promise<Object>} 播放器接口返回的 JSON
 */
async function fetchTikTokPlayerPayload(videoId) {
  const query = new URLSearchParams({
    item_ids: videoId,
    language: 'zh-CN',
    aid: '1284',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    region: 'JP',
    priority_region: 'JP',
    os: 'mac',
    referer: '',
    screen_width: String(window.screen.width || 1920),
    screen_height: String(window.screen.height || 1080),
    browser_language: navigator.language || 'zh-CN',
    browser_platform: navigator.platform || 'MacIntel',
    browser_name: 'Mozilla',
    browser_version: navigator.userAgent || '',
    browser_online: navigator.onLine ? 'true' : 'false',
    app_language: 'en',
    timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    is_page_visible: document.visibilityState === 'visible' ? 'true' : 'false',
    focus_state: document.hasFocus() ? 'true' : 'false',
    is_fullscreen: document.fullscreenElement ? 'true' : 'false',
    history_len: String(window.history.length || 2),
    security_verification_aid: '',
    device_id: '',
    msToken: ''
  });

  const apiUrl = `https://www.tiktok.com/player/api/v1/items?${query.toString()}`;
  const response = await fetch(apiUrl, {
    method: 'GET',
    credentials: 'include',
    referrer: getTikTokPlayerUrl(videoId),
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      'Accept': 'application/json, text/plain, */*'
    }
  });

  if (!response.ok) {
    throw new Error(`播放器接口请求失败（${response.status}）`);
  }

  return response.json();
}

/**
 * 播放预览时补抓视频详情页，尽量读取详情 JSON 里的 anchors.extra 商品字段。
 * 这比伪装 TikTok App 私有接口稳定，且能复用当前网页登录态。
 * @param {string} videoId - 视频 ID
 * @param {string} detailUrl - 卡片上的视频详情页地址
 * @returns {Promise<{products: Array, commerceMeta: Object}>} 解析出的商品与挂车信号
 */
async function fetchVideoDetailCommerce(videoId, detailUrl) {
  const detailPayloads = [];
  const resolvedDetailUrl = resolveTikTokDetailUrl(videoId, detailUrl);

  if (resolvedDetailUrl) {
    try {
      const html = await fetchTikTokDetailHtml(resolvedDetailUrl);
      const htmlPayloads = extractJsonPayloadsFromHtml(html);
      detailPayloads.push(...htmlPayloads);
      detailPayloads.push({
        __helperCommerceStatus: buildSourceStatus('detail-html', htmlPayloads.length ? 'payloads' : 'no-payload')
      });
    } catch (error) {
      console.warn('[达人数据助手] 读取视频详情页 JSON 失败。', error);
      detailPayloads.push({
        __helperCommerceStatus: buildSourceStatus('detail-html', 'error', error && error.message ? error.message : '')
      });
    }
  }

  try {
    const apiPayload = await fetchTikTokItemDetailPayload(videoId, resolvedDetailUrl);
    if (apiPayload) {
      detailPayloads.push(apiPayload);
      detailPayloads.push({
        __helperCommerceStatus: buildSourceStatus('item-detail', 'payload')
      });
    }
  } catch (error) {
    console.warn('[达人数据助手] 读取 item/detail 接口失败。', error);
    detailPayloads.push({
      __helperCommerceStatus: buildSourceStatus('item-detail', 'error', error && error.message ? error.message : '')
    });
  }

  let products = [];
  let commerceMeta = {};
  detailPayloads.forEach((payload) => {
    const helperStatus = payload && payload.__helperCommerceStatus;
    if (helperStatus) {
      commerceMeta = mergeCommerceMeta(commerceMeta, { sourceStatuses: [helperStatus] });
      return;
    }
    const payloadProducts = extractCommerceProducts(payload);
    products = mergeCommerceProducts(products, payloadProducts);
    commerceMeta = normalizeCommerceMeta(
      mergeCommerceMeta(commerceMeta, {
        ...extractCommerceMeta(payload),
        sourceStatuses: [buildSourceStatus('detail-payload', payloadProducts.length ? 'products' : 'no-products')]
      }),
      products
    );
  });

  return { products, commerceMeta: normalizeCommerceMeta(commerceMeta, products) };
}

function resolveTikTokDetailUrl(videoId, detailUrl) {
  const candidates = [];
  if (detailUrl) candidates.push(detailUrl);
  if (typeof location !== 'undefined' && location.href && location.href.includes(`/video/${videoId}`)) {
    candidates.push(location.href);
  }
  if (typeof document !== 'undefined') {
    const link = document.querySelector(`a[href*="/video/${videoId}"]`);
    if (link && link.href) candidates.push(link.href);
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, location.origin);
      if (url.hostname.endsWith('tiktok.com') && url.pathname.includes(`/video/${videoId}`)) {
        url.hash = '';
        return url.toString();
      }
    } catch (error) {
      // 忽略非法 URL
    }
  }
  return '';
}

async function fetchTikTokDetailHtml(detailUrl) {
  const response = await fetch(detailUrl, {
    method: 'GET',
    credentials: 'include',
    referrer: location.href,
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`详情页请求失败（${response.status}）`);
  }
  return response.text();
}

async function fetchTikTokItemDetailPayload(videoId, detailUrl) {
  const query = new URLSearchParams({
    itemId: videoId,
    aid: '1988',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    language: navigator.language || 'zh-CN',
    app_language: navigator.language || 'zh-CN',
    browser_language: navigator.language || 'zh-CN',
    browser_platform: navigator.platform || 'MacIntel',
    browser_name: 'Mozilla',
    browser_version: navigator.userAgent || '',
    browser_online: navigator.onLine ? 'true' : 'false',
    region: 'JP',
    priority_region: 'JP',
    os: 'mac',
    screen_width: String(window.screen.width || 1920),
    screen_height: String(window.screen.height || 1080),
    timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    is_page_visible: document.visibilityState === 'visible' ? 'true' : 'false',
    focus_state: document.hasFocus() ? 'true' : 'false',
    is_fullscreen: document.fullscreenElement ? 'true' : 'false',
    history_len: String(window.history.length || 2),
    referer: detailUrl || location.href
  });

  const apiUrl = `https://www.tiktok.com/api/item/detail/?${query.toString()}`;
  const response = await fetch(apiUrl, {
    method: 'GET',
    credentials: 'include',
    referrer: detailUrl || location.href,
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      'Accept': 'application/json, text/plain, */*'
    }
  });

  if (!response.ok) {
    throw new Error(`item/detail 请求失败（${response.status}）`);
  }
  return response.json();
}

function extractJsonPayloadsFromHtml(html) {
  const payloads = [];
  if (!html || typeof html !== 'string') return payloads;

  const pushJsonText = (text) => {
    if (!text || payloads.length >= 12) return;
    const jsonText = extractJsonFromScript(text.trim());
    if (!jsonText) return;
    try {
      const safeText = jsonText.replace(/:\s*(\d{16,21})/g, ': "$1"');
      payloads.push(JSON.parse(safeText));
    } catch (error) {
      // 忽略非 JSON 脚本
    }
  };

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script').forEach((script) => {
        const id = script.id || '';
        const content = script.textContent || '';
        const isDataScript = id === '__UNIVERSAL_DATA_FOR_REHYDRATION__' ||
                             id === 'SIGI_STATE' ||
                             id === 'sigi-state' ||
                             (script.type === 'application/json' && looksLikeVideoDataJson(content)) ||
                             (content.includes('anchors') && content.includes('video'));
        if (isDataScript) pushJsonText(content);
      });
    } catch (error) {
      // DOMParser 不可用时走正则兜底
    }
  }

  if (!payloads.length) {
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRe.exec(html)) && payloads.length < 12) {
      const content = decodeHtmlEntities(match[1] || '');
      if (content.includes('anchors') || content.includes('SIGI_STATE') || content.includes('ItemModule')) {
        pushJsonText(content);
      }
    }
  }

  return payloads;
}

function looksLikeVideoDataJson(text) {
  if (!text || typeof text !== 'string') return false;
  return /ItemModule|itemInfo|itemStruct|aweme|anchors|AnchorTypes|product_id|shopping|createTime|create_time|diggCount|playCount/.test(text);
}

function extractJsonFromScript(text) {
  if (!text) return null;
  if (text.startsWith('{') && text.endsWith('}')) return text;
  if (text.startsWith('[') && text.endsWith(']')) return text;
  const match = text.match(/window\s*\.\s*[a-zA-Z0-9_]+\s*=\s*(\{[\s\S]*\});?\s*$/) ||
                text.match(/=\s*(\{[\s\S]*\});?\s*$/);
  return match ? match[1] : null;
}

function decodeHtmlEntities(text) {
  if (!text || !/[&<]/.test(text)) return text || '';
  if (typeof document === 'undefined') return text;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

/**
 * 从播放器接口返回值中挑选最优的视频播放地址
 * @param {Object} payload - 播放器接口返回值
 * @returns {string} 最佳媒体地址
 */
function extractBestMediaUrl(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return '';

  const item = items[0] || {};
  const video = item.video_info || item.videoInfo || {};
  const meta = video.meta || {};
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (url, extra = {}) => {
    if (!isPlayableMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      height: Number(extra.height || 0),
      bitrate: Number(extra.bitrate || 0),
      ext: extra.ext || inferExtFromUrl(url)
    });
  };

  const pushAddr = (addr, extra = {}) => {
    if (!addr) return;
    const urls = []
      .concat(addr.url_list || [])
      .concat(addr.urlList || [])
      .concat(addr.url ? [addr.url] : []);
    urls.forEach((url) => {
      pushCandidate(url, {
        height: addr.height || extra.height || meta.height,
        bitrate: addr.data_size || extra.bitrate || meta.bitrate,
        ext: extra.ext
      });
    });
  };

  (video.profiles || []).forEach((profile) => {
    const playAddr = profile.play_addr || profile.playAddr || {};
    pushAddr(playAddr, {
      height: playAddr.height || meta.height,
      bitrate: profile.bitrate || meta.bitrate
    });
  });

  pushAddr(video, { height: meta.height, bitrate: meta.bitrate });
  pushAddr(video.play_addr || video.playAddr, { height: meta.height, bitrate: meta.bitrate });
  pushAddr(video.download_addr || video.downloadAddr, { height: meta.height, bitrate: meta.bitrate });
  pushAddr(video.playAddrH264 || video.play_addr_h264, { height: meta.height, bitrate: meta.bitrate });
  pushAddr(video.bitrateInfo || video.bitrate_info, { height: meta.height, bitrate: meta.bitrate });
  pushAddr(item.video || {}, { height: meta.height, bitrate: meta.bitrate });

  if (!candidates.length) return '';

  candidates.sort((a, b) => {
    const extScoreA = a.ext === 'mp4' ? 1 : 0;
    const extScoreB = b.ext === 'mp4' ? 1 : 0;
    return (
      (b.height - a.height) ||
      (b.bitrate - a.bitrate) ||
      (extScoreB - extScoreA)
    );
  });

  return candidates[0].url || '';
}

/**
 * 过滤字幕、封面、头像等非视频资源。
 * @param {string} url - 候选媒体地址
 * @returns {boolean} 是否像可播放视频地址
 */
function isPlayableMediaUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('avatar') || lowerUrl.includes('cover') || lowerUrl.includes('/cla/') || lowerUrl.includes('caption')) {
    return false;
  }
  return (
    lowerUrl.includes('/video/') ||
    lowerUrl.includes('mime_type=video') ||
    lowerUrl.includes('mime=video') ||
    lowerUrl.includes('.mp4') ||
    lowerUrl.includes('tiktokcdn') ||
    lowerUrl.includes('tiktokv')
  );
}

function extractCommerceProducts(root) {
  const products = [];
  const seen = new Set();
  collectCommerceProducts(root, products, seen, 0, '');
  return products.slice(0, 12);
}

function extractCommerceMeta(root) {
  const meta = {
    isCommerceVideo: false,
    anchorTypes: [],
    productHints: 0,
    source: '',
    sourceStatuses: []
  };
  collectCommerceMeta(root, meta, 0, new Set());
  return meta;
}

function collectCommerceMeta(value, meta, depth, seen) {
  if (!value || depth > 8) return;

  if (typeof value === 'string') {
    const parsed = parsePossibleJson(value);
    if (parsed) {
      collectCommerceMeta(parsed, meta, depth + 1, seen);
    }
    return;
  }

  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item) => collectCommerceMeta(item, meta, depth + 1, seen));
    return;
  }

  if (value.isECVideo === 1 || value.isECVideo === true || value.is_ec_video === 1 || value.is_ec_video === true) {
    meta.isCommerceVideo = true;
    meta.source = meta.source || 'ec-video';
  }

  const anchorTypes = value.AnchorTypes || value.anchorTypes || value.anchor_types;
  if (Array.isArray(anchorTypes)) {
    let hasCommerceAnchorType = false;
    anchorTypes.forEach((type) => {
      const normalized = String(type || '').trim();
      if (normalized && !meta.anchorTypes.includes(normalized)) {
        meta.anchorTypes.push(normalized);
      }
      if (COMMERCE_ANCHOR_TYPES.includes(Number(type))) {
        hasCommerceAnchorType = true;
      }
    });
    // AnchorTypes 也会包含特效、模板等非商品锚点；只有已知商品锚点类型才直接判定为挂车。
    if (hasCommerceAnchorType) {
      meta.isCommerceVideo = true;
      meta.source = meta.source || 'anchor-types';
    }
  }

  if (looksLikeTikTokAnchor(value) && isCommerceAnchor(value)) {
    meta.isCommerceVideo = true;
    meta.productHints += 1;
    meta.source = meta.source || 'commerce-anchor';
    const rawType = value.type !== undefined ? value.type : (value.anchorType !== undefined ? value.anchorType : value.anchor_type);
    const normalizedType = String(rawType || '').trim();
    if (normalizedType && !meta.anchorTypes.includes(normalizedType)) {
      meta.anchorTypes.push(normalizedType);
    }
  }

  Object.values(value).forEach((child) => collectCommerceMeta(child, meta, depth + 1, seen));
}

function normalizeCommerceMeta(meta, products = []) {
  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  const anchorTypes = Array.isArray(safeMeta.anchorTypes)
    ? Array.from(new Set(safeMeta.anchorTypes.map((type) => String(type || '').trim()).filter(Boolean)))
    : [];
  const sourceStatuses = Array.isArray(safeMeta.sourceStatuses)
    ? Array.from(new Set(safeMeta.sourceStatuses.map((status) => String(status || '').trim()).filter(Boolean)))
    : [];
  const productCount = Array.isArray(products) ? products.filter((item) => item && item.name).length : 0;
  return {
    isCommerceVideo: Boolean(safeMeta.isCommerceVideo || safeMeta.isECVideo || safeMeta.is_ec_video || productCount > 0),
    anchorTypes,
    productHints: Number(safeMeta.productHints || 0),
    hasProducts: Boolean(safeMeta.hasProducts || productCount > 0),
    source: safeMeta.source || '',
    sourceStatuses
  };
}

function buildSourceStatus(label, status, detail = '') {
  return `${label}:${status}${detail ? `:${String(detail).slice(0, 80)}` : ''}`;
}

function collectCommerceProducts(value, products, seen, depth, path) {
  if (!value || depth > 8 || products.length >= 12) return;

  if (typeof value === 'string') {
    const parsed = parsePossibleJson(value);
    if (parsed) {
      collectCommerceProducts(parsed, products, seen, depth + 1, path);
    }
    return;
  }

  if (typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCommerceProducts(item, products, seen, depth + 1, `${path}.${index}`));
    return;
  }

  // TikTok 挂车商品挂在 item.anchors 节点下（商品名在 keyword 字段），优先按锚点结构解析
  if (looksLikeTikTokAnchor(value)) {
    if (isCommerceAnchor(value)) {
      pushUniqueProduct(products, seen, normalizeAnchorProduct(value));
    }
    // 锚点子级只有缩略图等资源，且 CapCut 模板等非商品锚点也无需下钻
    return;
  }

  if (looksLikeCommerceProduct(value, path)) {
    pushUniqueProduct(products, seen, normalizeCommerceProduct(value));
  }

  Object.entries(value).forEach(([key, child]) => {
    collectCommerceProducts(child, products, seen, depth + 1, path ? `${path}.${key}` : key);
  });
}

function pushUniqueProduct(products, seen, normalized) {
  if (!normalized || !normalized.name || products.length >= 12) return;
  const key = normalized.id || normalized.url || normalized.name;
  if (seen.has(key)) return;
  seen.add(key);
  products.push(normalized);
}

function parsePossibleJson(value) {
  const text = String(value || '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
  if (!/(product|goods|shop|commerce|anchor|seller|price|sku)/i.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// 54 是 CapCut 模板锚点，不是商品。24、33、68 仅作为电商信号，商品仍需名称或 ID 等字段。
const COMMERCE_ANCHOR_TYPES = [24, 33, 68];

/**
 * 判断节点是否为 TikTok 锚点（anchor）结构。
 * 商品挂车、CapCut 模板、特效等都走这个结构：名称在 keyword 字段，图在 thumbnail.urlList。
 */
function looksLikeTikTokAnchor(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const hasAnchorShape = obj.type !== undefined || obj.anchorType !== undefined || obj.anchor_type !== undefined ||
         obj.thumbnail !== undefined || obj.icon !== undefined || typeof obj.schema === 'string' ||
         obj.extra !== undefined || obj.extraInfo !== undefined || obj.extra_info !== undefined;
  if (!hasAnchorShape) return false;
  if (typeof obj.keyword === 'string' && obj.keyword.trim()) return true;
  const extra = parseAnchorExtra(obj);
  return !!(pickFirstString(extra, ['title', 'name', 'product_name']) || pickProductIdFromAnchor(obj, extra));
}

/**
 * 判断锚点是否为商品挂车（TikTok Shop 锚点 type=68），排除 CapCut 模板、特效等其它锚点
 */
function isCommerceAnchor(obj) {
  const rawType = obj.type !== undefined ? obj.type : (obj.anchorType !== undefined ? obj.anchorType : obj.anchor_type);
  const extra = parseAnchorExtra(obj);
  const extraText = [
    obj.schema, obj.logExtra, obj.log_extra,
    typeof obj.extra === 'string' ? obj.extra : JSON.stringify(obj.extra || ''),
    JSON.stringify(obj.extraInfo || obj.extra_info || '')
  ].join('|').toLowerCase();
  if (Number(rawType) === 54 || /capcut\.com|tt_capcut|capcut_logo/.test(extraText)) return false;
  if (pickProductIdFromAnchor(obj, extra)) return true;
  if (/shop_anchor|ec_anchor|tiktok_shop|product_id|shop\.tiktok|ec\.tiktok|\/view\/product\//.test(extraText)) {
    return true;
  }

  const name = String(
    obj.keyword || pickFirstString(extra, ['title', 'name', 'product_name', 'productName', 'goods_name', 'goodsName']) || ''
  ).trim();
  return COMMERCE_ANCHOR_TYPES.includes(Number(rawType)) && Boolean(name);
}

function normalizeAnchorProduct(obj) {
  const extra = parseAnchorExtra(obj);
  const name = String(
    obj.keyword ||
    pickFirstString(extra, ['title', 'name', 'product_name', 'productName', 'goods_name', 'goodsName']) ||
    ''
  ).trim();
  if (!name) return null;
  const productId = pickProductIdFromAnchor(obj, extra);
  return {
    id: productId || pickFirstString(obj, ['id', 'anchorId', 'anchor_id']) || pickFirstString(extra, ['goods_id', 'goodsId']),
    name,
    price: normalizeProductPrice(extra) || normalizeProductPrice(obj),
    image: pickFirstUrl(extra, ['cover_url', 'coverUrl', 'image', 'img', 'cover', 'thumbnail']) || pickFirstUrl(obj, ['thumbnail', 'icon']),
    url: pickHttpUrl(obj.schema) || buildTikTokProductSchema(productId) || pickFirstUrl(extra, ['url', 'detailUrl', 'detail_url', 'jumpUrl', 'jump_url']),
    shopName: pickFirstString(extra, ['shopName', 'shop_name', 'sellerName', 'seller_name'])
  };
}

/**
 * 锚点的 extra/extraInfo 可能是 JSON 字符串，里面带商品 ID、价格等补充信息
 */
function parseAnchorExtra(obj) {
  const candidates = [obj.extra, obj.extraInfo, obj.extra_info];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
    if (typeof candidate === 'string' && candidate.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (error) {
        // 忽略无效 JSON
      }
    }
  }
  return {};
}

function pickProductIdFromAnchor(obj, extra) {
  const directId = pickFirstString(extra, ['product_id', 'productId', 'productIdStr', 'goods_id', 'goodsId']) ||
    pickFirstString(obj, ['product_id', 'productId', 'goods_id', 'goodsId']);
  if (directId) return directId;

  const schemaText = String(obj?.schema || extra?.schema || '');
  const match = schemaText.match(/[?&]product_id=([^&]+)/i) || schemaText.match(/product[_-]?id[=:]([0-9]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function buildTikTokProductSchema(productId) {
  return productId ? `tiktok://shopping/product_detail?product_id=${encodeURIComponent(productId)}` : '';
}

function pickHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

function looksLikeCommerceProduct(obj, path) {
  if (isLikelyNonProductNode(obj, path)) return false;
  const pathText = String(path || '').toLowerCase();
  const keys = Object.keys(obj || {}).map((key) => key.toLowerCase());
  const keyText = keys.join('|');
  const hasName = keys.some((key) => /title|name|product_name|producttitle|goods_name/.test(key));
  const hasCommercePath = /product|goods|shop|commerce|sku|seller|promotion|ttec/.test(pathText + '|' + keyText);
  const hasCommerceSignal = keys.some((key) => /price|product|goods|shop|seller|sales|currency|sku/.test(key));
  return hasName && hasCommercePath && hasCommerceSignal;
}

/**
 * 排除音乐、作者等带 title/name 字段但并非商品的节点。
 * 音乐节点带有 isCommerceMusic（商用授权标记）字段，正好命中 commerce 关键词，
 * 此前会被误判成挂车商品（表现为商品名显示成"原声 - xxx"）。
 */
function isLikelyNonProductNode(obj, path) {
  const keys = Object.keys(obj || {}).map((key) => key.toLowerCase());
  if (keys.includes('iscommercemusic') || keys.includes('is_commerce_music')) return true;
  const hasPlay = keys.includes('playurl') || keys.includes('play_url');
  const hasAuthor = keys.includes('authorname') || keys.includes('author') || keys.includes('album');
  if (hasPlay && hasAuthor) return true;
  const lastSegment = String(path || '').toLowerCase().split('.').pop() || '';
  if (/music/.test(lastSegment)) return true;
  // 用户/作者节点
  return keys.includes('uniqueid') || keys.includes('unique_id') ||
         keys.includes('secuid') || keys.includes('sec_uid') || keys.includes('nickname');
}

function normalizeCommerceProduct(obj) {
  const name = pickFirstString(obj, [
    'title', 'name', 'productName', 'product_name', 'productTitle', 'product_title',
    'goodsName', 'goods_name', 'itemTitle', 'item_title'
  ]);
  if (!name) return null;

  return {
    id: pickFirstString(obj, ['id', 'productId', 'product_id', 'goodsId', 'goods_id', 'shopItemId', 'shop_item_id']),
    name: name.trim(),
    price: normalizeProductPrice(obj),
    image: pickFirstUrl(obj, ['image', 'img', 'cover', 'thumbnail', 'thumb', 'productImage', 'product_image', 'images']),
    url: pickFirstUrl(obj, ['url', 'schema', 'link', 'detailUrl', 'detail_url', 'productUrl', 'product_url', 'jumpUrl', 'jump_url']),
    shopName: pickFirstString(obj, ['shopName', 'shop_name', 'sellerName', 'seller_name', 'storeName', 'store_name'])
  };
}

function normalizeProductPrice(obj) {
  const directPrice = pickFirstString(obj, ['price', 'salePrice', 'sale_price', 'displayPrice', 'display_price', 'realPrice', 'real_price']);
  if (directPrice) return directPrice;
  const currency = pickFirstString(obj, ['currency', 'currencySymbol', 'currency_symbol']);
  const amount = pickFirstString(obj, ['priceVal', 'price_val', 'minPrice', 'min_price', 'amount']);
  if (amount) return `${normalizeCurrencySymbol(currency)}${amount}`;
  return '';
}

function normalizeCurrencySymbol(currency) {
  const value = String(currency || '').trim().toUpperCase();
  if (!value) return '';
  const map = {
    THB: '฿',
    USD: '$',
    CNY: '¥',
    RMB: '¥',
    JPY: '¥',
    EUR: '€',
    GBP: '£',
    IDR: 'Rp',
    VND: '₫',
    PHP: '₱',
    MYR: 'RM',
    SGD: 'S$'
  };
  return map[value] || currency;
}

function mergeCommerceProducts(...groups) {
  const merged = [];
  const seen = new Set();
  groups.flat().forEach((product) => {
    if (!product || !product.name) return;
    const normalized = {
      id: product.id || '',
      name: product.name || '',
      price: product.price || '',
      image: product.image || '',
      url: product.url || '',
      shopName: product.shopName || ''
    };
    const key = normalized.id || normalized.url || normalized.name;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  });
  return merged;
}

function mergeCommerceMeta(...metas) {
  const merged = {
    isCommerceVideo: false,
    anchorTypes: [],
    productHints: 0,
    hasProducts: false,
    source: '',
    sourceStatuses: []
  };
  metas.forEach((meta) => {
    if (!meta || typeof meta !== 'object') return;
    const safeMeta = normalizeCommerceMeta(meta);
    merged.isCommerceVideo = merged.isCommerceVideo || safeMeta.isCommerceVideo;
    merged.hasProducts = merged.hasProducts || safeMeta.hasProducts;
    merged.productHints += safeMeta.productHints || 0;
    if (!merged.source && safeMeta.source) merged.source = safeMeta.source;
    safeMeta.anchorTypes.forEach((type) => {
      if (!merged.anchorTypes.includes(type)) merged.anchorTypes.push(type);
    });
    safeMeta.sourceStatuses.forEach((status) => {
      if (!merged.sourceStatuses.includes(status)) merged.sourceStatuses.push(status);
    });
  });
  return merged;
}

function pickFirstString(obj, keys) {
  for (const key of keys) {
    const value = obj && obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (value && typeof value === 'object') {
      const nested = pickFirstString(value, ['text', 'value', 'format', 'formatted', 'display']);
      if (nested) return nested;
    }
  }
  return '';
}

function pickFirstUrl(obj, keys) {
  for (const key of keys) {
    const value = obj && obj[key];
    const found = findUrlValue(value);
    if (found) return found;
  }
  return '';
}

function findUrlValue(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) || /^snssdk/i.test(value) ? value : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlValue(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    return findUrlValue(value.url) ||
           findUrlValue(value.urlList) ||
           findUrlValue(value.url_list) ||
           findUrlValue(value.uri) ||
           findUrlValue(value.link);
  }
  return '';
}

/**
 * 获取 TikTok 播放器页地址
 * @param {string} videoId - 视频 ID
 * @returns {string} 播放器地址
 */
function getTikTokPlayerUrl(videoId) {
  return `https://www.tiktok.com/player/v1/${videoId}?id=${videoId}`;
}

/**
 * 统一向隔离世界回传下载状态
 * @param {string} requestId - 请求 ID
 * @param {"started"|"success"|"error"} status - 状态
 * @param {string} message - 状态消息
 */
function postDownloadStatus(requestId, status, message, extra = {}) {
  const payload = {
    type: DOWNLOAD_STATUS_TYPE,
    requestId,
    status,
    message,
    ...extra
  };
  window.postMessage(payload, '*');
}

/**
 * 根据 URL 推断扩展名
 * @param {string} url - 媒体地址
 * @returns {string} 文件扩展名
 */
function inferExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || '';
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : 'mp4';
  } catch (error) {
    return 'mp4';
  }
}

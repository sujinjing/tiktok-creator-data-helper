/**
 * 处理后台消息监听，接收来自内容脚本或弹窗的指令
 * @param {Object} message - 消息体，包含 action 和其它参数
 * @param {Object} sender - 消息发送者的信息
 * @param {Function} sendResponse - 用于向发送者返回响应的回调函数
 * @returns {boolean} 返回 true 以保持消息通道开启
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "download") {
    console.log("[达人数据助手][background] 收到下载请求:", message.url);
    downloadMedia(message.url, message.filename, sendResponse);
    return true;
  }
  if (message.action === "fetch_media_buffer") {
    console.log("[达人数据助手][background] 收到拉流请求:", message.url);
    fetchMediaBuffer(message, sendResponse);
    return true;
  }
  if (message.action === "fetch_external_tiktok_detail") {
    console.log("[达人数据助手][background] 收到外部解析请求:", message.detailUrl || message.videoId);
    fetchExternalTikTokDetail(message, sendResponse);
    return true;
  }
  if (message.action === "fetch_tiktok_shop_product") {
    console.log("[达人数据助手][background] 收到 TikTok Shop 商品解析请求:", message.productId);
    fetchTikTokShopProduct(message, sendResponse);
    return true;
  }
  if (message.action === "fetch_subtitle_text") {
    console.log("[达人数据助手][background] 收到字幕读取请求:", message.url);
    fetchSubtitleText(message, sendResponse);
    return true;
  }
  if (message.action === "translate_text") {
    console.log("[达人数据助手][background] 收到 AI 翻译请求");
    translateTextWithAI(message, sendResponse);
    return true;
  }
  // 增加对 Base64 格式加密视频流下载的支持
  if (message.action === "download_base64") {
    downloadMedia(message.dataUrl, message.filename, sendResponse);
    return true;
  }
  return false;
});

initMediaHeaderRules();

/**
 * 给 TikTok 媒体 CDN 请求补齐 Referer，模拟 video-parser-expert 的下载请求头策略。
 */
function initMediaHeaderRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
    return;
  }

  const mediaDomains = [
    'tiktok.com',
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'tiktokcdn-eu.com',
    'tiktokv.com',
    'byteoversea.com',
    'byteoversea.net',
    'bytefcdn-oversea.com',
    'ibytedtos.com',
    'muscdn.com',
    'bytecdn.cn',
    'akamaized.net'
  ];
  const ruleIds = mediaDomains.map((_, index) => 1001 + index);

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
    addRules: mediaDomains.map((domain, index) => ({
      id: 1001 + index,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'referer',
            operation: 'set',
            value: 'https://www.tiktok.com/'
          }
        ]
      },
      condition: {
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
        requestDomains: [domain]
      }
    }))
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[达人数据助手][background] 媒体请求头规则初始化失败:', chrome.runtime.lastError.message);
    }
  });
}

/**
 * 调用浏览器下载 API 下载指定的视频或音频资源（支持普通链接和 Base64 数据链接）
 * @param {string} url - 资源的下载链接地址或 Base64 数据串
 * @param {string} filename - 保存的文件名
 * @param {Function} sendResponse - 下载完成或失败后的回调响应函数
 */
function downloadMedia(url, filename, sendResponse) {
  const options = {
    url: url,
    filename: sanitizeDownloadFilename(filename),
    saveAs: false
  };

  chrome.downloads.download(options, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error("[达人数据助手][background] 下载失败:", chrome.runtime.lastError.message, url);
      sendResponse({ success: false, error: chrome.runtime.lastError.message });
    } else {
      console.log("[达人数据助手][background] 下载已启动:", downloadId, filename);
      sendResponse({ success: true, downloadId: downloadId });
    }
  });
}

function sanitizeDownloadFilename(filename) {
  const fallback = `tiktok_video_${Date.now()}.mp4`;
  let value = normalizeFilenameText(filename || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!value) value = fallback;

  const dotIndex = value.lastIndexOf('.');
  const rawBase = dotIndex > 0 ? value.slice(0, dotIndex) : value;
  const rawExt = dotIndex > 0 ? value.slice(dotIndex + 1) : 'mp4';
  let base = sanitizeFilenamePart(rawBase, 'tiktok_video', 120);
  const ext = String(rawExt || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'mp4';

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = `tiktok_${base}`;
  }

  return `${base}.${ext}`;
}

function sanitizeFilenamePart(value, fallback, maxLength) {
  const text = normalizeFilenameText(value)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[\s._-]+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '');
  return (text || fallback).slice(0, maxLength).trim() || fallback;
}

function normalizeFilenameText(value) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\r\n\t]+/g, ' ');
  try {
    return text.normalize('NFKC');
  } catch (error) {
    return text;
  }
}

/**
 * 由扩展后台跨域拉取视频二进制，规避页面上下文的 CORS 限制
 * @param {Object} message - 请求参数
 * @param {Function} sendResponse - 回调响应
 */
async function fetchMediaBuffer(message, sendResponse) {
  const { url, videoId } = message || {};
  if (!url) {
    sendResponse({ success: false, error: '缺少媒体地址' });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      referrer: videoId ? `https://www.tiktok.com/player/v1/${videoId}?id=${videoId}` : 'https://www.tiktok.com/',
      referrerPolicy: 'strict-origin-when-cross-origin',
      headers: {
        'Accept': 'video/mp4,video/*,*/*'
      }
    });

    if (!response.ok) {
      console.error("[达人数据助手][background] 拉流失败:", response.status, url);
      sendResponse({ success: false, error: `视频请求失败（${response.status}）` });
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    sendResponse({
      success: true,
      base64: btoa(binary),
      contentType: response.headers.get('content-type') || 'video/mp4'
    });
  } catch (error) {
    console.error("[达人数据助手][background] 拉流异常:", error, url);
    sendResponse({ success: false, error: error && error.message ? error.message : '后台拉取视频失败' });
  }
}

async function fetchSubtitleText(message, sendResponse) {
  const { url, videoId } = message || {};
  if (!url) {
    sendResponse({ success: false, error: '缺少字幕地址' });
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      referrer: videoId ? `https://www.tiktok.com/player/v1/${videoId}?id=${videoId}` : 'https://www.tiktok.com/',
      referrerPolicy: 'strict-origin-when-cross-origin',
      headers: {
        'Accept': 'text/vtt,text/plain,application/json,*/*'
      }
    });

    if (!response.ok) {
      sendResponse({ success: false, error: `字幕请求失败（${response.status}）` });
      return;
    }

    const text = await response.text();
    sendResponse({
      success: true,
      text,
      contentType: response.headers.get('content-type') || ''
    });
  } catch (error) {
    console.error('[达人数据助手][background] 字幕读取失败:', error);
    sendResponse({ success: false, error: error && error.message ? error.message : '字幕读取失败' });
  }
}

async function translateTextWithAI(message, sendResponse) {
  const text = String((message && message.text) || '').trim();
  if (!text) {
    sendResponse({ success: false, error: '没有可翻译的字幕文本' });
    return;
  }

  try {
    const config = await chrome.storage.local.get([
      'aiEnabled',
      'apiUrl',
      'apiKey',
      'aiModel'
    ]);

    if (!config.aiEnabled || !config.apiUrl || !config.apiKey || !config.aiModel) {
      const fallback = await translateTextWithPublicFallback(text, message.targetLanguage || 'zh-CN');
      sendResponse({
        success: true,
        text: fallback,
        provider: 'public-translate'
      });
      return;
    }

    const baseUrl = String(config.apiUrl || '').replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [
          {
            role: 'system',
            content: '你是短视频字幕翻译助手。请把用户提供的字幕或视频简介翻译成自然流畅的简体中文，保留原有换行，不要添加解释、标题或额外评论。'
          },
          {
            role: 'user',
            content: `目标语言：${message.targetLanguage || '简体中文'}\n视频标题：${message.title || ''}\n原文：\n${text}`
          }
        ],
        temperature: 0.2
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data && data.error && data.error.message ? data.error.message : `AI 接口请求失败（${response.status}）`);
    }

    const translated = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    if (!translated) {
      throw new Error('AI 接口未返回翻译内容');
    }

    sendResponse({ success: true, text: String(translated).trim(), provider: 'ai' });
  } catch (error) {
    console.error('[达人数据助手][background] AI 翻译失败:', error);
    sendResponse({
      success: false,
      error: error && error.message ? error.message : 'AI 翻译失败'
    });
  }
}

async function translateTextWithPublicFallback(text, targetLanguage = 'zh-CN') {
  const chunks = splitTextForPublicTranslate(text, 1400);
  if (!chunks.length) throw new Error('没有可翻译的字幕文本');

  const translated = [];
  for (const chunk of chunks) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(normalizeTranslateTarget(targetLanguage))}&dt=t&q=${encodeURIComponent(chunk)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json,text/plain,*/*'
      }
    });
    if (!response.ok) {
      throw new Error(`免费翻译请求失败（${response.status}）`);
    }
    const data = await response.json();
    const textPart = Array.isArray(data && data[0])
      ? data[0].map((item) => Array.isArray(item) ? item[0] : '').join('')
      : '';
    if (!textPart) {
      throw new Error('免费翻译未返回内容');
    }
    translated.push(textPart.trim());
  }

  return translated.join('\n').trim();
}

function splitTextForPublicTranslate(text, maxLength) {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  let current = '';
  lines.forEach((line) => {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  });
  if (current.trim()) chunks.push(current);
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength) return [chunk];
    const parts = [];
    for (let i = 0; i < chunk.length; i += maxLength) {
      parts.push(chunk.slice(i, i + maxLength));
    }
    return parts;
  }).filter((chunk) => chunk.trim());
}

function normalizeTranslateTarget(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'zh-CN';
  if (
    text.includes('zh') ||
    text.includes('cn') ||
    text.includes('chinese') ||
    text.includes('中文') ||
    text.includes('汉语') ||
    text.includes('簡體') ||
    text.includes('简体')
  ) {
    return 'zh-CN';
  }
  return text;
}

/**
 * 通过外部开源解析服务补抓 TikTok App 侧原始详情，兜底获取 Web 不下发的媒体/商品字段。
 * @param {Object} message - 请求参数
 * @param {Function} sendResponse - 回调响应
 */
async function fetchExternalTikTokDetail(message, sendResponse) {
  const { videoId, detailUrl } = message || {};
  if (!videoId && !detailUrl) {
    sendResponse({ success: false, error: '缺少视频链接或视频 ID' });
    return;
  }

  const sources = buildExternalTikTokSources(videoId, detailUrl);
  const errors = [];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        }
      });

      if (!response.ok) {
        throw new Error(`${source.name} 请求失败（${response.status}）`);
      }

      const payload = await response.json();
      sendResponse({
        success: true,
        source: source.name,
        payload
      });
      return;
    } catch (error) {
      errors.push(error && error.message ? error.message : `${source.name} 请求失败`);
    }
  }

  sendResponse({
    success: false,
    error: errors.join('；') || '外部解析失败'
  });
}

function buildExternalTikTokSources(videoId, detailUrl) {
  const sources = [];
  const normalizedUrl = normalizeTikTokDetailUrl(videoId, detailUrl);
  if (normalizedUrl) {
    sources.push({
      name: 'douyin.wtf hybrid',
      url: `https://api.douyin.wtf/api/hybrid/video_data?url=${encodeURIComponent(normalizedUrl)}&minimal=false`
    });
  }
  if (videoId) {
    sources.push({
      name: 'douyin.wtf app',
      url: `https://api.douyin.wtf/api/tiktok/app/fetch_one_video?aweme_id=${encodeURIComponent(videoId)}`
    });
  }
  return sources;
}

function normalizeTikTokDetailUrl(videoId, detailUrl) {
  const fallback = videoId ? `https://www.tiktok.com/@placeholder/video/${videoId}` : '';
  const rawUrl = detailUrl || fallback;
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch (error) {
    return fallback;
  }
}

async function fetchTikTokShopProduct(message, sendResponse) {
  const productId = String((message && message.productId) || '').trim().replace(/[^\d]/g, '');
  if (!productId) {
    sendResponse({ success: false, error: '缺少商品 ID' });
    return;
  }

  try {
    const productUrls = buildTikTokShopProductUrls(productId, message && message.productUrl);
    const errors = [];
    for (const productUrl of productUrls) {
      try {
        const response = await fetch(productUrl, {
          method: 'GET',
          redirect: 'follow',
          credentials: 'include',
          referrer: 'https://www.tiktok.com/',
          referrerPolicy: 'strict-origin-when-cross-origin',
          cache: 'no-store',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7'
          }
        });

        if (!response.ok) {
          throw new Error(`请求失败（${response.status}）`);
        }

        const html = await response.text();
        const product = parseTikTokShopProductHtml(html, productId, response.url || productUrl);
        if (!product || !product.name) {
          throw new Error('未返回可解析的商品详情');
        }

        sendResponse({
          success: true,
          products: [product],
          source: 'tiktok-shop-pdp',
          url: response.url || productUrl
        });
        return;
      } catch (error) {
        errors.push(`${productUrl}: ${error && error.message ? error.message : '请求失败'}`);
      }
    }
    throw new Error(errors.join('；') || '商品页未返回可解析的商品详情');
  } catch (error) {
    console.error('[达人数据助手][background] TikTok Shop 商品解析失败:', error);
    sendResponse({
      success: false,
      error: error && error.message ? error.message : 'TikTok Shop 商品解析失败'
    });
  }
}

function buildTikTokShopProductUrls(productId, capturedUrl) {
  const urls = [];
  const pushUrl = (value) => {
    if (!value || urls.includes(value)) return;
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      if ((!host.endsWith('tiktok.com') && !host.endsWith('tiktokshop.com')) ||
          !path.includes(String(productId)) ||
          !/(?:\/view\/product\/|\/product\/|\/pdp\/)/.test(path)) {
        return;
      }
      urls.push(parsed.toString());
    } catch (error) {
      // 忽略非商品页 URL
    }
  };

  pushUrl(capturedUrl);
  pushUrl(`https://www.tiktok.com/view/product/${encodeURIComponent(productId)}`);
  pushUrl(`https://shop.tiktok.com/view/product/${encodeURIComponent(productId)}`);
  return urls;
}

function parseTikTokShopProductHtml(html, productId, pageUrl) {
  const routerData = extractScriptJson(html, '__MODERN_ROUTER_DATA__');
  const productInfo = findFirstObject(routerData, (value) => (
    value &&
    value.product_model &&
    String(value.product_model.product_id || '') === String(productId)
  ));

  const productModel = productInfo && productInfo.product_model ? productInfo.product_model : {};
  const promotionModel = productInfo && productInfo.promotion_model ? productInfo.promotion_model : {};
  const sellerModel = productInfo && productInfo.seller_model ? productInfo.seller_model : {};
  const reviewModel = productInfo && productInfo.review_model ? productInfo.review_model : {};
  const priceInfo = promotionModel &&
    promotionModel.promotion_product_price &&
    promotionModel.promotion_product_price.min_price;

  const fallbackMeta = extractProductMetaFromHtml(html);
  const name = productModel.name || fallbackMeta.title || '';
  const image = pickFirstUrlFromAny(productModel.images) || fallbackMeta.image || '';
  const price = formatShopPrice(priceInfo);
  const originalPrice = priceInfo && priceInfo.origin_price_format
    ? `${priceInfo.currency_symbol || ''}${priceInfo.origin_price_format}`
    : '';

  if (!name) return null;

  return {
    id: String(productId),
    name,
    price,
    image,
    url: pageUrl || `https://www.tiktok.com/view/product/${encodeURIComponent(productId)}`,
    shopName: sellerModel.shop_name || '',
    rating: reviewModel.product_overall_score !== undefined ? String(reviewModel.product_overall_score) : '',
    reviewCount: reviewModel.product_review_count || '',
    soldCount: productModel.sold_count || '',
    originalPrice
  };
}

function extractScriptJson(html, scriptId) {
  const pattern = new RegExp(`<script[^>]+id=["']${escapeRegExp(scriptId)}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const match = String(html || '').match(pattern);
  if (!match) return null;
  const text = decodeHtmlEntities(match[1] || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function findFirstObject(value, predicate, depth = 0, seen = new Set()) {
  if (!value || depth > 12 || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findFirstObject(child, predicate, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function extractProductMetaFromHtml(html) {
  return {
    title: extractMetaContent(html, 'property', 'og:title'),
    image: extractMetaContent(html, 'property', 'og:image')
  };
}

function extractMetaContent(html, attr, attrValue) {
  const pattern = new RegExp(`<meta[^>]+${attr}=["']${escapeRegExp(attrValue)}["'][^>]+content=["']([^"']+)["']`, 'i');
  const match = String(html || '').match(pattern);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function formatShopPrice(priceInfo) {
  if (!priceInfo || typeof priceInfo !== 'object') return '';
  if (priceInfo.sale_price_format) {
    return `${priceInfo.currency_symbol || ''}${priceInfo.sale_price_format}`;
  }
  if (priceInfo.sale_price_decimal) {
    return `${priceInfo.currency_symbol || ''}${priceInfo.sale_price_decimal}`;
  }
  return '';
}

function pickFirstUrlFromAny(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? value : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstUrlFromAny(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    return pickFirstUrlFromAny(value.url) ||
      pickFirstUrlFromAny(value.url_list) ||
      pickFirstUrlFromAny(value.urlList) ||
      pickFirstUrlFromAny(value.uri) ||
      pickFirstUrlFromAny(value.image);
  }
  return '';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

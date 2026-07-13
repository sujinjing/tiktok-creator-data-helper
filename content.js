/**
 * 达人数据助手 - 内容脚本
 * 包含顶部水平工具栏（含日期区间批量下载与滚动）、视频封面多维数据渲染及 blob 视频同源下载
 * 运行在隔离世界，通过接收主世界 hook.js 发出的事件实时抓取 API 数据
 */

// 全局状态管理
let scannedCards = [];
let toolbarElement = null;
let calendarPopoverElement = null;
let scrollInterval = null;
let selectionMode = false;
let rangeStartDate = '';
let rangeEndDate = '';
let activeDateField = 'start';
let calendarMonthDate = new Date();
let isExporting = false;
let lastExportSelectionMode = false;
let exportProgressHideTimer = null;
let previewMediaStatusTimer = null;
let exportProductInfoEnabled = false;
let previewAsrRecognition = null;
let previewAsrActive = false;
let previewAsrStopRequested = false;
let previewAsrRestartTimer = null;
let previewAsrTranslateSeq = 0;
let previewAsrMediaStream = null;
const selectedVideoIds = new Set();
const capturedProductEnrichmentKeys = new Set();
const apiVideos = {}; // 缓存格式: { videoId: { createTime, views, likes, comments, shares, playUrl, products, commerceMeta, subtitles } }
const pageDownloadRequests = new Map();
const PAGE_DOWNLOAD_REQUEST_TYPE = 'TIKTOK_HELPER_DOWNLOAD_REQUEST';
const PAGE_DOWNLOAD_STATUS_TYPE = 'TIKTOK_HELPER_DOWNLOAD_STATUS';
const ZIP_REQUEST_TYPE = 'TIKTOK_HELPER_ZIP_REQUEST';
const ZIP_STATUS_TYPE = 'TIKTOK_HELPER_ZIP_STATUS';
const ZIPPER_FRAME_ID = 'tiktok-helper-zipper-frame';
const zipDownloadRequests = new Map();
const TOOLBAR_ID = 'tiktok-talent-helper-toolbar';
const TOOLBAR_CALENDAR_ID = 'tiktok-talent-helper-calendar';
const POPUP_THEME_STORAGE_KEY = 'popupTheme';
const EXPORT_PRODUCT_INFO_STORAGE_KEY = 'exportProductInfoEnabled';
const TOOLBAR_LAYOUT_STORAGE_KEY = 'toolbarLayout';
const DEFAULT_POPUP_THEME = 'neon';
const AVAILABLE_POPUP_THEMES = ['neon', 'paper', 'ocean', 'ember'];
const EXTERNAL_TIKTOK_DETAIL_ACTION = 'fetch_external_tiktok_detail';
const TIKTOK_SHOP_PRODUCT_ACTION = 'fetch_tiktok_shop_product';
const FETCH_SUBTITLE_TEXT_ACTION = 'fetch_subtitle_text';
const TRANSLATE_TEXT_ACTION = 'translate_text';
const EXPORT_DOWNLOAD_TIMEOUT_MS = 15000;
const EXPORT_PRODUCT_ENRICH_BASE_TIMEOUT_MS = 20000;
const EXPORT_PRODUCT_ENRICH_TARGET_TIMEOUT_MS = 6000;
const EXPORT_PRODUCT_ENRICH_MAX_TIMEOUT_MS = 20 * 60 * 1000;
const EXPORT_PRODUCT_ENRICH_CONCURRENCY = 6;
const PREVIEW_COMMERCE_DETAIL_TIMEOUT_MS = 15000;
const PREVIEW_TRANSLATION_TEXT_LIMIT = 8000;
const TOOLBAR_EDGE_GAP = 10;
let toolbarThemeListenerBound = false;
let toolbarResizeListenerBound = false;
let toolbarDragState = null;
let toolbarLayout = {
  side: 'right',
  centerRatio: null,
  hidden: false,
  collapsed: true
};

// 立即开启网络数据监听，防止漏掉首屏任何接口数据（在 content.js 载入第一时间生效）
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== 'TIKTOK_API_DATA_EVENT') return;

  const { text, url = '', videoId = '', commerceFocused = false } = e.data;
  console.log("[达人数据助手] 成功接收到拦截的 API 数据包，开始解析...");
  let data = null;
  try {
    const safeText = text.replace(/:\s*(\d{16,21})/g, ': "$1"');
    data = JSON.parse(safeText);
    recursiveExtractVideoInfo(data);
  } catch (err) {
    // 商品跳转有时返回 HTML，仍可从请求 URL 提取 product_id。
  }

  const capturedProductIds = extractTikTokShopProductIds([url, data]);
  if (videoId && (commerceFocused || capturedProductIds.length)) {
    mergeCapturedCommercePayload(videoId, data, url, capturedProductIds);
  }
  if (document.body) {
    scanCards();
  }
});

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== PAGE_DOWNLOAD_STATUS_TYPE) return;

  const { requestId, status, message, mediaUrl, filename, products, commerceMeta } = e.data;
  if (!requestId || !pageDownloadRequests.has(requestId)) return;

  const request = pageDownloadRequests.get(requestId);
  if (message && !request.silent) {
    showToast(message);
  }

  if (status === 'success') {
    const safeProducts = Array.isArray(products) ? products : [];
    window.clearTimeout(request.timeoutId);
    pageDownloadRequests.delete(requestId);
    request.resolve({
      mediaUrl,
      filename,
      products: safeProducts,
      commerceMeta: normalizeCommerceMeta(commerceMeta, safeProducts)
    });
  } else if (status === 'error') {
    window.clearTimeout(request.timeoutId);
    pageDownloadRequests.delete(requestId);
    request.reject(new Error(message || '下载失败'));
  }
});

window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== ZIP_STATUS_TYPE) return;

  const { requestId, status, message, filename, failed } = e.data;
  if (!requestId || !zipDownloadRequests.has(requestId)) return;

  const request = zipDownloadRequests.get(requestId);
  if (message) {
    showToast(message);
  }

  if (status === 'progress') {
    return;
  }

  window.clearTimeout(request.timeoutId);
  zipDownloadRequests.delete(requestId);

  if (status === 'success') {
    request.resolve({ filename, failed: Array.isArray(failed) ? failed : [] });
  } else {
    request.reject(new Error(message || '批量打包失败'));
  }
});

// 注入高级水晶毛玻璃气泡 UI 的专属样式表（极致高透莫兰迪色，绝无遮挡）
function injectStyles() {
  if (document.getElementById('tiktok-talent-helper-styles')) return;
  const style = document.createElement('style');
  style.id = 'tiktok-talent-helper-styles';
  style.textContent = `
    .helper-bubbles-container {
      position: absolute !important;
      inset: 0 !important;
      z-index: 120;
      display: block;
      box-sizing: border-box;
      overflow: hidden;
      border-radius: inherit;
      pointer-events: none;
    }
    .helper-bubble {
      position: absolute; z-index: 100;
      background: rgba(255, 255, 255, 0.16); backdrop-filter: blur(12px) saturate(140%);
      -webkit-backdrop-filter: blur(12px) saturate(140%); border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 20px; color: #ffffff; padding: 3px 8px; font-size: 10px; font-weight: 700;
      font-family: system-ui, -apple-system, sans-serif; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); pointer-events: none;
      display: flex; align-items: center; justify-content: center; transition: all 0.2s ease;
      letter-spacing: 0.2px;
    }
    /* 互动率小胶囊 - 采用 TikTok 玫红半透明微光 */
    .helper-bubble-rate {
      right: 8px; top: 8px;
      background: rgba(254, 44, 85, 0.25); border-color: rgba(254, 44, 85, 0.4);
      color: #ffeff2;
    }
    .helper-bubble-likes { right: 8px; bottom: 60px; }
    .helper-bubble-comments { right: 8px; bottom: 34px; }
    .helper-bubble-date { right: 8px; bottom: 8px; }
    .helper-bubble-views {
      left: 8px;
      top: 42px;
      background: rgba(37, 244, 238, 0.22);
      border-color: rgba(37, 244, 238, 0.38);
      color: #efffff;
    }
    .helper-bubble-commerce {
      left: 8px;
      top: 74px;
      gap: 5px;
      padding: 3px 9px;
      font-size: 10px;
      letter-spacing: 0.3px;
      pointer-events: none;
    }
    .helper-bubble-commerce.is-commerce {
      background: rgba(255, 186, 73, 0.28);
      border-color: rgba(255, 186, 73, 0.52);
      color: #fff4d7;
    }
    .helper-bubble-commerce.is-normal {
      background: rgba(12, 14, 20, 0.45);
      border-color: rgba(255, 255, 255, 0.22);
      color: rgba(255, 255, 255, 0.78);
    }
    .helper-bubble-commerce.is-unknown {
      background: rgba(37, 244, 238, 0.14);
      border-color: rgba(37, 244, 238, 0.28);
      color: rgba(224, 255, 253, 0.86);
    }
    .helper-commerce-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
      flex: 0 0 auto;
    }
    .helper-select-toggle {
      position: absolute;
      left: 8px;
      bottom: 8px;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.28);
      background: rgba(12,12,16,0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.22);
      transition: all 0.18s ease;
    }
    .helper-card-direct-download,
    .helper-card-preview-video,
    .helper-select-toggle {
      pointer-events: auto !important;
    }
    .helper-select-toggle input {
      appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 1.5px solid rgba(255,255,255,0.95);
      background: transparent;
      margin: 0;
      pointer-events: none;
      transition: all 0.18s ease;
    }
    .helper-select-toggle.is-visible {
      display: flex;
    }
    .helper-select-toggle.is-selected {
      background: linear-gradient(135deg, rgba(254,44,85,0.95), rgba(37,244,238,0.82));
      border-color: rgba(255,255,255,0.4);
    }
    .helper-select-toggle.is-selected input {
      background: #fff;
      border-color: #fff;
      box-shadow: inset 0 0 0 2px rgba(254,44,85,0.85);
    }
    .helper-video-preview-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: rgba(3, 5, 10, 0.72);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }
    .helper-video-preview-dialog {
      width: min(460px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      overflow: hidden;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(22, 24, 31, 0.96), rgba(10, 12, 18, 0.98));
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: 0 28px 80px rgba(0,0,0,0.48);
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
    }
    .helper-video-preview-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .helper-video-preview-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 700;
    }
    .helper-video-preview-close {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .helper-video-preview-body {
      padding: 14px;
      overflow-y: auto;
      overscroll-behavior: contain;
      flex: 1 1 auto;
      min-height: 0;
    }
    .helper-video-preview-player {
      position: relative;
      overflow: hidden;
      border-radius: 18px;
      background: #000;
      min-height: 220px;
    }
    .helper-video-preview-video {
      width: 100%;
      max-height: min(48vh, 520px);
      display: block;
      background: #000;
      object-fit: contain;
    }
    .helper-video-preview-player.is-loading .helper-video-preview-video {
      min-height: 220px;
    }
    .helper-video-preview-media-status {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 12px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(10,12,18,0.72);
      color: rgba(255,255,255,0.82);
      font-size: 12px;
      line-height: 1.4;
      text-align: center;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      pointer-events: none;
    }
    .helper-video-preview-media-status:empty {
      display: none;
    }
    .helper-video-preview-synced-subtitle {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 62px;
      min-height: 0;
      display: none;
      justify-content: center;
      pointer-events: none;
      z-index: 2;
    }
    .helper-video-preview-synced-subtitle.is-visible {
      display: flex;
    }
    .helper-video-preview-synced-subtitle span {
      max-width: min(92%, 680px);
      padding: 7px 12px;
      border-radius: 12px;
      background: rgba(0,0,0,0.62);
      color: #fff;
      font-size: 15px;
      font-weight: 800;
      line-height: 1.45;
      text-align: center;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9);
      white-space: pre-wrap;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .helper-video-preview-url {
      margin-top: 10px;
      color: rgba(255,255,255,0.48);
      font-size: 11px;
      line-height: 1.4;
      word-break: break-all;
      max-height: 30px;
      overflow: auto;
    }
    .helper-video-subtitles {
      margin-top: 12px;
      padding: 12px;
      border-radius: 16px;
      border: 1px solid rgba(37,244,238,0.16);
      background:
        radial-gradient(circle at 12% 0%, rgba(37,244,238,0.12), transparent 38%),
        rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.82);
    }
    .helper-video-subtitles-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 900;
      color: #fff;
    }
    .helper-video-subtitles-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: rgba(37,244,238,0.9);
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .helper-video-subtitles-text,
    .helper-video-subtitles-original {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.65;
      max-height: 150px;
      overflow: auto;
    }
    .helper-video-subtitles-original {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.52);
      font-size: 11px;
      max-height: 88px;
    }
    .helper-video-subtitles-actions {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .helper-video-subtitles-btn {
      height: 30px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(37,244,238,0.24);
      background: rgba(37,244,238,0.1);
      color: rgba(255,255,255,0.92);
      font-size: 11px;
      font-weight: 800;
      cursor: pointer !important;
    }
    .helper-video-subtitles-btn:hover {
      background: rgba(37,244,238,0.18);
    }
    .helper-video-subtitles-hint {
      color: rgba(255,255,255,0.48);
      font-size: 11px;
      line-height: 1.45;
    }
    .helper-video-products {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.1);
    }
    .helper-video-products-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      color: rgba(255,255,255,0.9);
      font-size: 12px;
      font-weight: 800;
    }
    .helper-video-products-count {
      color: rgba(37,244,238,0.9);
      font-size: 11px;
      font-weight: 700;
    }
    .helper-video-products-empty {
      color: rgba(255,255,255,0.52);
      font-size: 12px;
      line-height: 1.5;
      padding: 10px;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
    }
    .helper-video-products-progress {
      margin-bottom: 8px;
      color: rgba(255,255,255,0.72);
      font-size: 12px;
      line-height: 1.45;
      padding: 9px 10px;
      border-radius: 12px;
      background: rgba(37,244,238,0.08);
      border: 1px solid rgba(37,244,238,0.16);
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .helper-video-products-spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255,255,255,0.18);
      border-top-color: #25f4ee;
      flex: 0 0 auto;
      display: inline-block;
      animation: helperSpin 0.75s linear infinite;
    }
    @keyframes helperSpin {
      to { transform: rotate(360deg); }
    }
    .helper-video-products-meta {
      margin-top: 6px;
      color: rgba(37,244,238,0.72);
      font-size: 11px;
    }
    .helper-video-product-list {
      display: grid;
      gap: 8px;
      max-height: min(28vh, 240px);
      overflow: auto;
      padding-right: 2px;
    }
    .helper-video-product-card {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 8px;
      border-radius: 14px;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      color: #fff;
      text-decoration: none;
    }
    .helper-video-product-card:hover {
      background: rgba(37,244,238,0.11);
      border-color: rgba(37,244,238,0.22);
    }
    .helper-video-product-img {
      width: 46px;
      height: 46px;
      border-radius: 10px;
      object-fit: cover;
      background: rgba(255,255,255,0.08);
    }
    .helper-video-product-info {
      min-width: 0;
    }
    .helper-video-product-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 700;
      color: #fff;
    }
    .helper-video-product-meta {
      margin-top: 4px;
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
      color: rgba(255,255,255,0.54);
      font-size: 11px;
    }
    .helper-video-product-price {
      color: #25f4ee;
      font-weight: 800;
    }
    .helper-video-product-origin-price {
      color: rgba(255,255,255,0.38);
      text-decoration: line-through;
    }
    .helper-video-product-extra {
      margin-top: 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
      color: rgba(255,255,255,0.46);
      font-size: 10.5px;
      line-height: 1.35;
    }
    @media (max-width: 640px) {
      .helper-video-preview-backdrop { padding: 12px; }
      .helper-video-preview-dialog { width: calc(100vw - 24px); max-height: calc(100vh - 24px); border-radius: 18px; }
      .helper-video-preview-body { padding: 10px; }
      .helper-video-preview-video { max-height: 42vh; }
      .helper-video-product-list { max-height: 30vh; }
    }
    .toolbar-date-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .toolbar-date-chip {
      min-width: 136px;
      height: 34px;
      box-sizing: border-box;
      padding: 0 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.14);
      background: linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.05));
      color: #f5f7fb;
      font-size: 12px;
      outline: none;
      transition: border-color 0.18s ease, transform 0.18s ease, background 0.18s ease;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      user-select: none;
    }
    .toolbar-date-chip:hover,
    .toolbar-date-chip:focus {
      border-color: rgba(255,255,255,0.28);
      background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.06));
      transform: translateY(-1px);
    }
    .toolbar-date-chip .toolbar-date-label {
      color: #f5f7fb;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .toolbar-date-chip .toolbar-date-icon {
      opacity: 0.86;
      font-size: 13px;
      flex: 0 0 auto;
      pointer-events: none;
    }
    .toolbar-date-separator {
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      user-select: none;
    }
    .toolbar-date-clear {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
    }
    .toolbar-date-clear.is-visible {
      display: inline-flex;
    }
    .toolbar-calendar-popover {
      position: fixed;
      z-index: 2147483647;
      width: 252px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(16, 16, 22, 0.96);
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: 0 18px 42px rgba(0,0,0,0.36);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      display: none;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .toolbar-calendar-popover.is-open {
      display: block;
    }
    .calendar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .calendar-title {
      font-size: 13px;
      font-weight: 700;
      color: #f7f8fb;
    }
    .calendar-nav {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      color: #fff;
      cursor: pointer;
    }
    .calendar-weekdays,
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 4px;
    }
    .calendar-weekdays span {
      text-align: center;
      font-size: 11px;
      color: rgba(255,255,255,0.52);
      padding: 4px 0;
    }
    .calendar-day {
      height: 28px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: #f7f8fb;
      font-size: 12px;
      cursor: pointer;
    }
    .calendar-day:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.16);
    }
    .calendar-day.is-muted {
      color: rgba(255,255,255,0.26);
    }
    .calendar-day.is-selected {
      color: #071018;
      font-weight: 800;
      background: linear-gradient(135deg, #25f4ee, #ffffff);
    }
    .toolbar-selection-badge {
      display: none;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.14);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      box-sizing: border-box;
    }
    .toolbar-selection-badge.is-visible {
      display: inline-flex;
    }
    #tiktok-talent-helper-toolbar {
      --th-bg: rgba(255,255,255,0.96);
      --th-bg-strong: rgba(255,255,255,0.99);
      --th-surface: rgba(22,104,92,0.07);
      --th-surface-strong: rgba(22,104,92,0.12);
      --th-border: rgba(30,56,51,0.11);
      --th-text: #26332f;
      --th-muted: rgba(38,51,47,0.56);
      --th-accent: #0b6c61;
      --th-accent-2: #45b997;
      --th-button-text: #ffffff;
      --th-shadow: rgba(38,51,47,0.16);
      --th-glow: rgba(69,185,151,0.2);
      position: fixed;
      right: 10px;
      bottom: 18px;
      width: min(420px, calc(100vw - 20px));
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding: 10px;
      box-sizing: border-box;
      color: var(--th-text);
      font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
      border-radius: 18px;
      border: 1px solid var(--th-border);
      background: linear-gradient(180deg, var(--th-bg-strong), var(--th-bg));
      box-shadow: 0 10px 30px var(--th-shadow), 0 1px 0 rgba(255,255,255,0.9) inset;
      backdrop-filter: blur(20px) saturate(115%);
      -webkit-backdrop-filter: blur(20px) saturate(115%);
      transition: left 0.2s ease, right 0.2s ease, top 0.2s ease, bottom 0.2s ease, width 0.16s ease, height 0.16s ease, padding 0.16s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      touch-action: none;
    }
    #tiktok-talent-helper-toolbar.is-dragging {
      transition: none !important;
      user-select: none !important;
    }
    #tiktok-talent-helper-toolbar.is-collapsed:not(.is-hidden) {
      box-shadow: 0 7px 24px color-mix(in srgb, var(--th-shadow) 78%, transparent), 0 1px 0 rgba(255,255,255,0.96) inset;
    }
    #tiktok-talent-helper-toolbar.is-hidden {
      width: 42px !important;
      min-width: 42px !important;
      height: 58px !important;
      padding: 0 !important;
      gap: 0 !important;
      box-shadow: 0 6px 20px color-mix(in srgb, var(--th-shadow) 72%, transparent);
    }
    #tiktok-talent-helper-toolbar.is-hidden[data-side="left"] {
      border-radius: 0 999px 999px 0 !important;
    }
    #tiktok-talent-helper-toolbar.is-hidden[data-side="right"] {
      border-radius: 999px 0 0 999px !important;
    }
    #tiktok-talent-helper-toolbar[data-theme="paper"] {
      --th-bg: rgba(248,250,249,0.96);
      --th-bg-strong: rgba(255,255,255,0.99);
      --th-surface: rgba(22,104,92,0.07);
      --th-surface-strong: rgba(22,104,92,0.12);
      --th-border: rgba(30,56,51,0.11);
      --th-text: #26332f;
      --th-muted: rgba(38,51,47,0.56);
      --th-accent: #0b6c61;
      --th-accent-2: #45b997;
      --th-button-text: #ffffff;
      --th-shadow: rgba(38,51,47,0.16);
      --th-glow: rgba(69,185,151,0.2);
    }
    #tiktok-talent-helper-toolbar[data-theme="ocean"] {
      --th-bg: rgba(6, 22, 21, 0.9);
      --th-bg-strong: rgba(12, 43, 38, 0.88);
      --th-surface: rgba(217,246,232,0.08);
      --th-surface-strong: rgba(217,246,232,0.14);
      --th-border: rgba(187,230,216,0.2);
      --th-text: #f3fbf5;
      --th-muted: rgba(243,251,245,0.58);
      --th-accent: #9bcfbd;
      --th-accent-2: #d9b86d;
      --th-button-text: #071b18;
      --th-shadow: rgba(0, 52, 46, 0.36);
      --th-glow: rgba(155,207,189,0.2);
    }
    #tiktok-talent-helper-toolbar[data-theme="ember"] {
      --th-bg: rgba(23, 15, 10, 0.91);
      --th-bg-strong: rgba(55, 31, 16, 0.88);
      --th-surface: rgba(246,196,133,0.08);
      --th-surface-strong: rgba(246,196,133,0.14);
      --th-border: rgba(247,198,134,0.2);
      --th-text: #fff6e9;
      --th-muted: rgba(255,246,233,0.58);
      --th-accent: #c98d4b;
      --th-accent-2: #f1cc7c;
      --th-button-text: #261408;
      --th-shadow: rgba(52,23,6,0.38);
      --th-glow: rgba(201,141,75,0.24);
    }
    .toolbar-compact-head {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 7px !important;
      min-height: 36px;
    }
    .toolbar-drag-handle {
      width: 36px !important;
      height: 36px !important;
      padding: 3px !important;
      flex: 0 0 auto !important;
      border: 1px solid color-mix(in srgb, var(--th-accent) 13%, transparent) !important;
      border-radius: 999px !important;
      background: color-mix(in srgb, var(--th-accent-2) 10%, white) !important;
      cursor: grab !important;
      touch-action: none;
    }
    .toolbar-drag-handle:hover {
      background: color-mix(in srgb, var(--th-accent-2) 17%, white) !important;
      transform: scale(1.03);
    }
    #tiktok-talent-helper-toolbar.is-dragging .toolbar-drag-handle {
      cursor: grabbing !important;
    }
    .toolbar-panel-toggle {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      min-width: 0 !important;
      flex: 1 !important;
      border: none !important;
      background: transparent !important;
      color: var(--th-text) !important;
      padding: 0 !important;
      cursor: pointer !important;
      text-align: left !important;
    }
    .toolbar-logo-image {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .toolbar-title {
      font-weight: 800;
      font-size: 14px;
      letter-spacing: 0;
      white-space: nowrap;
      color: var(--th-text);
    }
    .toolbar-count-label {
      min-width: 24px;
      height: 25px;
      padding: 0 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border-radius: 999px;
      background: var(--th-surface);
      font-size: 11px;
      color: var(--th-muted);
      white-space: nowrap;
    }
    .toolbar-card-count {
      font-weight: 900 !important;
      color: var(--th-accent-2) !important;
    }
    .toolbar-count-context {
      color: var(--th-muted);
      font-weight: 600;
    }
    .toolbar-head-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
    }
    .toolbar-panel-close,
    .toolbar-hide-btn {
      width: 34px !important;
      height: 34px !important;
      padding: 0 !important;
      border-radius: 999px !important;
      border: 1px solid var(--th-border) !important;
      background: var(--th-surface) !important;
      color: var(--th-text) !important;
      cursor: pointer !important;
      flex: 0 0 auto !important;
      font-size: 17px !important;
      line-height: 1 !important;
    }
    .toolbar-panel-close:hover,
    .toolbar-hide-btn:hover,
    .toolbar-panel-toggle:hover {
      background: var(--th-surface-strong) !important;
    }
    .toolbar-edge-tab {
      display: none !important;
      width: 100% !important;
      height: 100% !important;
      padding: 8px 5px !important;
      border: 0 !important;
      border-radius: inherit !important;
      background: transparent !important;
      color: var(--th-text) !important;
      cursor: pointer !important;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
    }
    #tiktok-talent-helper-toolbar.is-hidden .toolbar-compact-head,
    #tiktok-talent-helper-toolbar.is-hidden .toolbar-panel-body {
      display: none !important;
    }
    #tiktok-talent-helper-toolbar.is-hidden .toolbar-edge-tab {
      display: flex !important;
    }
    .toolbar-edge-arrow {
      font-size: 13px;
      line-height: 1;
      color: var(--th-accent-2);
    }
    .toolbar-edge-logo {
      width: 28px;
      height: 28px;
      object-fit: contain;
    }
    #tiktok-talent-helper-toolbar[data-side="left"] .toolbar-edge-arrow::before {
      content: "›";
    }
    #tiktok-talent-helper-toolbar[data-side="right"] .toolbar-edge-arrow::before {
      content: "‹";
    }
    .toolbar-panel-body {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .toolbar-date-group,
    .toolbar-selection-actions,
    .toolbar-utility-row {
      flex: 1 0 100%;
    }
    .toolbar-selection-actions,
    .toolbar-utility-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .toolbar-selection-actions {
      display: none;
    }
    #tiktok-talent-helper-toolbar.is-selection-mode .toolbar-selection-actions {
      display: flex;
    }
    .toolbar-selection-actions .toolbar-action-btn {
      flex: 1 1 calc((100% - 102px - 24px) / 3);
      min-width: 104px;
      justify-content: center;
    }
    .toolbar-selection-actions .toolbar-selection-badge {
      flex: 0 0 auto;
      min-width: 86px;
    }
    .toolbar-utility-row .toolbar-sort-select {
      flex: 1 1 170px;
    }
    .toolbar-utility-row .toolbar-action-btn {
      flex: 0 1 auto;
    }
    .toolbar-export-option {
      height: 34px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      border-radius: 12px;
      border: 1px solid var(--th-border);
      background: var(--th-surface);
      color: var(--th-text);
      font-size: 12px;
      font-weight: 800;
      cursor: pointer !important;
      user-select: none;
      box-sizing: border-box;
      transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
    }
    .toolbar-export-option:hover {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--th-accent) 42%, var(--th-border));
      background: var(--th-surface-strong);
    }
    .toolbar-export-option input {
      width: 14px;
      height: 14px;
      accent-color: var(--th-accent);
      cursor: pointer !important;
      flex: 0 0 auto;
    }
    .toolbar-export-option-text {
      white-space: nowrap;
      pointer-events: none;
    }
    #tiktok-talent-helper-toolbar.is-selection-mode .toolbar-utility-row .toolbar-btn-export {
      display: none !important;
    }
    #tiktok-talent-helper-toolbar.is-selection-mode .toolbar-utility-row .toolbar-btn-select-entry {
      display: none !important;
    }
    .toolbar-export-progress {
      display: none;
      flex: 1 0 100%;
      padding: 10px 11px;
      border-radius: 15px;
      border: 1px solid color-mix(in srgb, var(--th-accent) 22%, var(--th-border));
      background:
        radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--th-accent-2) 16%, transparent), transparent 38%),
        color-mix(in srgb, var(--th-surface-strong) 72%, transparent);
      box-shadow: 0 10px 26px color-mix(in srgb, var(--th-shadow) 58%, transparent);
      box-sizing: border-box;
      overflow: hidden;
    }
    .toolbar-export-progress.is-visible {
      display: block;
    }
    .toolbar-export-progress-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 8px;
      font-size: 12px;
      line-height: 1.2;
    }
    .toolbar-export-progress-title {
      color: var(--th-text);
      font-weight: 800;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-export-progress-value {
      color: var(--th-accent-2);
      font-weight: 900;
      white-space: nowrap;
    }
    .toolbar-export-progress-track {
      height: 7px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--th-text) 12%, transparent);
      overflow: hidden;
    }
    .toolbar-export-progress-bar {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--th-accent), var(--th-accent-2));
      box-shadow: 0 0 18px color-mix(in srgb, var(--th-accent-2) 42%, transparent);
      transition: width 0.22s ease;
    }
    .toolbar-export-progress-detail {
      margin-top: 7px;
      color: var(--th-muted);
      font-size: 11px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #tiktok-talent-helper-toolbar .toolbar-date-chip {
      position: relative;
      border-radius: 12px;
      border: 1px solid var(--th-border);
      background: linear-gradient(180deg, var(--th-surface-strong), var(--th-surface));
      color: var(--th-text);
      cursor: pointer !important;
    }
    #tiktok-talent-helper-toolbar .toolbar-date-chip:hover,
    #tiktok-talent-helper-toolbar .toolbar-date-chip:focus {
      border-color: color-mix(in srgb, var(--th-accent) 42%, var(--th-border));
      background: linear-gradient(180deg, var(--th-surface-strong), color-mix(in srgb, var(--th-surface) 86%, var(--th-accent) 14%));
    }
    #tiktok-talent-helper-toolbar .toolbar-date-label {
      color: var(--th-text);
    }
    #tiktok-talent-helper-toolbar .toolbar-date-icon {
      opacity: 0.74;
      font-size: 9px;
      font-weight: 900;
      letter-spacing: 0.7px;
    }
    #tiktok-talent-helper-toolbar .toolbar-date-chip::after {
      content: "";
      position: absolute;
      inset: -2px;
    }
    #tiktok-talent-helper-toolbar .toolbar-date-separator {
      color: var(--th-muted);
    }
    #tiktok-talent-helper-toolbar .toolbar-date-clear {
      border: 1px solid var(--th-border);
      background: var(--th-surface);
      color: var(--th-text);
      cursor: pointer !important;
    }
    #tiktok-talent-helper-calendar {
      --th-bg: rgba(12, 13, 18, 0.96);
      --th-surface: rgba(255,255,255,0.08);
      --th-border: rgba(238, 234, 220, 0.16);
      --th-text: #f5f1e8;
      --th-muted: rgba(245,241,232,0.58);
      --th-accent: #d8b36b;
      --th-accent-2: #74d8cf;
      --th-button-text: #10120f;
      --th-shadow: rgba(0,0,0,0.38);
      border-radius: 16px;
      background: var(--th-bg);
      border: 1px solid var(--th-border);
      box-shadow: 0 18px 42px var(--th-shadow);
      color: var(--th-text);
      font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    #tiktok-talent-helper-calendar[data-theme="paper"] {
      --th-bg: rgba(255, 252, 244, 0.97);
      --th-surface: rgba(96,72,47,0.08);
      --th-border: rgba(92, 70, 47, 0.18);
      --th-text: #2b2118;
      --th-muted: rgba(43,33,24,0.58);
      --th-accent: #9f7042;
      --th-accent-2: #2e756c;
      --th-button-text: #fffaf0;
      --th-shadow: rgba(112, 79, 45, 0.18);
    }
    #tiktok-talent-helper-calendar[data-theme="ocean"] {
      --th-bg: rgba(6, 22, 21, 0.96);
      --th-surface: rgba(217,246,232,0.08);
      --th-border: rgba(187,230,216,0.2);
      --th-text: #f3fbf5;
      --th-muted: rgba(243,251,245,0.58);
      --th-accent: #9bcfbd;
      --th-accent-2: #d9b86d;
      --th-button-text: #071b18;
      --th-shadow: rgba(0, 52, 46, 0.36);
    }
    #tiktok-talent-helper-calendar[data-theme="ember"] {
      --th-bg: rgba(23, 15, 10, 0.96);
      --th-surface: rgba(246,196,133,0.08);
      --th-border: rgba(247,198,134,0.2);
      --th-text: #fff6e9;
      --th-muted: rgba(255,246,233,0.58);
      --th-accent: #c98d4b;
      --th-accent-2: #f1cc7c;
      --th-button-text: #261408;
      --th-shadow: rgba(52,23,6,0.38);
    }
    #tiktok-talent-helper-calendar .calendar-title {
      font-weight: 900;
      color: var(--th-text);
    }
    #tiktok-talent-helper-calendar .calendar-nav {
      border: 1px solid var(--th-border);
      background: var(--th-surface);
      color: var(--th-text);
      cursor: pointer !important;
    }
    #tiktok-talent-helper-calendar .calendar-weekdays span {
      color: var(--th-muted);
    }
    #tiktok-talent-helper-calendar .calendar-day {
      color: var(--th-text);
      cursor: pointer !important;
    }
    #tiktok-talent-helper-calendar .calendar-day:hover {
      background: var(--th-surface);
      border-color: var(--th-border);
    }
    #tiktok-talent-helper-calendar .calendar-day.is-muted {
      color: color-mix(in srgb, var(--th-muted) 50%, transparent);
    }
    #tiktok-talent-helper-calendar .calendar-day.is-selected {
      color: var(--th-button-text);
      background: linear-gradient(135deg, var(--th-accent), var(--th-accent-2));
    }
    .toolbar-action-btn,
    .toolbar-sort-select {
      height: 34px;
      border-radius: 12px;
      border: 1px solid var(--th-border) !important;
      background: var(--th-surface) !important;
      color: var(--th-text) !important;
      padding: 0 11px;
      font-size: 12px;
      font-weight: 800;
      outline: none;
      cursor: pointer !important;
      box-sizing: border-box;
      transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, opacity 0.18s ease;
    }
    .toolbar-action-btn:hover,
    .toolbar-sort-select:hover,
    .toolbar-sort-select:focus {
      transform: translateY(-1px);
      border-color: color-mix(in srgb, var(--th-accent) 42%, var(--th-border)) !important;
      background: var(--th-surface-strong) !important;
    }
    .toolbar-sort-select {
      min-width: 154px;
    }
    .toolbar-action-btn.is-primary {
      border-color: transparent !important;
      color: var(--th-button-text) !important;
      background: linear-gradient(135deg, var(--th-accent), var(--th-accent-2)) !important;
      box-shadow: 0 8px 20px var(--th-glow);
    }
    .toolbar-action-btn.is-selected-mode {
      border-color: transparent !important;
      color: var(--th-button-text) !important;
      background: linear-gradient(135deg, var(--th-accent-2), var(--th-accent)) !important;
      box-shadow: 0 8px 20px var(--th-glow);
    }
    .toolbar-action-btn.is-running {
      border-color: transparent !important;
      color: var(--th-button-text) !important;
      background: linear-gradient(135deg, var(--th-accent-2), var(--th-accent)) !important;
      box-shadow: 0 8px 20px var(--th-glow);
    }
    .toolbar-action-btn:disabled {
      opacity: 0.48;
      cursor: not-allowed !important;
      transform: none;
    }
    #tiktok-talent-helper-toolbar .toolbar-selection-badge {
      background: var(--th-surface);
      border: 1px solid var(--th-border);
      color: var(--th-text);
      font-weight: 800;
    }
    @keyframes pulse {
      0% { opacity: 0.5; }
      50% { opacity: 1; }
      100% { opacity: 0.5; }
    }
    .helper-reading-pulse {
      animation: pulse 1.5s infinite ease-in-out;
      background: rgba(255, 170, 0, 0.2) !important;
      border-color: rgba(255, 170, 0, 0.35) !important;
      color: #ffe6aa !important;
    }
  `;
  document.head.appendChild(style);
}

// 等待 DOM 构建就绪后，再启动 UI 渲染与首屏数据扫描
function initApp() {
  console.log("[达人数据助手] 内容渲染脚本已在隔离世界就绪，启动 UI 功能...");
  injectStyles();
  parsePageJsonData();
  initToolbar();
  scanCards();
  cleanupLegacyDownloadButton();
  watchDOMChanges();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

/**
 * 将播放量文本（如 1.2M, 500K）解析为数值
 * @param {string} text - 待解析的文本
 * @returns {number} 转换后的播放量数值
 */
function parseViewCount(text) {
  const cleanText = text.trim().toUpperCase();
  const numVal = parseFloat(cleanText);
  if (isNaN(numVal)) return 0;

  if (cleanText.endsWith('M')) return numVal * 1000000;
  if (cleanText.endsWith('K')) return numVal * 1000;
  if (cleanText.endsWith('B')) return numVal * 1000000000;
  return numVal;
}

/**
 * 遍历页面脚本标签，寻找并解析首屏已嵌入的视频 JSON 数据包
 */
function parsePageJsonData() {
  const scripts = Array.from(document.querySelectorAll('script'));
  scripts.forEach(script => {
    try {
      if (script.src) return;
      const content = script.textContent.trim();
      if (!content) return;

      const isDataScript = script.id === '__UNIVERSAL_DATA_FOR_REHYDRATION__' ||
                           script.id === 'SIGI_STATE' ||
                           script.id === 'sigi-state' ||
                           script.type === 'application/json' ||
                           (content.includes('createTime') && (content.includes('playCount') || content.includes('diggCount')));

      if (!isDataScript) return;

      const jsonText = extractJsonFromScript(content);
      if (!jsonText) return;

      const safeContent = jsonText.replace(/:\s*(\d{16,21})/g, ': "$1"');
      const parsed = JSON.parse(safeContent);
      recursiveExtractVideoInfo(parsed);
    } catch (e) {
      // 忽略无效 JSON 解析
    }
  });
}

/**
 * 从 script 标签文本内容中匹配并提取出纯 JSON 字符串
 * @param {string} text - 脚本的原始文本内容
 * @returns {string|null} 提取出的 JSON 字符串，匹配失败返回 null
 */
function extractJsonFromScript(text) {
  if (text.startsWith('{') && text.endsWith('}')) {
    return text;
  }
  const match = text.match(/window\s*\.\s*[a-zA-Z0-9_]+\s*=\s*(\{[\s\S]*\});?\s*$/) ||
                text.match(/=\s*(\{[\s\S]*\});?\s*$/);
  return match ? match[1] : null;
}

/**
 * 递归遍历复杂 JSON 树以提取视频节点并进行缓存
 * @param {Object} obj - 待扫描的 JSON 子对象
 */
function recursiveExtractVideoInfo(obj) {
  if (!obj || typeof obj !== 'object') return;

  const itemId = obj.id || obj.awemeId || obj.videoId || obj.itemId || obj.aweme_id;
  const createTime = obj.createTime !== undefined ? obj.createTime : obj.create_time;

  if (itemId && createTime !== undefined) {
    // 只有当它不包含用户信息独有字段，且包含视频专属特征时，才确认为视频数据节点
    const isUserNode = obj.uniqueId || obj.nickname || obj.avatarThumb || obj.secUid;
    const isVideoNode = obj.desc !== undefined || obj.stats !== undefined || obj.video !== undefined;

    if (!isUserNode && isVideoNode) {
      updateApiVideoCache(obj, String(itemId), createTime);
    }
  }

  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      recursiveExtractVideoInfo(obj[key]);
    }
  }
}

/**
 * 将解析出的视频节点元数据更新并缓存至全局变量 apiVideos 中
 * @param {Object} obj - 视频数据节点对象
 * @param {string} vId - 视频的唯一标识符 ID
 * @param {number|string} createTime - 视频创建的时间戳
 */
function updateApiVideoCache(obj, vId, createTime) {
  const stats = obj.stats || obj.statistics || obj;
  const video = obj.video || {};

  // 调用辅助函数兼容提取合法的播放直链，防范误拿对象数据
  const playUrl = extractPlayUrl(video) || extractBestMediaUrlFromAnyPayload(obj);

  // 提取视频描述
  const desc = obj.desc || '';

  // 提取视频时长并进行毫秒与秒的单位兼容转换
  let duration = 0;
  if (video.duration !== undefined) {
    duration = parseInt(video.duration);
  } else if (obj.duration !== undefined) {
    duration = parseInt(obj.duration);
  } else if (video.duration_raw !== undefined) {
    duration = parseInt(video.duration_raw);
  }
  if (duration > 1000) {
    duration = Math.round(duration / 1000);
  }

  const products = extractCommerceProducts(obj);
  const commerceMeta = normalizeCommerceMeta(extractCommerceMeta(obj), products);
  const previous = apiVideos[vId] || {};
  const subtitles = mergeSubtitleCandidates(previous.subtitles, extractSubtitleCandidates(obj));
  const previousCommerceMeta = previous.commerceMeta || {};
  const mergedCommerceMeta = normalizeCommerceMeta(
    mergeCommerceMeta(previousCommerceMeta, commerceMeta),
    products.length ? products : (previous.products || [])
  );

  apiVideos[vId] = {
    createTime: parseInt(createTime),
    views: parseInt(stats.playCount || stats.viewCount || stats.play_count || stats.view_count || stats.views || 0),
    likes: parseInt(stats.diggCount || stats.digg_count || stats.likeCount || stats.like_count || stats.likes || 0),
    comments: parseInt(stats.commentCount || stats.comment_count || stats.comments || 0),
    shares: parseInt(stats.shareCount || stats.share_count || stats.shares || 0),
    playUrl: playUrl || previous.playUrl || '',
    duration: duration,
    desc: desc,
    products: products.length ? products : (previous.products || []),
    commerceMeta: mergedCommerceMeta,
    subtitles
  };
  console.log(`[达人数据助手] 成功缓存视频数据: ID=${vId}, 日期=${formatTimestamp(createTime)}, 时长=${duration}秒, 播放=${apiVideos[vId].views}`);
}

function extractCommerceProducts(root) {
  const products = [];
  const seen = new Set();
  collectCommerceProducts(root, products, seen, 0, '');
  return products.slice(0, 12);
}

function extractTikTokShopProductIds(root) {
  const ids = [];
  const seenIds = new Set();
  collectTikTokShopProductIds(root, ids, seenIds, 0, new Set());
  return ids.slice(0, 6);
}

function mergeCapturedCommercePayload(videoId, payload, sourceUrl, capturedProductIds = []) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!/^\d{8,}$/.test(normalizedVideoId)) return;

  const previous = apiVideos[normalizedVideoId] || {};
  const payloadProducts = payload ? extractCommerceProducts(payload) : [];
  const productIds = Array.from(new Set([
    ...capturedProductIds,
    ...(payload ? extractTikTokShopProductIds(payload) : []),
    ...extractTikTokShopProductIds(sourceUrl)
  ])).slice(0, 6);
  const products = mergeCommerceProducts(previous.products || [], payloadProducts);
  const sourceLabel = getCommerceCaptureSourceLabel(sourceUrl);
  const commerceMeta = normalizeCommerceMeta(
    mergeCommerceMeta(previous.commerceMeta, {
      isCommerceVideo: true,
      productHints: productIds.length,
      source: 'session-capture',
      sourceStatuses: [buildSourceStatus('session-capture', products.length ? 'products' : 'signal', sourceLabel)]
    }),
    products
  );

  apiVideos[normalizedVideoId] = {
    ...previous,
    products,
    commerceMeta
  };

  const pendingProductIds = productIds.filter((productId) => {
    const key = `${normalizedVideoId}:${productId}`;
    if (capturedProductEnrichmentKeys.has(key)) return false;
    capturedProductEnrichmentKeys.add(key);
    return true;
  });
  if (pendingProductIds.length) {
    enrichCapturedProductIds(normalizedVideoId, pendingProductIds, sourceUrl);
  }
}

async function enrichCapturedProductIds(videoId, productIds, sourceUrl) {
  let resolved = false;
  try {
    const shopProducts = await fetchTikTokShopProducts(productIds, sourceUrl);
    resolved = shopProducts.length > 0;
    const previous = apiVideos[videoId] || {};
    const products = mergeCommerceProducts(previous.products || [], shopProducts);
    apiVideos[videoId] = {
      ...previous,
      products,
      commerceMeta: normalizeCommerceMeta(
        mergeCommerceMeta(previous.commerceMeta, {
          isCommerceVideo: true,
          hasProducts: products.length > 0,
          source: 'session-capture',
          sourceStatuses: [buildSourceStatus('session-pdp', shopProducts.length ? 'products' : 'no-products', productIds.join(','))]
        }),
        products
      )
    };
  } catch (error) {
    const previous = apiVideos[videoId] || {};
    const products = previous.products || [];
    apiVideos[videoId] = {
      ...previous,
      commerceMeta: normalizeCommerceMeta(
        mergeCommerceMeta(previous.commerceMeta, {
          isCommerceVideo: true,
          sourceStatuses: [buildSourceStatus('session-pdp', 'error', error && error.message ? error.message : '')]
        }),
        products
      )
    };
  }
  if (!resolved) {
    productIds.forEach((productId) => capturedProductEnrichmentKeys.delete(`${videoId}:${productId}`));
  }
  if (document.body) scanCards();
}

function getCommerceCaptureSourceLabel(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl, location.origin);
    return parsed.pathname.slice(0, 100);
  } catch (error) {
    return String(sourceUrl || '').slice(0, 100);
  }
}

function extractSubtitleCandidates(root) {
  const candidates = [];
  const seen = new Set();
  collectSubtitleCandidates(root, candidates, seen, 0, '');
  return candidates.slice(0, 8);
}

function collectSubtitleCandidates(value, candidates, seen, depth, keyPath) {
  if (!value || depth > 8 || candidates.length >= 8) return;

  if (typeof value === 'string') {
    const url = normalizeSubtitleUrl(value);
    if (url && isLikelySubtitleContext(keyPath, url)) {
      pushSubtitleCandidate(candidates, {
        url,
        language: inferSubtitleLanguageFromPath(keyPath) || inferSubtitleLanguageFromUrl(url),
        format: inferSubtitleFormat(url)
      });
    }
    const parsed = parsePossibleJson(value);
    if (parsed) collectSubtitleCandidates(parsed, candidates, seen, depth + 1, keyPath);
    return;
  }

  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item, index) => {
      collectSubtitleCandidates(item, candidates, seen, depth + 1, `${keyPath}.${index}`);
    });
    return;
  }

  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  const joinedKeys = Object.keys(value).join(' ');
  const context = `${keyPath} ${joinedKeys}`;
  const directUrl = normalizeSubtitleUrl(
    value.url || value.uri || value.link || value.download_url || value.downloadUrl || value.subtitle_url || value.subtitleUrl
  ) || normalizeSubtitleUrl(value.url_list || value.urlList || value.urls);
  if (directUrl && isLikelySubtitleContext(context, directUrl)) {
    pushSubtitleCandidate(candidates, {
      url: directUrl,
      language: normalizeSubtitleLanguage(value.language_code || value.languageCode || value.lang || value.language || value.lan || keyPath),
      format: normalizeSubtitleFormat(value.format || value.mime_type || value.mimeType) || inferSubtitleFormat(directUrl)
    });
  }

  Object.entries(value).forEach(([key, child]) => {
    collectSubtitleCandidates(child, candidates, seen, depth + 1, `${keyPath}.${key}`);
  });
}

function normalizeSubtitleUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    return /^https?:\/\//i.test(text) ? text : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = normalizeSubtitleUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    return normalizeSubtitleUrl(value.url) ||
      normalizeSubtitleUrl(value.url_list) ||
      normalizeSubtitleUrl(value.urlList) ||
      normalizeSubtitleUrl(value.uri) ||
      normalizeSubtitleUrl(value.link);
  }
  return '';
}

function isLikelySubtitleContext(keyPath, url) {
  const text = `${keyPath || ''} ${url || ''}`.toLowerCase();
  return /subtitle|caption|captions|cla|vtt|srt|webvtt|subtitles|caption_infos|subtitle_infos/.test(text);
}

function pushSubtitleCandidate(candidates, candidate) {
  const url = candidate && candidate.url ? String(candidate.url).trim() : '';
  if (!url || candidates.some((item) => item.url === url)) return;
  candidates.push({
    url,
    language: normalizeSubtitleLanguage(candidate.language),
    format: normalizeSubtitleFormat(candidate.format) || inferSubtitleFormat(url)
  });
}

function mergeSubtitleCandidates(...groups) {
  const merged = [];
  groups.flat().forEach((candidate) => pushSubtitleCandidate(merged, candidate));
  return merged;
}

function normalizeSubtitleLanguage(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/\b([a-z]{2}(?:[-_][A-Za-z]{2})?)\b/);
  return match ? match[1].replace('_', '-') : text.slice(0, 24);
}

function inferSubtitleLanguageFromPath(value) {
  return normalizeSubtitleLanguage(value);
}

function inferSubtitleLanguageFromUrl(url) {
  try {
    const parsed = new URL(url);
    return normalizeSubtitleLanguage(parsed.searchParams.get('lang') || parsed.searchParams.get('language'));
  } catch (error) {
    return '';
  }
}

function normalizeSubtitleFormat(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('vtt')) return 'vtt';
  if (text.includes('srt')) return 'srt';
  if (text.includes('json')) return 'json';
  return '';
}

function inferSubtitleFormat(url) {
  const lowerUrl = String(url || '').toLowerCase();
  if (lowerUrl.includes('.vtt') || lowerUrl.includes('webvtt')) return 'vtt';
  if (lowerUrl.includes('.srt')) return 'srt';
  if (lowerUrl.includes('.json')) return 'json';
  return '';
}

function collectTikTokShopProductIds(value, ids, seenIds, depth, seenObjects) {
  if (!value || depth > 8 || ids.length >= 6) return;

  if (typeof value === 'string') {
    collectTikTokShopProductIdsFromString(value, ids, seenIds);
    const parsed = parsePossibleJson(value);
    if (parsed) {
      collectTikTokShopProductIds(parsed, ids, seenIds, depth + 1, seenObjects);
    }
    return;
  }

  if (typeof value !== 'object' || seenObjects.has(value)) return;
  seenObjects.add(value);

  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item) => collectTikTokShopProductIds(item, ids, seenIds, depth + 1, seenObjects));
    return;
  }

  const directId = pickFirstString(value, [
    'placeholder_product_id', 'product_id', 'productId', 'productIdStr',
    'goods_id', 'goodsId', 'shop_item_id', 'shopItemId'
  ]);
  pushProductId(ids, seenIds, directId);

  Object.values(value).forEach((child) => {
    collectTikTokShopProductIds(child, ids, seenIds, depth + 1, seenObjects);
  });
}

function collectTikTokShopProductIdsFromString(text, ids, seenIds) {
  const value = String(text || '');
  if (!/(placeholder_product_id|product_id|productId|shop\.tiktok|ec_shared_reflux_dynamic_params|requestParams|pdp)/i.test(value)) return;

  const decodedCandidates = [value];
  try {
    decodedCandidates.push(decodeURIComponent(value));
  } catch (error) {
    // 忽略无法 decode 的普通文本
  }

  decodedCandidates.forEach((candidate) => {
    const patterns = [
      /placeholder_product_id["'=:%]+([0-9]{8,})/gi,
      /product_id["'=:%\[\]]+([0-9]{8,})/gi,
      /productId["'=:%]+([0-9]{8,})/gi,
      /\/(?:pdp|product)\/[^"'?\s/]*\/([0-9]{8,})/gi,
      /\/(?:pdp|product)\/([0-9]{8,})/gi
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(candidate))) {
        pushProductId(ids, seenIds, match[1]);
      }
    });
  });
}

function pushProductId(ids, seenIds, value) {
  const normalized = String(value || '').trim().replace(/[^\d]/g, '');
  if (!/^\d{8,}$/.test(normalized) || seenIds.has(normalized) || ids.length >= 6) return;
  seenIds.add(normalized);
  ids.push(normalized);
}

function extractCommerceMeta(root) {
  const meta = {
    isCommerceVideo: false,
    anchorTypes: [],
    productHints: 0,
    source: ''
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
  return `${label}:${status}${detail ? `:${detail}` : ''}`;
}

async function fetchExternalTikTokDetail(videoId, detailUrl) {
  const result = await sendRuntimeMessage({
    action: EXTERNAL_TIKTOK_DETAIL_ACTION,
    videoId,
    detailUrl: detailUrl || ''
  });

  if (!result || !result.success || !result.payload) {
    throw new Error(result && result.error ? result.error : '外部解析没有返回数据');
  }

  const payload = result.payload;
  let products = extractCommerceProducts(payload);
  const shopProductIds = extractTikTokShopProductIds(payload);
  const sourceStatuses = [
    buildSourceStatus(result.source || 'external', products.length ? 'products' : 'no-products')
  ];

  if (shopProductIds.length) {
    try {
      const shopProducts = await fetchTikTokShopProducts(shopProductIds);
      products = mergeCommerceProducts(products, shopProducts);
      sourceStatuses.push(buildSourceStatus('shop-pdp', shopProducts.length ? 'products' : 'no-products', shopProductIds.join(',')));
    } catch (error) {
      console.warn('[达人数据助手][content] TikTok Shop 商品页解析失败:', error);
      sourceStatuses.push(buildSourceStatus('shop-pdp', 'error', error && error.message ? error.message : ''));
    }
  }

  const mediaUrl = extractBestMediaUrlFromAnyPayload(payload);
  const subtitles = extractSubtitleCandidates(payload);
  const commerceMeta = normalizeCommerceMeta(
    {
      ...extractCommerceMeta(payload),
      source: products.length ? 'external-parser' : 'external-parser-empty',
      productHints: shopProductIds.length,
      sourceStatuses
    },
    products
  );

  recursiveExtractVideoInfo(payload);
  return {
    mediaUrl,
    products,
    commerceMeta,
    rawSource: result.source || '',
    shopProductIds,
    subtitles
  };
}

async function fetchPageContextCommerceDetail(videoId, detailUrl, currentInfo = {}) {
  const resolved = await requestPageContextDownload({
    videoId,
    filename: buildVideoFilename(currentInfo.desc || 'video', videoId),
    preferredUrl: currentInfo.playUrl || '',
    detailUrl,
    includeCommerceDetail: true,
    mode: 'resolveCommerce',
    silent: true,
    timeoutMs: PREVIEW_COMMERCE_DETAIL_TIMEOUT_MS
  });

  const products = Array.isArray(resolved.products) ? resolved.products : [];
  const commerceMeta = normalizeCommerceMeta(resolved.commerceMeta, products);
  recursiveExtractVideoInfo(resolved);
  return {
    mediaUrl: resolved.mediaUrl || '',
    products,
    commerceMeta
  };
}

async function fetchTikTokShopProducts(productIds, sourceUrl = '') {
  const ids = Array.from(new Set((productIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return [];
  const products = [];

  for (const productId of ids.slice(0, 4)) {
    const result = await sendRuntimeMessage({
      action: TIKTOK_SHOP_PRODUCT_ACTION,
      productId,
      productUrl: sourceUrl || ''
    });
    if (result && result.success && Array.isArray(result.products)) {
      products.push(...result.products);
    } else {
      throw new Error(result && result.error ? result.error : `商品 ${productId} 解析失败`);
    }
  }

  return mergeCommerceProducts(products);
}

async function enrichVideoWithExternalDetail(videoId, detailUrl, currentInfo = {}) {
  const external = await fetchExternalTikTokDetail(videoId, detailUrl);
  const products = mergeCommerceProducts(currentInfo.products || [], external.products || []);
  const commerceMeta = normalizeCommerceMeta(
    mergeCommerceMeta(currentInfo.commerceMeta, external.commerceMeta),
    products
  );

  apiVideos[videoId] = {
    ...currentInfo,
    ...(apiVideos[videoId] || {}),
    playUrl: (apiVideos[videoId] && apiVideos[videoId].playUrl) || currentInfo.playUrl || external.mediaUrl || '',
    products,
    commerceMeta,
    subtitles: mergeSubtitleCandidates(currentInfo.subtitles, external.subtitles, apiVideos[videoId] && apiVideos[videoId].subtitles)
  };

  return {
    mediaUrl: external.mediaUrl,
    products,
    commerceMeta,
    subtitles: external.subtitles
  };
}

function getVideoCommerceStatus(videoId) {
  const info = videoId ? apiVideos[videoId] : null;
  if (!info) {
    return {
      state: 'unknown',
      label: '检测中',
      title: '正在等待 TikTok 接口数据，暂不能确认是否挂车'
    };
  }

  const products = Array.isArray(info.products) ? info.products.filter((item) => item && item.name) : [];
  const meta = normalizeCommerceMeta(info.commerceMeta, products);
  if (products.length) {
    return {
      state: 'commerce',
      label: `商品${products.length}`,
      title: `已解析到 ${products.length} 个商品`
    };
  }
  if (meta.isCommerceVideo || meta.productHints > 0) {
    return {
      state: 'commerce',
      label: '挂车',
      title: '已识别到电商/挂车视频信号，商品明细待解析'
    };
  }

  return {
    state: 'normal',
    label: '未挂车',
    title: '未从当前视频数据识别到挂车商品信号'
  };
}

function renderCommerceBadge(videoId) {
  if (!videoId) return '';
  const status = getVideoCommerceStatus(videoId);
  const className = status.state === 'commerce'
    ? 'is-commerce'
    : (status.state === 'normal' ? 'is-normal' : 'is-unknown');
  return `
    <div class="helper-bubble helper-bubble-commerce ${className}" title="${escapeAttribute(status.title)}">
      <span class="helper-commerce-dot"></span>${escapeHtml(status.label)}
    </div>
  `;
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
 * 格式化时间戳为年月日字符串
 * @param {number} ts - 时间戳数字
 * @returns {string} 格式化后的日期文本
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const date = new Date(ts * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  } catch (e) {
    return '';
  }
}

/**
 * 将视频秒数格式化为分秒的展示格式（例如 01:23）
 * @param {number} seconds - 视频的秒数时长
 * @returns {string} 格式化后的时长展示文本
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00';
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * 从视频描述中提取话题标签
 * @param {string} desc - 视频描述文本
 * @returns {string} 提取出的话题标签，多个话题以空格分隔
 */
function extractHashtags(desc) {
  if (!desc) return '';
  const matches = desc.match(/#[^\s#]+/g);
  return matches ? matches.join(' ') : '';
}

/**
 * 从视频数据对象中兼容提取合法的播放直链地址
 * @param {Object} video - 视频信息对象
 * @returns {string} 提取出的播放直链 URL，未找到返回空字符串
 */
function extractPlayUrl(video) {
  if (!video) return '';

  if (video.playAddr) {
    if (typeof video.playAddr === 'string') return video.playAddr;
    if (video.playAddr.urlList && video.playAddr.urlList.length > 0) return video.playAddr.urlList[0];
  }
  if (video.playAddrList && video.playAddrList.length > 0) return video.playAddrList[0];

  if (video.downloadAddr) {
    if (typeof video.downloadAddr === 'string') return video.downloadAddr;
    if (video.downloadAddr.urlList && video.downloadAddr.urlList.length > 0) return video.downloadAddr.urlList[0];
  }
  if (video.play_addr) {
    if (typeof video.play_addr === 'string') return video.play_addr;
    if (video.play_addr.url_list && video.play_addr.url_list.length > 0) return video.play_addr.url_list[0];
  }
  if (video.play_addr_list && video.play_addr_list.length > 0) return video.play_addr_list[0];

  return '';
}

function extractBestMediaUrlFromAnyPayload(payload) {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (url, extra = {}) => {
    if (!isPlayableMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      height: Number(extra.height || 0),
      bitrate: Number(extra.bitrate || 0)
    });
  };

  const pushAddr = (addr, extra = {}) => {
    if (!addr) return;
    if (typeof addr === 'string') {
      pushCandidate(addr, extra);
      return;
    }
    if (Array.isArray(addr)) {
      addr.forEach((item) => pushAddr(item, extra));
      return;
    }
    const urls = []
      .concat(addr.url_list || [])
      .concat(addr.urlList || [])
      .concat(addr.url ? [addr.url] : []);
    urls.forEach((url) => pushCandidate(url, {
      height: addr.height || extra.height,
      bitrate: addr.data_size || addr.bitrate || extra.bitrate
    }));
  };

  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return;
    if (typeof value === 'string') {
      pushCandidate(value);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;

    const video = value.video || value.video_info || value.videoInfo || value;
    pushAddr(video.play_addr || video.playAddr, { height: video.height, bitrate: video.bitrate });
    pushAddr(video.download_addr || video.downloadAddr, { height: video.height, bitrate: video.bitrate });
    pushAddr(video.play_addr_h264 || video.playAddrH264, { height: video.height, bitrate: video.bitrate });
    pushAddr(video.play_addr_bytevc1 || video.playAddrBytevc1, { height: video.height, bitrate: video.bitrate });
    pushAddr(video, { height: video.height, bitrate: video.bitrate });
    [].concat(video.bit_rate || video.bitrateInfo || video.bitrate_info || []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      pushAddr(item.play_addr || item.playAddr, {
        height: item.play_addr?.height || item.playAddr?.height || video.height,
        bitrate: item.bit_rate || item.bitrate
      });
    });

    Object.entries(value).forEach(([key, child]) => {
      if (/cover|avatar|thumbnail|music|audio/i.test(key)) return;
      visit(child, depth + 1);
    });
  };

  visit(payload);

  candidates.sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));
  return candidates[0] ? candidates[0].url : '';
}

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
    lowerUrl.includes('tiktokv') ||
    lowerUrl.includes('byteoversea') ||
    lowerUrl.includes('bytefcdn')
  );
}

/**
 * 基于链接元素提取视频 ID
 * @param {HTMLAnchorElement | null} link - 视频链接元素
 * @returns {string|null} 提取出的 videoId
 */
function getVideoIdFromLink(link) {
  if (!link || !link.href) return null;
  const match = link.href.match(/\/video\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * 判断链接所在节点是否像一个真实的视频卡片，而不是占位或导航元素
 * @param {HTMLElement|null} cardEl - 卡片根节点
 * @param {HTMLAnchorElement} link - 视频链接元素
 * @returns {boolean} 是否应纳入扫描结果
 */
function isValidVideoCard(cardEl, link) {
  if (!cardEl || !link) return false;
  if (!cardEl.isConnected) return false;

  const rect = cardEl.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 120) return false;

  const hasPreviewImage = !!cardEl.querySelector('img');
  const hasViewNode = !!(
    cardEl.querySelector('[data-e2e="video-views"]') ||
    cardEl.querySelector('[class*="StrongVideoCount"]') ||
    cardEl.querySelector('[class*="video-count"]') ||
    cardEl.querySelector('strong')
  );
  const videoId = getVideoIdFromLink(link);
  const hasApiData = !!(videoId && apiVideos[videoId]);

  return hasPreviewImage || hasViewNode || hasApiData;
}

/**
 * 找到真正承载视频封面的媒体节点，避免浮层以整张卡片或标题区域作为定位坐标系。
 * @param {HTMLElement} cardEl - 扫描到的视频卡片节点
 * @param {HTMLAnchorElement} link - 视频详情链接
 * @returns {HTMLElement} 浮层挂载节点
 */
function resolveVideoOverlayHost(cardEl, link) {
  const candidates = [
    link && link.closest('[data-e2e="user-post-item"]'),
    link && link.closest('[class*="StyledDivContainer"]'),
    link && link.closest('[class*="DivVideoCover"]'),
    cardEl
  ];

  for (const candidate of candidates) {
    if (!candidate || !candidate.isConnected) continue;
    if (!candidate.contains(link)) continue;
    if (!candidate.querySelector('img, picture, video')) continue;

    const rect = candidate.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) continue;
    return candidate;
  }

  return cardEl;
}

/**
 * TikTok 偶尔把 PNG 原图放进声明为 AVIF 的 picture source，Chrome 会显示破图。
 * 仅在图片确实加载失败时移除 source，并用 img 自身的原图地址重试一次。
 * @param {HTMLElement} cardEl - 视频卡片节点
 * @param {HTMLAnchorElement} link - 视频详情链接
 */
function repairBrokenVideoThumbnail(cardEl, link) {
  const img = (link && link.querySelector('img')) || cardEl.querySelector('img');
  if (!img || img.dataset.tiktokHelperThumbnailRepaired === '1') return;

  const repair = () => {
    if (img.naturalWidth > 0 || img.dataset.tiktokHelperThumbnailRepaired === '1') return;

    const picture = img.closest('picture');
    const sources = picture ? Array.from(picture.querySelectorAll('source')) : [];
    const sourceUrl = img.getAttribute('src') || img.currentSrc || img.src;
    if (!sources.length || !/^https?:\/\//i.test(sourceUrl)) return;

    img.dataset.tiktokHelperThumbnailRepaired = '1';
    sources.forEach((source) => source.remove());
    img.removeAttribute('srcset');
    img.src = '';
    img.src = sourceUrl;
  };

  if (img.complete && img.naturalWidth === 0) {
    repair();
    return;
  }

  if (img.dataset.tiktokHelperThumbnailRepairBound === '1') return;
  img.dataset.tiktokHelperThumbnailRepairBound = '1';
  img.addEventListener('error', repair, { once: true });
}

/**
 * 判断当前扫描项是否为可导出的真实视频记录
 * @param {Object} item - scanCards 生成的扫描项
 * @returns {boolean} 是否可导出
 */
function shouldExportCard(item) {
  if (!item || !item.videoId) return false;
  if (!item.url) return false;

  const info = apiVideos[item.videoId];
  if (info) {
    return !!(info.createTime || info.views || info.likes || info.comments || info.shares || info.desc || info.duration || info.playUrl);
  }

  return item.views > 0 && !!item.title;
}

/**
 * 判断当前是否启用了日期范围筛选
 * @returns {boolean} 是否已选择完整日期区间
 */
function hasDateRangeFilter() {
  return !!(rangeStartDate && rangeEndDate);
}

/**
 * 获取当前日期筛选区间对应的秒级时间戳
 * @returns {{startTs: number, endTs: number}|null} 日期区间，未完整选择则返回 null
 */
function getDateRangeTimestamps() {
  if (!hasDateRangeFilter()) return null;
  return {
    startTs: Math.floor(new Date(rangeStartDate).getTime() / 1000),
    endTs: Math.floor(new Date(rangeEndDate).getTime() / 1000) + 86399
  };
}

/**
 * 判断扫描项是否落在当前日期范围内；未选择日期时默认通过
 * @param {Object} item - scanCards 生成的扫描项
 * @returns {boolean} 是否符合日期筛选
 */
function isCardInDateRange(item) {
  const range = getDateRangeTimestamps();
  if (!range) return true;
  if (!item || !item.videoId || !apiVideos[item.videoId]) return false;

  const createTime = apiVideos[item.videoId].createTime;
  return createTime >= range.startTs && createTime <= range.endTs;
}

/**
 * 获取当前日期筛选后的有效扫描项
 * @param {Array<Object>} cards - 扫描项列表
 * @returns {Array<Object>} 过滤后的扫描项
 */
function getDateFilteredCards(cards) {
  return cards.filter(item => isCardInDateRange(item));
}

/**
 * 判断当前自动滚动是否已经刷过日期范围底部边界。
 * TikTok 主页通常按时间倒序加载，出现早于开始日期的视频即可停止继续下拉。
 * @returns {boolean} 是否应停止自动滚动
 */
function shouldStopAutoScrollForDateRange() {
  const range = getDateRangeTimestamps();
  if (!range) return false;

  return scannedCards.some((item) => {
    if (!isAutoScrollBoundaryCandidate(item)) return false;
    const createTime = item?.videoId && apiVideos[item.videoId]?.createTime;
    return Number.isFinite(createTime) && createTime < range.startTs;
  });
}

function isAutoScrollBoundaryCandidate(item) {
  const el = item?.element;
  if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  return rect.top < viewportHeight + 180 && rect.bottom > -120;
}

/**
 * 生成安全的下载文件名
 * @param {string} title - 视频标题
 * @param {string} videoId - 视频 ID
 * @param {string} ext - 文件扩展名
 * @returns {string} 清洗后的文件名
 */
function buildVideoFilename(title, videoId, ext = 'mp4') {
  const safeExt = sanitizeFileExtension(ext || 'mp4');
  const safeId = sanitizeFilenamePart(videoId || Date.now(), 'video', 36);
  const cleanTitle = sanitizeFilenamePart(title || 'video', 'video', 60);
  return sanitizeDownloadFilename(`tiktok_${cleanTitle}_${safeId}.${safeExt}`, `tiktok_${safeId}.${safeExt}`);
}

function sanitizeDownloadFilename(filename, fallback = `tiktok_video_${Date.now()}.mp4`) {
  const normalizedFallback = sanitizeFilenamePart(fallback, `tiktok_video_${Date.now()}.mp4`, 120);
  let value = normalizeFilenameText(filename || normalizedFallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!value) value = normalizedFallback;

  const dotIndex = value.lastIndexOf('.');
  const rawBase = dotIndex > 0 ? value.slice(0, dotIndex) : value;
  const rawExt = dotIndex > 0 ? value.slice(dotIndex + 1) : '';
  let base = sanitizeFilenamePart(rawBase, 'tiktok_video', 120);
  const ext = sanitizeFileExtension(rawExt || 'mp4');

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = `tiktok_${base}`;
  }

  return `${base.slice(0, 120)}.${ext}`;
}

function sanitizeFilenamePart(value, fallback = 'video', maxLength = 80) {
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

function sanitizeFileExtension(ext) {
  const cleanExt = String(ext || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return cleanExt.slice(0, 8) || 'mp4';
}

/**
 * 判断某个视频是否被选中
 * @param {string} videoId - 视频 ID
 * @returns {boolean} 是否已选中
 */
function isVideoSelected(videoId) {
  return !!videoId && selectedVideoIds.has(videoId);
}

/**
 * 更新工具栏中的选中数量展示
 */
function updateSelectionCount() {
  if (!toolbarElement) return;
  const badge = toolbarElement.querySelector('.toolbar-selection-badge');
  if (!badge) return;

  badge.textContent = `已选 ${selectedVideoIds.size}`;
  badge.classList.toggle('is-visible', selectionMode);
}

/**
 * 切换多选模式
 * @param {boolean=} forceState - 指定目标状态
 */
function toggleSelectionMode(forceState) {
  selectionMode = typeof forceState === 'boolean' ? forceState : !selectionMode;
  if (!selectionMode) {
    selectedVideoIds.clear();
  }
  updateSelectionCount();
  updateSelectionToolbarState();
  scanCards();
}

/**
 * 根据当前多选状态更新工具栏按钮文案
 */
function updateSelectionToolbarState() {
  if (!toolbarElement) return;
  const toggleBtns = toolbarElement.querySelectorAll('.toolbar-btn-select-mode');
  const downloadBtn = toolbarElement.querySelector('.toolbar-btn-download-selected');
  const exportBtn = toolbarElement.querySelector('.toolbar-btn-export');
  const exportSelectedBtn = toolbarElement.querySelector('.toolbar-btn-export-selected');
  toolbarElement.classList.toggle('is-selection-mode', selectionMode);
  toggleBtns.forEach((toggleBtn) => {
    toggleBtn.textContent = selectionMode ? '退出选择' : '选择视频';
    toggleBtn.classList.toggle('is-selected-mode', selectionMode);
  });
  if (downloadBtn) {
    downloadBtn.disabled = selectedVideoIds.size === 0;
  }
  if (exportSelectedBtn) {
    exportSelectedBtn.disabled = selectedVideoIds.size === 0;
  }
  if (exportBtn) {
    exportBtn.textContent = '导出 Excel';
  }
}

/**
 * 格式化日期范围按钮文案
 * @returns {string} 日期范围文案
 */
function getDateRangeLabel() {
  if (rangeStartDate && rangeEndDate) return `${rangeStartDate} 至 ${rangeEndDate}`;
  if (rangeStartDate) return `${rangeStartDate} 起`;
  if (rangeEndDate) return `截至 ${rangeEndDate}`;
  return '选择日期范围';
}

/**
 * 刷新日期范围按钮文案
 */
function updateDateRangeLabel() {
  if (!toolbarElement) return;
  const startLabel = toolbarElement.querySelector('.toolbar-date-start-label');
  const endLabel = toolbarElement.querySelector('.toolbar-date-end-label');
  const clearBtn = toolbarElement.querySelector('.toolbar-date-clear');
  if (startLabel) startLabel.textContent = rangeStartDate || '开始日期';
  if (endLabel) endLabel.textContent = rangeEndDate || '结束日期';
  if (clearBtn) clearBtn.classList.toggle('is-visible', !!(rangeStartDate || rangeEndDate));
}

/**
 * 同步开始/结束日期的值与可选范围，让两个日期框始终保持合法顺序
 */
function syncDateRangeInputs() {
  if (rangeStartDate && rangeEndDate && rangeStartDate > rangeEndDate) {
    rangeEndDate = rangeStartDate;
  }
}

/**
 * 将日期对象格式化为 yyyy-mm-dd
 * @param {Date} date - 日期对象
 * @returns {string} 日期字符串
 */
function formatDateValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 打开自定义日历面板
 * @param {"start"|"end"} field - 当前编辑字段
 * @param {HTMLElement} anchor - 触发按钮
 */
function openCalendarPopover(field, anchor) {
  if (!toolbarElement || !anchor) return;
  const popover = getCalendarPopover();
  if (!popover) return;

  activeDateField = field;
  const activeValue = field === 'start' ? rangeStartDate : rangeEndDate;
  calendarMonthDate = activeValue ? new Date(`${activeValue}T00:00:00`) : new Date();

  const rect = anchor.getBoundingClientRect();
  const width = 252;
  const height = 312;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const bottomTop = rect.bottom + 8;
  const top = bottomTop + height > window.innerHeight
    ? Math.max(12, rect.top - height - 8)
    : bottomTop;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.classList.add('is-open');
  renderCalendarPopover();
}

/**
 * 关闭自定义日历面板
 */
function closeCalendarPopover() {
  const popover = calendarPopoverElement;
  if (popover) popover.classList.remove('is-open');
}

/**
 * 渲染当前月份的自定义日历
 */
function renderCalendarPopover() {
  const popover = calendarPopoverElement;
  if (!popover) return;

  const year = calendarMonthDate.getFullYear();
  const month = calendarMonthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  const selectedValue = activeDateField === 'start' ? rangeStartDate : rangeEndDate;
  const monthTitle = `${year}-${String(month + 1).padStart(2, '0')}`;
  const days = [];

  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const value = formatDateValue(date);
    days.push(`
      <button class="calendar-day ${date.getMonth() !== month ? 'is-muted' : ''} ${value === selectedValue ? 'is-selected' : ''}" type="button" data-date="${value}">
        ${date.getDate()}
      </button>
    `);
  }

  popover.innerHTML = `
    <div class="calendar-header">
      <button class="calendar-nav calendar-prev" type="button">‹</button>
      <div class="calendar-title">${activeDateField === 'start' ? '选择开始日期' : '选择结束日期'} · ${monthTitle}</div>
      <button class="calendar-nav calendar-next" type="button">›</button>
    </div>
    <div class="calendar-weekdays">
      <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
    </div>
    <div class="calendar-grid">${days.join('')}</div>
  `;
}

/**
 * 应用选择的日期
 * @param {string} value - yyyy-mm-dd 日期值
 */
function applyCalendarDate(value) {
  if (activeDateField === 'start') {
    rangeStartDate = value;
    if (!rangeEndDate || value > rangeEndDate) {
      rangeEndDate = value;
    }
  } else {
    rangeEndDate = value;
    if (!rangeStartDate || value < rangeStartDate) {
      rangeStartDate = value;
    }
  }
  syncDateRangeInputs();
  updateDateRangeLabel();
  closeCalendarPopover();
}

function getCalendarPopover() {
  if (calendarPopoverElement && calendarPopoverElement.isConnected) {
    return calendarPopoverElement;
  }

  calendarPopoverElement = document.getElementById(TOOLBAR_CALENDAR_ID);
  if (!calendarPopoverElement) {
    calendarPopoverElement = document.createElement('div');
    calendarPopoverElement.id = TOOLBAR_CALENDAR_ID;
    calendarPopoverElement.className = 'toolbar-calendar-popover';
    document.body.appendChild(calendarPopoverElement);
  }
  applyToolbarTheme(toolbarElement?.dataset?.theme || DEFAULT_POPUP_THEME);
  return calendarPopoverElement;
}

/**
 * 绑定工具栏内联日期选择器
 */
function bindDateRangePicker() {
  const startChip = toolbarElement.querySelector('.toolbar-date-start-chip');
  const endChip = toolbarElement.querySelector('.toolbar-date-end-chip');
  const clearBtn = toolbarElement.querySelector('.toolbar-date-clear');
  const popover = getCalendarPopover();
  if (!startChip || !endChip || !clearBtn || !popover) return;

  startChip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCalendarPopover('start', startChip);
  }, true);

  endChip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCalendarPopover('end', endChip);
  }, true);

  clearBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    rangeStartDate = '';
    rangeEndDate = '';
    syncDateRangeInputs();
    updateDateRangeLabel();
    closeCalendarPopover();
  }, true);

  popover.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.classList.contains('calendar-prev')) {
      calendarMonthDate = new Date(calendarMonthDate.getFullYear(), calendarMonthDate.getMonth() - 1, 1);
      renderCalendarPopover();
      return;
    }
    if (target.classList.contains('calendar-next')) {
      calendarMonthDate = new Date(calendarMonthDate.getFullYear(), calendarMonthDate.getMonth() + 1, 1);
      renderCalendarPopover();
      return;
    }
    if (target.classList.contains('calendar-day')) {
      const value = target.getAttribute('data-date');
      if (value) applyCalendarDate(value);
    }
  });

  document.addEventListener('click', () => closeCalendarPopover());
  syncDateRangeInputs();
  updateDateRangeLabel();
}

/**
 * 切换视频选中状态
 * @param {string} videoId - 视频 ID
 */
function toggleVideoSelection(videoId) {
  if (!videoId) return;
  if (selectedVideoIds.has(videoId)) {
    selectedVideoIds.delete(videoId);
  } else {
    selectedVideoIds.add(videoId);
  }
  updateSelectionCount();
  updateSelectionToolbarState();
  scanCards();
}

/**
 * 将下载请求桥接到主世界执行，复用 TikTok 页面上下文进行真实视频下载
 * @param {Object} options - 下载请求参数
 * @returns {Promise<{mediaUrl?: string, filename?: string}>} 解析结果
 */
function requestPageContextDownload(options) {
  const { videoId, filename, preferredUrl, mode, detailUrl, includeCommerceDetail, silent, timeoutMs } = options || {};
  if (!videoId) {
    return Promise.resolve({});
  }

  const requestId = `download_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pageDownloadRequests.delete(requestId);
      reject(new Error('页面下载超时，请稍后重试'));
    }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 45000);

    pageDownloadRequests.set(requestId, { resolve, reject, timeoutId, silent: Boolean(silent) });

    window.postMessage({
      type: PAGE_DOWNLOAD_REQUEST_TYPE,
      requestId,
      videoId,
      filename,
      preferredUrl: preferredUrl || '',
      detailUrl: detailUrl || '',
      includeCommerceDetail: Boolean(includeCommerceDetail),
      mode: mode || 'download'
    }, '*');
  });
}

/**
 * 获取负责打包下载的隐藏扩展页面，避免在 TikTok 页面上下文里初始化 JSZip
 * @returns {HTMLIFrameElement} 隐藏 iframe
 */
function getZipperFrame() {
  let frame = document.getElementById(ZIPPER_FRAME_ID);
  if (frame && frame.contentWindow) {
    return frame;
  }

  frame = document.createElement('iframe');
  frame.id = ZIPPER_FRAME_ID;
  frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;pointer-events:none;';
  frame.setAttribute('aria-hidden', 'true');
  frame.addEventListener('load', () => {
    frame.dataset.ready = '1';
  });
  frame.src = chrome.runtime.getURL('zipper.html');
  document.documentElement.appendChild(frame);
  return frame;
}

/**
 * 等待隐藏打包页加载完成
 * @param {HTMLIFrameElement} frame - 隐藏 iframe
 * @returns {Promise<void>}
 */
function waitForZipperFrame(frame) {
  if (frame.dataset.ready === '1') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('打包器加载超时，请重新加载扩展后刷新页面'));
    }, 10000);

    frame.addEventListener('load', () => {
      window.clearTimeout(timer);
      frame.dataset.ready = '1';
      resolve();
    }, { once: true });
  });
}

/**
 * 将已解析出的媒体地址交给扩展隐藏页打包，避免大文件经 chrome message 往返
 * @param {Array<Object>} files - 待打包文件列表
 * @returns {Promise<Object>} 打包结果
 */
async function requestZipDownload(files) {
  const frame = getZipperFrame();
  await waitForZipperFrame(frame);

  const requestId = `zip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const zipName = `tiktok_batch_${Date.now()}.zip`;

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      zipDownloadRequests.delete(requestId);
      reject(new Error('批量打包超时，请减少一次选择的视频数量后重试'));
    }, Math.max(90000, files.length * 45000));

    zipDownloadRequests.set(requestId, { resolve, reject, timeoutId });
    frame.contentWindow.postMessage({
      type: ZIP_REQUEST_TYPE,
      requestId,
      zipName,
      files
    }, '*');
  });
}

/**
 * 触发 blob 文件下载
 * @param {Blob} blob - 需要下载的二进制文件
 * @param {string} filename - 下载文件名
 */
function downloadBlobFile(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 60000);
}

/**
 * 扫描当前页面上的所有视频卡片并在视频封面覆盖渲染数据标签
 */
function scanCards() {
  const videoLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
  const newScanned = [];
  const seenVideoIds = new Set();

  videoLinks.forEach((link) => {
    let cardEl = link.closest('[data-e2e*="item"]') ||
                 link.closest('[class*="DivItem"]') ||
                 link.closest('[class*="ItemContainer"]');

    if (!cardEl) {
      let parent = link.parentElement;
      for (let i = 0; i < 3; i++) {
        if (parent && (parent.tagName === 'DIV' || parent.tagName === 'LI')) cardEl = parent;
        parent = parent ? parent.parentElement : null;
      }
    }

    if (!cardEl || newScanned.some(item => item.element === cardEl)) return;
    if (!isValidVideoCard(cardEl, link)) return;

    const videoId = getVideoIdFromLink(link);
    if (!videoId || seenVideoIds.has(videoId)) return;

    const viewsEl = cardEl.querySelector('[data-e2e="video-views"]') ||
                    cardEl.querySelector('[class*="StrongVideoCount"]') ||
                    cardEl.querySelector('[class*="video-count"]') ||
                    cardEl.querySelector('strong');
    let views = viewsEl ? parseViewCount(viewsEl.textContent) : 0;

    let createTime = null, likes = 0, comments = 0, shares = 0;
    if (videoId && apiVideos[videoId]) {
      createTime = apiVideos[videoId].createTime;
      likes = apiVideos[videoId].likes;
      comments = apiVideos[videoId].comments;
      shares = apiVideos[videoId].shares;
      if (views === 0) views = apiVideos[videoId].views;
    }

    repairBrokenVideoThumbnail(cardEl, link);
    renderInfoOverlay(cardEl, link, videoId, createTime, views, likes, comments, shares);

    const titleEl = cardEl.querySelector('img[alt]');
    const title = titleEl ? titleEl.alt : '';

    newScanned.push({
      element: cardEl,
      parentElement: cardEl.parentElement,
      videoId: videoId,
      url: link.href,
      title: title,
      views: views,
      originalIndex: newScanned.length
    });
    seenVideoIds.add(videoId);
  });

  scannedCards = newScanned;
  updateToolbarCount();
  return scannedCards;
}

function getScannedCardByVideoId(videoId) {
  if (!videoId) return null;
  return scannedCards.find(item => item && item.videoId === videoId) || null;
}

/**
 * 在卡片封面上创建或更新精美的运营数据标签与左上角直接下载按钮
 * @param {HTMLElement} cardEl - 视频卡片节点
 * @param {HTMLAnchorElement} link - 视频详情链接
 * @param {string} videoId - 视频的唯一标识符 ID
 * @param {number|null} createTime - 创建时间戳
 * @param {number} views - 播放数
 * @param {number} likes - 点赞数
 * @param {number} comments - 评论数
 * @param {number} shares - 分享数
 */
function renderInfoOverlay(cardEl, link, videoId, createTime, views, likes, comments, shares) {
  // 清理可能遗留的旧版大面板
  const oldOverlay = cardEl.querySelector('.helper-card-overlay');
  if (oldOverlay) oldOverlay.remove();

  // 创建或获取专属气泡容器，并确保它只覆盖视频封面区域
  const overlayHost = resolveVideoOverlayHost(cardEl, link);
  const existingContainers = Array.from(cardEl.querySelectorAll('.helper-bubbles-container'));
  let container = existingContainers.find((item) => item.parentElement === overlayHost) || existingContainers[0];
  if (!container) {
    container = document.createElement('div');
    container.className = 'helper-bubbles-container';
  }
  existingContainers.filter((item) => item !== container).forEach((item) => item.remove());

  if (window.getComputedStyle(overlayHost).position === 'static') {
    overlayHost.style.position = 'relative';
  }
  if (container.parentElement !== overlayHost) {
    overlayHost.appendChild(container);
  }

  // 格式化输出文本
  const likesStr = likes > 0 ? formatViewsCount(likes) : '0';
  const commentsStr = comments > 0 ? formatViewsCount(comments) : '0';
  const sharesStr = shares > 0 ? formatViewsCount(shares) : '0';
  const viewsStr = views > 0 ? formatViewsCount(views) : '0';

  if (!createTime) {
    // 数据未就绪时，仅在右上角静静渲染一个紧凑的正在读取气泡，绝不挡封面
    container.innerHTML = `
      <div class="helper-bubble helper-bubble-rate helper-reading-pulse">
        📅 正在读取...
      </div>
    `;
    return;
  }

  // 数据已就绪，计算多维指标并散落式排布，保留最大通透感
  const totalEngage = likes + comments + shares;
  const rateStr = views > 0 ? (totalEngage / views * 100).toFixed(2) + '%' : '0.00%';

  // 获取视频时长显示并拼装到发布日期右侧
  let durationStr = '';
  if (videoId && apiVideos[videoId] && apiVideos[videoId].duration) {
    durationStr = ` · ⏳ ${formatDuration(apiVideos[videoId].duration)}`;
  }

  // 列表页卡片左上角直接下载按钮（玫红动效，高透毛玻璃）
  const downloadBtnHtml = videoId ? `
    <div class="helper-card-direct-download" data-video-id="${videoId}" title="直接下载视频，无需跳转" style="position: absolute; left: 8px; top: 8px; z-index: 150; width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.16); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer !important; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); transition: all 0.2s ease; pointer-events: auto !important;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
    </div>
    <div class="helper-card-preview-video" data-video-id="${videoId}" title="直接播放解析到的视频" style="position: absolute; left: 40px; top: 8px; z-index: 150; width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(37, 244, 238, 0.18); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; color: #fff; cursor: pointer !important; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); transition: all 0.2s ease; pointer-events: auto !important;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l11-7z"></path>
      </svg>
    </div>
  ` : '';
  const selectBtnHtml = videoId ? `
    <label class="helper-select-toggle ${selectionMode ? 'is-visible' : ''} ${isVideoSelected(videoId) ? 'is-selected' : ''}" data-select-video-id="${videoId}" title="${selectionMode ? '选择此视频' : '进入选择模式后可多选'}">
      <input type="checkbox" ${isVideoSelected(videoId) ? 'checked' : ''}>
    </label>
  ` : '';

  container.innerHTML = `
    <!-- 左上角：列表一键直接下载按钮 -->
    ${downloadBtnHtml}
    ${selectBtnHtml}

    <!-- 右上角：互动率（抖音经典红透） -->
    <div class="helper-bubble helper-bubble-rate">${rateStr}</div>

    <!-- 左上角第二行：视频浏览量/播放量 -->
    <div class="helper-bubble helper-bubble-views">▶ ${viewsStr}</div>

    <!-- 左侧第三行：是否挂车标记 -->
    ${renderCommerceBadge(videoId)}

    <!-- 右侧第三格（从下往上）：点赞数 -->
    <div class="helper-bubble helper-bubble-likes">❤️ ${likesStr}</div>

    <!-- 右侧第二格（从下往上）：评论与分享 -->
    <div class="helper-bubble helper-bubble-comments" style="gap:5px;">
      💬 ${commentsStr} <span style="opacity:0.4;">·</span> 🔗 ${sharesStr}
    </div>

    <!-- 右下角：发布日期与时长 -->
    <div class="helper-bubble helper-bubble-date">📅 ${formatTimestamp(createTime)}${durationStr}</div>
  `;

  // 精准绑定列表页卡片的下载按钮点击事件，强力阻断冒泡，防止主页卡片触发页面跳转
  const btn = container.querySelector('.helper-card-direct-download');
  if (btn) {
    // 捕获阶段拦截所有可能触发跳转或默认行为的交互事件，彻底阻断冒泡
    const stopEvents = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
    stopEvents.forEach(evt => {
      btn.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const titleEl = cardEl.querySelector('img[alt]');
      const title = titleEl ? titleEl.alt : '';
      handleVideoDownloadDirect(videoId, title);
    }, true);
  }

  const previewBtn = container.querySelector('.helper-card-preview-video');
  if (previewBtn) {
    const stopEvents = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
    stopEvents.forEach(evt => {
      previewBtn.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);
    });

    previewBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const titleEl = cardEl.querySelector('img[alt]');
      const title = titleEl ? titleEl.alt : '';
      handleVideoPreview(videoId, title);
    }, true);
  }

  const selectBtn = container.querySelector('.helper-select-toggle');
  if (selectBtn) {
    selectBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectionMode) {
        toggleSelectionMode(true);
      }
      toggleVideoSelection(videoId);
    }, true);
  }
}

/**
 * 格式化播放量数字为简洁文本
 * @param {number} num - 播放量数值
 * @returns {string} 格式化后的字符
 */
function formatViewsCount(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

/**
 * 执行视频卡片的 DOM 排序
 * @param {string} direction - 排序方向，'desc' (降序), 'asc' (升序), 'reset' (还原)
 */
function sortCards(direction) {
  if (scannedCards.length === 0) scanCards();
  if (scannedCards.length === 0) return;

  const sorted = [...scannedCards];
  if (direction === 'desc') {
    sorted.sort((a, b) => b.views - a.views);
  } else if (direction === 'asc') {
    sorted.sort((a, b) => a.views - b.views);
  } else if (direction === 'reset') {
    sorted.sort((a, b) => a.originalIndex - b.originalIndex);
  }

  sorted.forEach(item => {
    if (item.parentElement && item.element) {
      item.parentElement.appendChild(item.element);
    }
  });
}

/**
 * 创建页面顶部水平工具栏的 DOM 结构与样式
 * @returns {HTMLElement} 工具栏元素
 */
function createToolbarDOM() {
  const bar = document.createElement('div');
  bar.id = TOOLBAR_ID;
  const logoUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('assets/talent-data-logo.png')
    : '';

  bar.innerHTML = `
    <div class="toolbar-compact-head">
      <button class="toolbar-drag-handle" type="button" title="拖动并吸附到浏览器边缘" aria-label="拖动达人数据助手">
        <img class="toolbar-logo-image" src="${logoUrl}" alt="">
      </button>
      <button class="toolbar-panel-toggle" type="button" title="展开/收起达人数据助手">
        <span class="toolbar-title">达人助手</span>
        <span class="toolbar-count-label" title="已识别视频">
          <span class="toolbar-count-context">视频</span>
          <span class="toolbar-card-count">0</span>
        </span>
      </button>
      <div class="toolbar-head-actions">
        <button class="toolbar-hide-btn" type="button" title="隐藏到浏览器边缘" aria-label="隐藏到浏览器边缘">×</button>
        <button class="toolbar-panel-close" type="button" title="展开/收起面板" aria-label="展开或收起面板">−</button>
      </div>
    </div>
    <div class="toolbar-panel-body">
      <div class="toolbar-date-group" title="选择后会同时作用于下载区间视频和导出 Excel">
        <button class="toolbar-date-chip toolbar-date-start-chip" type="button">
          <span class="toolbar-date-label toolbar-date-start-label">开始日期</span>
          <span class="toolbar-date-icon">DATE</span>
        </button>
        <span class="toolbar-date-separator">至</span>
        <button class="toolbar-date-chip toolbar-date-end-chip" type="button">
          <span class="toolbar-date-label toolbar-date-end-label">结束日期</span>
          <span class="toolbar-date-icon">DATE</span>
        </button>
        <button class="toolbar-date-clear" type="button" title="清空日期筛选">×</button>
      </div>
      <div class="toolbar-selection-actions">
        <button class="toolbar-action-btn toolbar-btn-select-mode" type="button">选择视频</button>
        <button class="toolbar-action-btn is-primary toolbar-btn-download-selected" type="button">下载选中视频</button>
        <button class="toolbar-action-btn is-primary toolbar-btn-export-selected" type="button">导出选中</button>
        <span class="toolbar-selection-badge">已选 0</span>
      </div>
      <div class="toolbar-utility-row">
        <button class="toolbar-action-btn toolbar-btn-download-range" type="button">下载区间视频</button>
        <button class="toolbar-action-btn toolbar-btn-select-mode toolbar-btn-select-entry" type="button">选择视频</button>
        <select class="toolbar-sort-select">
          <option value="reset">默认排序</option>
          <option value="desc">播放量降序 (从高到低)</option>
          <option value="asc">播放量升序 (从低到高)</option>
        </select>
        <button class="toolbar-action-btn toolbar-btn-scroll" type="button">自动滚动</button>
        <label class="toolbar-export-option" title="开启后导出会补全商品名称、价格、店铺、链接等字段；关闭时导出更快">
          <input class="toolbar-export-products-toggle" type="checkbox">
          <span class="toolbar-export-option-text">导出商品</span>
        </label>
        <button class="toolbar-action-btn is-primary toolbar-btn-export" type="button">导出 Excel</button>
      </div>
      <div class="toolbar-export-progress" aria-live="polite">
        <div class="toolbar-export-progress-head">
          <span class="toolbar-export-progress-title">准备导出</span>
          <span class="toolbar-export-progress-value">0%</span>
        </div>
        <div class="toolbar-export-progress-track">
          <div class="toolbar-export-progress-bar"></div>
        </div>
        <div class="toolbar-export-progress-detail">等待开始</div>
      </div>
    </div>
    <button class="toolbar-edge-tab" type="button" title="显示达人数据助手" aria-label="显示达人数据助手">
      <img class="toolbar-edge-logo" src="${logoUrl}" alt="">
      <span class="toolbar-edge-arrow" aria-hidden="true"></span>
    </button>
  `;
  return bar;
}

function normalizePopupTheme(theme) {
  return AVAILABLE_POPUP_THEMES.includes(theme) ? theme : DEFAULT_POPUP_THEME;
}

function applyToolbarTheme(theme) {
  const safeTheme = normalizePopupTheme(theme);
  if (toolbarElement) toolbarElement.dataset.theme = safeTheme;
  if (calendarPopoverElement) calendarPopoverElement.dataset.theme = safeTheme;
}

function loadToolbarTheme() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    applyToolbarTheme(DEFAULT_POPUP_THEME);
    return;
  }

  try {
    chrome.storage.local.get([POPUP_THEME_STORAGE_KEY], (data = {}) => {
      applyToolbarTheme(data[POPUP_THEME_STORAGE_KEY] || DEFAULT_POPUP_THEME);
    });
  } catch (error) {
    applyToolbarTheme(DEFAULT_POPUP_THEME);
  }
}

function bindToolbarThemeSync() {
  if (toolbarThemeListenerBound || typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return;
  toolbarThemeListenerBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[POPUP_THEME_STORAGE_KEY]) return;
    applyToolbarTheme(changes[POPUP_THEME_STORAGE_KEY].newValue);
  });
}

function normalizeToolbarLayout(value) {
  const safeValue = value && typeof value === 'object' ? value : {};
  const ratio = Number(safeValue.centerRatio);
  return {
    side: safeValue.side === 'left' ? 'left' : 'right',
    centerRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : null,
    hidden: Boolean(safeValue.hidden),
    collapsed: safeValue.collapsed !== false
  };
}

function loadToolbarLayout() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    applyToolbarPosition();
    return;
  }

  try {
    chrome.storage.local.get([TOOLBAR_LAYOUT_STORAGE_KEY], (data = {}) => {
      toolbarLayout = normalizeToolbarLayout(data[TOOLBAR_LAYOUT_STORAGE_KEY]);
      setToolbarCollapsed(toolbarLayout.collapsed, false);
      applyToolbarPosition();
    });
  } catch (error) {
    console.warn('[达人数据助手][content] 读取悬浮位置失败:', error);
    applyToolbarPosition();
  }
}

function persistToolbarLayout() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
  try {
    chrome.storage.local.set({
      [TOOLBAR_LAYOUT_STORAGE_KEY]: {
        side: toolbarLayout.side,
        centerRatio: toolbarLayout.centerRatio,
        hidden: toolbarLayout.hidden,
        collapsed: toolbarLayout.collapsed
      }
    });
  } catch (error) {
    console.warn('[达人数据助手][content] 保存悬浮位置失败:', error);
  }
}

function getToolbarCenterRatio() {
  if (!toolbarElement || window.innerHeight <= 0) return null;
  const rect = toolbarElement.getBoundingClientRect();
  return Math.min(1, Math.max(0, (rect.top + rect.height / 2) / window.innerHeight));
}

function syncToolbarDimensions() {
  if (!toolbarElement) return;
  if (toolbarLayout.hidden) {
    toolbarElement.style.width = '42px';
    toolbarElement.style.height = '58px';
    toolbarElement.style.padding = '0';
    toolbarElement.style.borderRadius = '999px';
    return;
  }

  toolbarElement.style.height = 'auto';
  toolbarElement.style.width = toolbarLayout.collapsed ? 'auto' : 'min(420px, calc(100vw - 20px))';
  toolbarElement.style.padding = toolbarLayout.collapsed ? '6px' : '10px';
  toolbarElement.style.borderRadius = toolbarLayout.collapsed ? '999px' : '18px';
}

/**
 * 根据边缘和垂直比例计算像素位置，确保视口变化后工具栏仍完整可见。
 */
function applyToolbarPosition() {
  if (!toolbarElement) return;
  toolbarElement.classList.toggle('is-hidden', toolbarLayout.hidden);
  toolbarElement.dataset.side = toolbarLayout.side;
  syncToolbarDimensions();

  const edgeGap = toolbarLayout.hidden ? 0 : TOOLBAR_EDGE_GAP;
  if (toolbarLayout.side === 'left') {
    toolbarElement.style.left = `${edgeGap}px`;
    toolbarElement.style.right = 'auto';
  } else {
    toolbarElement.style.left = 'auto';
    toolbarElement.style.right = `${edgeGap}px`;
  }

  if (Number.isFinite(toolbarLayout.centerRatio)) {
    const rect = toolbarElement.getBoundingClientRect();
    const maxTop = Math.max(edgeGap, window.innerHeight - rect.height - edgeGap);
    const desiredTop = toolbarLayout.centerRatio * window.innerHeight - rect.height / 2;
    toolbarElement.style.top = `${Math.min(maxTop, Math.max(edgeGap, desiredTop))}px`;
    toolbarElement.style.bottom = 'auto';
  } else {
    toolbarElement.style.top = 'auto';
    toolbarElement.style.bottom = toolbarLayout.hidden ? '24px' : '18px';
  }
}

function setToolbarHidden(hidden) {
  if (!toolbarElement || toolbarLayout.hidden === hidden) return;
  toolbarLayout.centerRatio = getToolbarCenterRatio();
  toolbarLayout.hidden = hidden;
  if (hidden) closeCalendarPopover();
  applyToolbarPosition();
  persistToolbarLayout();
}

/**
 * 只允许从独立拖动柄移动，避免展开、隐藏及业务按钮被误触。
 */
function bindToolbarDragging() {
  const handle = toolbarElement?.querySelector('.toolbar-drag-handle');
  if (!handle) return;

  const finishDrag = (event) => {
    if (!toolbarDragState || event.pointerId !== toolbarDragState.pointerId) return;
    const rect = toolbarElement.getBoundingClientRect();
    toolbarLayout.side = rect.left + rect.width / 2 <= window.innerWidth / 2 ? 'left' : 'right';
    toolbarLayout.centerRatio = getToolbarCenterRatio();
    toolbarElement.classList.remove('is-dragging');
    toolbarDragState = null;
    document.removeEventListener('pointermove', moveToolbar);
    document.removeEventListener('pointerup', finishDrag);
    document.removeEventListener('pointercancel', finishDrag);
    applyToolbarPosition();
    persistToolbarLayout();
  };

  const moveToolbar = (event) => {
    if (!toolbarDragState || event.pointerId !== toolbarDragState.pointerId) return;
    event.preventDefault();
    const nextLeft = toolbarDragState.startLeft + event.clientX - toolbarDragState.startX;
    const nextTop = toolbarDragState.startTop + event.clientY - toolbarDragState.startY;
    const maxLeft = Math.max(TOOLBAR_EDGE_GAP, window.innerWidth - toolbarDragState.width - TOOLBAR_EDGE_GAP);
    const maxTop = Math.max(TOOLBAR_EDGE_GAP, window.innerHeight - toolbarDragState.height - TOOLBAR_EDGE_GAP);
    toolbarElement.style.left = `${Math.min(maxLeft, Math.max(TOOLBAR_EDGE_GAP, nextLeft))}px`;
    toolbarElement.style.right = 'auto';
    toolbarElement.style.top = `${Math.min(maxTop, Math.max(TOOLBAR_EDGE_GAP, nextTop))}px`;
    toolbarElement.style.bottom = 'auto';
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || toolbarLayout.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = toolbarElement.getBoundingClientRect();
    toolbarDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height
    };
    toolbarElement.classList.add('is-dragging');
    document.addEventListener('pointermove', moveToolbar, { passive: false });
    document.addEventListener('pointerup', finishDrag);
    document.addEventListener('pointercancel', finishDrag);
  });
}

function bindToolbarResize() {
  if (toolbarResizeListenerBound) return;
  toolbarResizeListenerBound = true;
  window.addEventListener('resize', () => applyToolbarPosition());
}

/**
 * 初始化并注入页面顶部水平工具栏
 */
function initToolbar() {
  document.getElementById(TOOLBAR_ID)?.remove();
  document.getElementById(TOOLBAR_CALENDAR_ID)?.remove();
  toolbarElement = null;
  calendarPopoverElement = null;

  toolbarElement = createToolbarDOM();
  applyToolbarTheme(DEFAULT_POPUP_THEME);
  document.body.appendChild(toolbarElement);
  loadToolbarTheme();
  bindToolbarThemeSync();
  if (document.body.style.paddingTop === '50px') {
    document.body.style.paddingTop = '';
  }
  setToolbarCollapsed(true, false);
  applyToolbarPosition();
  loadToolbarLayout();
  bindToolbarDragging();
  bindToolbarResize();

  toolbarElement.querySelector('.toolbar-panel-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleToolbarPanel();
  });

  toolbarElement.querySelector('.toolbar-panel-close').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleToolbarPanel();
  });

  toolbarElement.querySelector('.toolbar-hide-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setToolbarHidden(true);
  });

  toolbarElement.querySelector('.toolbar-edge-tab').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setToolbarHidden(false);
  });

  toolbarElement.querySelector('.toolbar-sort-select').addEventListener('change', (e) => {
    e.stopPropagation();
    sortCards(e.target.value);
  });

  toolbarElement.querySelector('.toolbar-btn-scroll').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAutoScroll(e.target);
  });

  toolbarElement.querySelectorAll('.toolbar-btn-export, .toolbar-btn-export-selected').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await exportToCSV();
  }));

  toolbarElement.querySelector('.toolbar-btn-download-range').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadVideosInRange();
  });

  toolbarElement.querySelectorAll('.toolbar-btn-select-mode').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelectionMode();
  }));

  toolbarElement.querySelector('.toolbar-btn-download-selected').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadSelectedVideos();
  });

  bindDateRangePicker();
  bindExportProductOption();
  updateSelectionCount();
  updateSelectionToolbarState();
}

function bindExportProductOption() {
  const toggle = toolbarElement?.querySelector('.toolbar-export-products-toggle');
  if (!toggle) return;

  toggle.checked = Boolean(exportProductInfoEnabled);
  toggle.addEventListener('click', (e) => e.stopPropagation());
  toggle.addEventListener('change', (e) => {
    exportProductInfoEnabled = Boolean(e.target.checked);
    persistExportProductOption();
    showToast(exportProductInfoEnabled ? '导出时会补全挂车商品信息' : '已关闭商品明细导出，导出会更快');
  });
  loadExportProductOption();
}

function loadExportProductOption() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    updateExportProductToggle();
    return;
  }

  try {
    chrome.storage.local.get([EXPORT_PRODUCT_INFO_STORAGE_KEY], (data = {}) => {
      exportProductInfoEnabled = Boolean(data[EXPORT_PRODUCT_INFO_STORAGE_KEY]);
      updateExportProductToggle();
    });
  } catch (error) {
    updateExportProductToggle();
  }
}

function persistExportProductOption() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
  try {
    chrome.storage.local.set({ [EXPORT_PRODUCT_INFO_STORAGE_KEY]: Boolean(exportProductInfoEnabled) });
  } catch (error) {
    console.warn('[达人数据助手][content] 保存导出商品开关失败:', error);
  }
}

function updateExportProductToggle() {
  const toggle = toolbarElement?.querySelector('.toolbar-export-products-toggle');
  if (toggle) toggle.checked = Boolean(exportProductInfoEnabled);
}

function toggleToolbarPanel() {
  if (!toolbarElement) return;
  setToolbarCollapsed(!toolbarElement.classList.contains('is-collapsed'));
}

function setToolbarCollapsed(collapsed, persist = true) {
  if (!toolbarElement) return;
  if (persist) toolbarLayout.centerRatio = getToolbarCenterRatio();
  toolbarLayout.collapsed = collapsed;
  toolbarElement.classList.toggle('is-collapsed', collapsed);
  const body = toolbarElement.querySelector('.toolbar-panel-body');
  const closeBtn = toolbarElement.querySelector('.toolbar-panel-close');
  if (body) body.style.display = collapsed ? 'none' : 'flex';
  if (closeBtn) closeBtn.textContent = collapsed ? '+' : '−';
  syncToolbarDimensions();
  window.requestAnimationFrame(() => applyToolbarPosition());
  if (persist) persistToolbarLayout();
}

/**
 * 触发指定日期区间内视频的批量下载逻辑
 */
async function downloadVideosInRange() {
  try {
    if (!hasDateRangeFilter()) {
      showToast('请先选择起始与结束日期！');
      return;
    }

    const targets = getDateFilteredCards(scannedCards)
      .filter(item => item.videoId && apiVideos[item.videoId])
      .map((item) => {
        const vId = item.videoId;
        const info = apiVideos[vId];
        const title = item.element.querySelector('img[alt]')?.alt || item.title || `video_${vId}`;
        return { vId, playUrl: info.playUrl || '', title, detailUrl: item.url || '' };
      });

    if (targets.length === 0) {
      showToast('未在选择的日期区间内找到可下载的视频！');
      return;
    }

    showToast(`已成功匹配 ${targets.length} 个视频，开始打包下载...`);
    await triggerQueueDownloads(targets);
  } catch (error) {
    console.error('[达人数据助手] 批量下载触发失败:', error);
    showToast(`批量下载失败：${error.message}`);
  }
}

/**
 * 遍历视频目标队列，先解析真实媒体地址，再交给扩展打包页生成 zip
 * @param {Array} targets - 待下载的视频目标列表
 */
async function triggerQueueDownloads(targets) {
  if (!targets.length) {
    showToast('没有可打包的视频');
    return;
  }

  const files = [];
  const failed = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const filename = buildVideoFilename(t.title, t.vId);
    showToast(`正在解析第 ${i + 1}/${targets.length} 个视频...`);

    try {
      const resolved = await requestPageContextDownload({
        videoId: t.vId,
        filename,
        preferredUrl: t.playUrl,
        detailUrl: t.detailUrl || '',
        mode: 'resolveUrl'
      });

      if (!resolved || !resolved.mediaUrl) {
        throw new Error('未解析到真实视频地址');
      }

      files.push({
        url: resolved.mediaUrl,
        filename,
        videoId: t.vId
      });
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (error) {
      try {
        showToast(`主线路失败，正在用外部解析补第 ${i + 1}/${targets.length} 个视频...`);
        const external = await enrichVideoWithExternalDetail(t.vId, t.detailUrl || '', apiVideos[t.vId] || {});
        if (!external.mediaUrl) {
          throw new Error('外部解析也没有返回视频地址');
        }
        files.push({
          url: external.mediaUrl,
          filename,
          videoId: t.vId
        });
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch (fallbackError) {
        failed.push(`${t.vId}: ${fallbackError.message || error.message}`);
      }
    }
  }

  const successCount = files.length;
  if (successCount === 0) {
    showToast('批量打包失败，没有成功解析到视频文件');
    return;
  }

  showToast(`正在拉取并生成压缩包，共 ${successCount} 个视频...`);
  const result = await requestZipDownload(files);

  if (failed.length > 0) {
    console.warn('[达人数据助手] 以下视频打包失败：', failed);
    showToast(`压缩包已生成，成功 ${successCount} 个，解析失败 ${failed.length} 个`);
  } else {
    showToast(`压缩包已生成：${result.filename || `${successCount} 个视频`}`);
  }
}

/**
 * 下载当前已选中的视频
 */
async function downloadSelectedVideos() {
  if (!selectedVideoIds.size) {
    showToast('请先选择要下载的视频');
    return;
  }

  const targets = scannedCards
    .filter(item => selectedVideoIds.has(item.videoId))
    .map((item) => ({
      vId: item.videoId,
      playUrl: (apiVideos[item.videoId] && apiVideos[item.videoId].playUrl) || '',
      title: item.title || `video_${item.videoId}`,
      detailUrl: item.url || ''
    }));

  if (!targets.length) {
    showToast('当前选中的视频暂时无法下载');
    return;
  }

  showToast(`已选择 ${targets.length} 个视频，开始打包下载...`);
  await triggerQueueDownloads(targets);
}

/**
 * 更新工具栏视频计数
 */
function updateToolbarCount() {
  if (toolbarElement) {
    const countSpan = toolbarElement.querySelector('.toolbar-card-count');
    if (countSpan) countSpan.textContent = scannedCards.length;
  }

  const visibleIds = new Set(scannedCards.map(item => item.videoId).filter(Boolean));
  Array.from(selectedVideoIds).forEach((videoId) => {
    if (!visibleIds.has(videoId)) {
      selectedVideoIds.delete(videoId);
    }
  });

  updateSelectionCount();
  updateSelectionToolbarState();
}

/**
 * 控制自动滚动逻辑
 * @param {HTMLElement} btn - 点击的滚动控制按钮
 */
function toggleAutoScroll(btn) {
  if (scrollInterval) {
    stopAutoScroll(btn, '已停止自动滚动');
  } else {
    const dateGuardText = hasDateRangeFilter() ? `，会在早于 ${rangeStartDate} 的视频处停止` : '';
    let scrollTicks = 0;
    let unchangedTicks = 0;
    let lastScrollY = Math.round(window.scrollY || window.pageYOffset || 0);
    showToast(`已开启自动滚动${dateGuardText}`);
    btn.textContent = '停止滚动';
    btn.classList.add('is-running');
    scrollInterval = setInterval(() => {
      window.scrollBy({ top: 800, behavior: 'smooth' });
      scrollTicks += 1;
      window.setTimeout(() => {
        if (!scrollInterval) return;
        const currentScrollY = Math.round(window.scrollY || window.pageYOffset || 0);
        unchangedTicks = Math.abs(currentScrollY - lastScrollY) < 24 ? unchangedTicks + 1 : 0;
        lastScrollY = currentScrollY;
        scanCards();
        if (scrollTicks >= 2 && shouldStopAutoScrollForDateRange()) {
          stopAutoScroll(btn, `已滚动到 ${rangeStartDate} 附近，自动停止`);
          return;
        }
        if (unchangedTicks >= 4) {
          stopAutoScroll(btn, '页面没有继续加载，自动停止滚动');
        }
      }, 650);
    }, 1800);
  }
}

function stopAutoScroll(btn, message) {
  if (scrollInterval) {
    clearInterval(scrollInterval);
    scrollInterval = null;
  }
  const scrollBtn = btn || toolbarElement?.querySelector('.toolbar-btn-scroll');
  if (scrollBtn) {
    scrollBtn.textContent = '自动滚动';
    scrollBtn.classList.remove('is-running');
  }
  if (message) showToast(message);
}

/**
 * 导出页面已被解析的视频数据为 Excel 兼容的 CSV 文件
 */
async function exportToCSV() {
  if (isExporting) {
    showToast('正在导出中，请稍候...');
    return;
  }

  if (scannedCards.length === 0) {
    showToast('当前无可导出的视频数据！');
    return;
  }

  const exportContext = getExportContext();
  const exportCards = exportContext.cards;
  lastExportSelectionMode = exportContext.mode === 'selected';
  if (exportCards.length === 0) {
    showToast(getEmptyExportMessage(exportContext));
    return;
  }

  isExporting = true;
  let progressHideDelay = 3000;
  updateExportButtonState(true);
  updateExportProgress({
    title: '准备导出',
    detail: getExportStartMessage(exportContext, exportProductInfoEnabled),
    current: 1,
    total: 100
  });
  try {
    console.info('[达人数据助手][content] 本次导出范围:', {
      mode: exportContext.mode,
      selectedCount: exportContext.selectedIds.length,
      exportCount: exportCards.length,
      selectedIds: exportContext.selectedIds,
      exportIds: exportCards.map(item => item.videoId)
    });
    showToast(getExportStartMessage(exportContext, exportProductInfoEnabled));
    if (exportProductInfoEnabled) {
      updateExportProgress({
        title: '补全商品信息',
        detail: '正在检查需要补全的挂车商品...',
        current: 8,
        total: 100
      });
      const enrichTimeoutMs = getProductEnrichTimeoutMs(exportCards);
      await withTimeout(
        enrichProductsForExport(exportCards, (progress) => {
          const total = Math.max(progress.total || 1, 1);
          const current = Math.min(progress.current || 0, total);
          const percent = progress.total ? 10 + Math.round((current / total) * 58) : 66;
          updateExportProgress({
            title: progress.title || '补全商品信息',
            detail: progress.detail || `${current}/${total}`,
            percent
          });
        }),
        enrichTimeoutMs,
        '商品信息补全超时，已先导出当前已解析数据'
      ).catch((error) => {
        console.warn('[达人数据助手][content] 导出前商品补全未完成，继续导出当前数据:', error);
        showToast(error.message || '商品补全超时，已先导出当前数据');
        updateExportProgress({
          title: '继续生成表格',
          detail: error.message || '商品补全未完成，先导出当前数据',
          percent: 68
        });
      });
    } else {
      updateExportProgress({
        title: '快速导出',
        detail: '已跳过商品明细解析，只导出视频基础数据',
        percent: 64
      });
    }

    updateExportProgress({
      title: '生成表格',
      detail: `正在写入 ${exportCards.length} 行数据...`,
      percent: 72
    });
    const baseHeaders = [
      '视频标题',
      '播放量',
      '点赞数',
      '评论数',
      '分享数',
      '互动率',
      '视频时长',
      '发布日期',
      '是否挂车'
    ];
    const productHeaders = [
      '商品数量',
      '商品名称',
      '商品价格',
      '商品原价',
      '商品店铺',
      '商品评分',
      '商品评论数',
      '商品销量',
      '商品图片',
      '商品链接',
      '商品ID',
      '商品解析链路'
    ];
    const tailHeaders = [
      '视频话题',
      '视频链接'
    ];
    const headers = exportProductInfoEnabled
      ? baseHeaders.concat(productHeaders, tailHeaders)
      : baseHeaders.concat(tailHeaders);
    let csvContent = '\ufeff';
    csvContent += headers.map(csvCell).join(',') + '\n';

    exportCards.forEach(item => {
      const url = item.url || '';
      const vId = item.videoId;

      let title = item.title || '';

      let dateStr = '未知', likes = 0, comments = 0, shares = 0, rate = '0%', durStr = '00:00', commerceLabel = '未知', hashtags = '';
      let products = [];
      let productSourceText = '';
      if (vId && apiVideos[vId]) {
        const info = apiVideos[vId];
        dateStr = formatTimestamp(info.createTime);
        likes = info.likes;
        comments = info.comments;
        shares = info.shares;
        rate = item.views > 0 ? ((likes + comments + shares) / item.views * 100).toFixed(1) + '%' : '0%';
        durStr = formatDuration(info.duration);
        commerceLabel = getVideoCommerceStatus(vId).label;

        // 优先使用 API 中完整准确的视频描述作为标题，并单独提取出 Hashtags 话题列表
        if (info.desc) {
          title = info.desc;
          hashtags = extractHashtags(info.desc);
        }
        products = Array.isArray(info.products) ? info.products.filter(product => product && product.name) : [];
        const commerceMeta = normalizeCommerceMeta(info.commerceMeta, products);
        productSourceText = commerceMeta.sourceStatuses.join(' / ');
      }

      const baseRow = [
        title,
        item.views,
        likes,
        comments,
        shares,
        rate,
        durStr,
        dateStr,
        commerceLabel
      ];
      const productSummary = exportProductInfoEnabled ? buildExportProductSummary(products) : null;
      const productRow = exportProductInfoEnabled
        ? [
            products.length,
            productSummary.names,
            productSummary.prices,
            productSummary.originalPrices,
            productSummary.shopNames,
            productSummary.ratings,
            productSummary.reviewCounts,
            productSummary.soldCounts,
            productSummary.images,
            productSummary.urls,
            productSummary.ids,
            productSourceText
          ]
        : [];
      const tailRow = [
        hashtags,
        url
      ];

      csvContent += baseRow.concat(productRow, tailRow).map(csvCell).join(',') + '\n';
    });

    updateExportProgress({
      title: '生成下载文件',
      detail: '正在转换 CSV 文件...',
      percent: 88
    });
    const downloadUrl = await csvContentToDataUrl(csvContent);
    updateExportProgress({
      title: '触发下载',
      detail: '正在调用浏览器下载...',
      percent: 94
    });
    const res = await downloadExportDataUrl(downloadUrl, buildExportFilename(exportContext));
    if (res && res.success) {
      updateExportProgress({
        title: '导出完成',
        detail: getExportSuccessSuffix(exportContext).replace(/^，/, ''),
        percent: 100
      });
      showToast(`已成功触发下载${getExportSuccessSuffix(exportContext)}！`);
    } else {
      throw new Error(res && res.error ? res.error : '浏览器下载接口没有返回成功');
    }
  } catch (error) {
    progressHideDelay = 5000;
    console.error('[达人数据助手][content] 导出失败:', error);
    updateExportProgress({
      title: '导出失败',
      detail: error.message || String(error),
      percent: 100
    });
    showToast(`导出失败：${error.message || error}`);
  } finally {
    isExporting = false;
    updateExportButtonState(false);
    hideExportProgress(progressHideDelay);
  }
}

function getExportContext() {
  syncSelectedVideoIdsFromDom();
  const selectedIds = Array.from(selectedVideoIds);
  const shouldExportSelectedOnly = selectionMode || selectedIds.length > 0;
  const baseCards = shouldExportSelectedOnly
    ? selectedIds.map(videoId => getScannedCardByVideoId(videoId)).filter(Boolean)
    : getDateFilteredCards(scannedCards);
  const cards = baseCards.filter(shouldExportCard);
  return {
    mode: shouldExportSelectedOnly ? 'selected' : (hasDateRangeFilter() ? 'date' : 'all'),
    selectedIds,
    cards
  };
}

function syncSelectedVideoIdsFromDom() {
  if (!selectionMode || !document.body) return;
  const checkedIds = Array.from(document.querySelectorAll('.helper-select-toggle input:checked'))
    .map(input => input.closest('.helper-select-toggle')?.getAttribute('data-select-video-id'))
    .filter(Boolean);
  if (!checkedIds.length && selectedVideoIds.size > 0) return;
  selectedVideoIds.clear();
  checkedIds.forEach(videoId => selectedVideoIds.add(videoId));
  updateSelectionCount();
  updateSelectionToolbarState();
}

function getEmptyExportMessage(context) {
  if (context && context.mode === 'selected') {
    return context.selectedIds.length
      ? '选中的视频暂时没有可导出的有效数据，请先滚动等待数据读取完成'
      : '当前是选择模式，请先勾选要导出的视频';
  }
  if (hasDateRangeFilter()) return '该日期区间没有可导出的有效视频数据！';
  return '当前没有可导出的有效视频数据！';
}

function getExportStartMessage(context, includeProducts = exportProductInfoEnabled) {
  const count = context.cards.length;
  const productText = includeProducts ? '，会补全商品信息' : '，快速模式不解析商品明细';
  if (context.mode === 'selected') return `正在导出选中的 ${count} 个视频${productText}...`;
  if (context.mode === 'date') return `正在按日期区间导出 ${count} 个视频${productText}...`;
  return `正在导出 ${count} 个视频${productText}...`;
}

function getExportSuccessSuffix(context) {
  const count = context.cards.length;
  if (context.mode === 'selected') return `，已导出选中的 ${count} 个视频`;
  if (context.mode === 'date') return `，已按 ${rangeStartDate} 至 ${rangeEndDate} 筛选`;
  return `，共 ${count} 个视频`;
}

function updateExportButtonState(exporting) {
  const exportBtn = toolbarElement?.querySelector('.toolbar-btn-export');
  const exportSelectedBtn = toolbarElement?.querySelector('.toolbar-btn-export-selected');
  if (exportBtn) {
    exportBtn.disabled = Boolean(exporting);
    exportBtn.textContent = exporting ? '导出中...' : '导出 Excel';
  }
  if (exportSelectedBtn) {
    exportSelectedBtn.disabled = Boolean(exporting || selectedVideoIds.size === 0);
    exportSelectedBtn.textContent = exporting ? '导出中...' : '导出选中';
  }
}

function updateExportProgress({ title = '准备导出', detail = '', current = 0, total = 1, percent } = {}) {
  if (!toolbarElement) return;
  const progressEl = toolbarElement.querySelector('.toolbar-export-progress');
  if (!progressEl) return;
  if (exportProgressHideTimer) {
    clearTimeout(exportProgressHideTimer);
    exportProgressHideTimer = null;
  }

  const safeTotal = Math.max(Number(total) || 1, 1);
  const safeCurrent = Math.max(0, Math.min(Number(current) || 0, safeTotal));
  const value = Number.isFinite(percent)
    ? Math.max(0, Math.min(percent, 100))
    : Math.round((safeCurrent / safeTotal) * 100);
  progressEl.classList.add('is-visible');
  progressEl.querySelector('.toolbar-export-progress-title').textContent = title;
  progressEl.querySelector('.toolbar-export-progress-value').textContent = `${Math.round(value)}%`;
  progressEl.querySelector('.toolbar-export-progress-bar').style.width = `${value}%`;
  progressEl.querySelector('.toolbar-export-progress-detail').textContent = detail || `${safeCurrent}/${safeTotal}`;
}

function hideExportProgress(delay = 1600) {
  if (!toolbarElement) return;
  const progressEl = toolbarElement.querySelector('.toolbar-export-progress');
  if (!progressEl) return;
  if (exportProgressHideTimer) clearTimeout(exportProgressHideTimer);
  exportProgressHideTimer = setTimeout(() => {
    progressEl.classList.remove('is-visible');
    exportProgressHideTimer = null;
  }, delay);
}

function buildExportFilename(context) {
  const productMode = exportProductInfoEnabled ? 'with_products' : 'fast';
  const mode = context.mode === 'selected'
    ? `selected_${context.cards.length}`
    : (context.mode === 'date' ? `${rangeStartDate || 'start'}_${rangeEndDate || 'end'}` : 'all');
  return sanitizeDownloadFilename(`tiktok_export_${mode}_${productMode}_${Date.now()}.csv`, `tiktok_export_${Date.now()}.csv`);
}

function downloadExportDataUrl(downloadUrl, filename) {
  return withTimeout(sendRuntimeMessage({
    action: "download",
    url: downloadUrl,
    filename: filename || `tiktok_export_${Date.now()}.csv`
  }), EXPORT_DOWNLOAD_TIMEOUT_MS, '导出下载超时，请重载扩展后再试');
}

function csvContentToDataUrl(csvContent) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('CSV 文件生成失败'));
    reader.readAsDataURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }));
  });
}

function getProductEnrichTimeoutMs(cards) {
  const targetCount = getProductEnrichTargets(cards).length;
  if (!targetCount) return EXPORT_PRODUCT_ENRICH_BASE_TIMEOUT_MS;
  const batches = Math.ceil(targetCount / EXPORT_PRODUCT_ENRICH_CONCURRENCY);
  return Math.min(
    EXPORT_PRODUCT_ENRICH_MAX_TIMEOUT_MS,
    Math.max(
      EXPORT_PRODUCT_ENRICH_BASE_TIMEOUT_MS,
      batches * EXPORT_PRODUCT_ENRICH_TARGET_TIMEOUT_MS
    )
  );
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || '操作超时')), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function enrichProductsForExport(cards, onProgress) {
  const targets = getProductEnrichTargets(cards);

  if (!targets.length) {
    if (typeof onProgress === 'function') {
      onProgress({
        title: '商品信息已就绪',
        detail: '无需额外补全商品详情',
        current: 1,
        total: 1
      });
    }
    return;
  }

  showToast(`正在补全 ${targets.length} 个视频的商品信息...`);
  const concurrency = getExportEnrichConcurrency(targets.length);
  let cursor = 0;
  let completed = 0;
  if (typeof onProgress === 'function') {
    onProgress({
      title: '补全商品信息',
      detail: `准备补全 ${targets.length} 个视频商品，${concurrency} 路并行`,
      current: 0,
      total: targets.length
    });
  }

  const worker = async () => {
    while (cursor < targets.length) {
      const targetIndex = cursor;
      cursor += 1;
      const { item, videoId, info } = targets[targetIndex];
      try {
        if (targetIndex === 0 || targetIndex % Math.max(concurrency, 3) === 0) {
          showToast(`正在补全商品 ${completed + 1}/${targets.length}...`);
        }
        if (typeof onProgress === 'function') {
          const running = Math.min(concurrency, targets.length - completed);
          onProgress({
            title: '补全商品信息',
            detail: `正在并行解析 ${running} 个视频商品...`,
            current: completed,
            total: targets.length
          });
        }
        await enrichVideoWithExternalDetail(videoId, item.url || '', info);
        await new Promise(resolve => setTimeout(resolve, 80));
      } catch (error) {
        console.warn('[达人数据助手][content] 导出前补全商品失败:', videoId, error);
        const products = Array.isArray(info.products) ? info.products : [];
        const commerceMeta = normalizeCommerceMeta(
          mergeCommerceMeta(info.commerceMeta, {
            sourceStatuses: [buildSourceStatus('export-product', 'error', error && error.message ? error.message : '')]
          }),
          products
        );
        apiVideos[videoId] = {
          ...info,
          commerceMeta
        };
      } finally {
        completed += 1;
        if (typeof onProgress === 'function') {
          onProgress({
            title: '补全商品信息',
            detail: `已处理 ${completed}/${targets.length} 个视频商品（${concurrency} 路并行）`,
            current: completed,
            total: targets.length
          });
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function getProductEnrichTargets(cards) {
  return (cards || [])
    .map((item) => {
      const videoId = item && item.videoId;
      const info = videoId ? apiVideos[videoId] : null;
      return { item, videoId, info };
    })
    .filter(({ videoId, info }) => videoId && info && shouldEnrichProductsForExport(info));
}

function getExportEnrichConcurrency(targetCount) {
  if (targetCount <= 1) return 1;
  if (targetCount <= 4) return Math.min(2, targetCount);
  return Math.min(EXPORT_PRODUCT_ENRICH_CONCURRENCY, targetCount);
}

function shouldEnrichProductsForExport(info) {
  const products = Array.isArray(info.products) ? info.products.filter(product => product && product.name) : [];
  const meta = normalizeCommerceMeta(info.commerceMeta, products);
  const hasIncompleteProduct = products.some((product) => (
    !product.price || !product.shopName || !product.url || !product.image
  ));
  if (products.length && !hasIncompleteProduct) return false;
  return Boolean(meta.isCommerceVideo || meta.productHints > 0 || meta.anchorTypes.length);
}

function hasUsablePreviewProducts(products) {
  const safeProducts = Array.isArray(products) ? products.filter(product => product && product.name) : [];
  if (!safeProducts.length) return false;
  return safeProducts.some(product => (
    product.price ||
    product.shopName ||
    product.image ||
    product.url ||
    product.rating ||
    product.soldCount ||
    product.reviewCount
  ));
}

function buildExportProductSummary(products) {
  const safeProducts = Array.isArray(products) ? products.filter(product => product && product.name) : [];
  const join = (getter) => safeProducts.map(getter).filter(Boolean).join(' | ');
  return {
    names: join(product => product.name),
    prices: join(product => product.price),
    originalPrices: join(product => product.originalPrice),
    shopNames: join(product => product.shopName),
    ratings: join(product => product.rating),
    reviewCounts: join(product => product.reviewCount),
    soldCounts: join(product => product.soldCount),
    images: join(product => product.image),
    urls: join(product => product.url),
    ids: join(product => product.id)
  };
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/"/g, '""');
  return `"${text}"`;
}

/**
 * 提示小气泡函数
 * @param {string} message - 消息文本
 */
function showToast(message) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; left: 50%; bottom: 50px; transform: translateX(-50%);
    background: rgba(12, 12, 16, 0.9); color: #fff; padding: 10px 20px;
    border-radius: 20px; z-index: 2147483647 !important; font-size: 13px; font-family: system-ui;
    pointer-events: none; opacity: 0; transition: opacity 0.3s;
    box-shadow: 0 4px 15px rgba(0,0,0,0.4);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.style.opacity = '1', 50);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * 监听 DOM 变化以动态扫描，排除了插件自身的修改，杜绝死循环
 */
function watchDOMChanges() {
  const observer = new MutationObserver((mutations) => {
    const isPluginMutation = mutations.every((mutation) => {
      const target = mutation.target;
      return (target && typeof target.closest === 'function') &&
             (target.closest('#tiktok-talent-helper-toolbar') ||
              target.closest('.helper-bubbles-container') ||
              target.closest('.helper-video-preview-backdrop') ||
              target.closest('#tiktok-download-btn-wrapper'));
    });
    if (isPluginMutation) return;

    parsePageJsonData();
    scanCards();
    cleanupLegacyDownloadButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function cleanupLegacyDownloadButton() {
  document.querySelectorAll('#tiktok-download-btn-wrapper').forEach((el) => el.remove());
}

/**
 * 解析指定视频的真实媒体地址，并在当前页面内弹出播放器预览
 * @param {string} videoId - 视频的唯一标识符 ID
 * @param {string} title - 视频标题
 */
async function handleVideoPreview(videoId, title) {
  if (!videoId) {
    showToast('无效的视频 ID！');
    return;
  }

  const info = apiVideos[videoId] || {};
  const card = getScannedCardByVideoId(videoId);
  const detailUrl = card && card.url ? card.url : '';
  const modalTitle = title || info.desc || `视频 ${videoId}`;
  const initialProducts = Array.isArray(info.products) ? info.products : [];
  const initialCommerceMeta = normalizeCommerceMeta(info.commerceMeta, initialProducts);
  const hasUsableCachedProducts = hasUsablePreviewProducts(initialProducts);

  openVideoPreviewModal(info.playUrl || '', modalTitle, initialProducts, initialCommerceMeta, {
    loadingMedia: !info.playUrl,
    mediaMessage: info.playUrl ? '已使用缓存播放地址，正在校验更清晰地址...' : '正在解析播放地址，商品信息会在下方继续加载...',
    loadingProducts: !hasUsableCachedProducts,
    productMessage: hasUsableCachedProducts ? '' : '正在直接读取挂车商品信息...'
  });

  const mediaTask = resolvePreviewMedia(videoId, modalTitle, detailUrl, info);
  const commerceTask = hasUsableCachedProducts
    ? Promise.resolve({ products: initialProducts, commerceMeta: initialCommerceMeta, skipped: true })
    : loadPreviewCommerceDetails(videoId, detailUrl, info, initialProducts, initialCommerceMeta);
  void loadPreviewSubtitleTranslation(videoId, info, modalTitle).catch((error) => {
    console.warn('[达人数据助手][content] 字幕翻译失败:', error);
    const message = getFriendlyRuntimeErrorMessage(error) || '字幕翻译失败';
    updateVideoPreviewSubtitles({
      status: message.refreshRequired ? '需刷新页面' : '翻译失败',
      text: message.text || message,
      original: ''
    });
  });

  const settled = await Promise.allSettled([mediaTask, commerceTask]);
  const mediaResult = settled[0];
  if (mediaResult.status === 'rejected') {
    console.error('[达人数据助手][content] 视频预览播放地址解析失败:', mediaResult.reason);
    updateVideoPreviewMediaStatus(`播放地址解析失败：${mediaResult.reason && mediaResult.reason.message ? mediaResult.reason.message : '未知错误'}`, true);
  }
}

async function resolvePreviewMedia(videoId, title, detailUrl, info = {}) {
  let mainError = null;
  let resolved = await requestPageContextDownload({
    videoId,
    filename: buildVideoFilename(title || info.desc || 'video', videoId),
    preferredUrl: info.playUrl || '',
    detailUrl,
    includeCommerceDetail: false,
    mode: 'resolveUrl',
    silent: true
  }).catch((error) => {
    mainError = error;
    console.warn('[达人数据助手][content] 主线路预览解析失败，准备尝试外部解析:', error);
    return {};
  });

  let mediaUrl = resolved && resolved.mediaUrl ? resolved.mediaUrl : info.playUrl;
  if (mediaUrl) {
    cachePreviewVideoInfo(videoId, { playUrl: mediaUrl });
    updateVideoPreviewMedia(mediaUrl, '播放地址已解析完成');
    return mediaUrl;
  }

  updateVideoPreviewMediaStatus(mainError ? '主线路失败，正在尝试外部解析播放地址...' : '正在尝试外部解析播放地址...');
  try {
    const external = await enrichVideoWithExternalDetail(videoId, detailUrl, info || {});
    mediaUrl = external && external.mediaUrl ? external.mediaUrl : '';
    if (mediaUrl) {
      cachePreviewVideoInfo(videoId, {
        playUrl: mediaUrl,
        products: external.products,
        commerceMeta: external.commerceMeta,
        subtitles: external.subtitles
      });
      updateVideoPreviewMedia(mediaUrl, '已通过外部解析源拿到播放地址');
      return mediaUrl;
    }
  } catch (error) {
    console.warn('[达人数据助手][content] 外部解析播放地址失败:', error);
    mainError = error;
  }

  throw mainError || new Error('未解析到可播放的视频地址');
}

async function loadPreviewCommerceDetails(videoId, detailUrl, info = {}, baseProducts = [], baseCommerceMeta = {}) {
  let products = mergeCommerceProducts(baseProducts);
  let commerceMeta = normalizeCommerceMeta(baseCommerceMeta, products);
  if (hasUsablePreviewProducts(products)) {
    updateVideoPreviewProducts(products, commerceMeta, { loading: false });
    return { products, commerceMeta, skipped: true };
  }

  updateVideoPreviewProducts(products, commerceMeta, {
    loading: true,
    message: '正在读取 TikTok 详情页挂车商品...'
  });

  try {
    const pageDetail = await fetchPageContextCommerceDetail(videoId, detailUrl, {
      ...info,
      products,
      commerceMeta
    });
    products = mergeCommerceProducts(products, pageDetail.products || []);
    commerceMeta = normalizeCommerceMeta(
      mergeCommerceMeta(commerceMeta, pageDetail.commerceMeta),
      products
    );
    cachePreviewVideoInfo(videoId, {
      playUrl: pageDetail.mediaUrl || '',
      products,
      commerceMeta
    });
  } catch (error) {
    console.warn('[达人数据助手][content] 预览商品详情页兜底解析失败:', error);
    commerceMeta = normalizeCommerceMeta(
      mergeCommerceMeta(commerceMeta, {
        sourceStatuses: [buildSourceStatus('page-detail', 'error', error && error.message ? error.message : '')]
      }),
      products
    );
  }

  if (hasUsablePreviewProducts(products)) {
    updateVideoPreviewProducts(products, commerceMeta, { loading: false });
    return { products, commerceMeta };
  }

  updateVideoPreviewProducts(products, commerceMeta, {
    loading: true,
    message: products.length ? '已读取到商品，正在补全价格和链接...' : '正在调用外部解析源补全商品...'
  });

  try {
    const external = await enrichVideoWithExternalDetail(videoId, detailUrl, {
      ...info,
      products,
      commerceMeta
    });
    products = mergeCommerceProducts(products, external.products || []);
    commerceMeta = normalizeCommerceMeta(
      mergeCommerceMeta(commerceMeta, external.commerceMeta),
      products
    );
    cachePreviewVideoInfo(videoId, {
      playUrl: external.mediaUrl || '',
      products,
      commerceMeta,
      subtitles: external.subtitles
    });
  } catch (error) {
    console.warn('[达人数据助手][content] 预览商品外部解析失败:', error);
    commerceMeta = normalizeCommerceMeta(
      mergeCommerceMeta(commerceMeta, {
        sourceStatuses: [buildSourceStatus('external', 'error', error && error.message ? error.message : '')]
      }),
      products
    );
  }

  updateVideoPreviewProducts(products, commerceMeta, { loading: false });
  return { products, commerceMeta };
}

function cachePreviewVideoInfo(videoId, patch = {}) {
  if (!videoId) return;
  const previous = apiVideos[videoId] || {};
  const products = patch.products
    ? mergeCommerceProducts(previous.products || [], patch.products)
    : (previous.products || []);
  const commerceMeta = patch.commerceMeta
    ? normalizeCommerceMeta(mergeCommerceMeta(previous.commerceMeta, patch.commerceMeta), products)
    : previous.commerceMeta;

  apiVideos[videoId] = {
    ...previous,
    ...(patch.playUrl ? { playUrl: patch.playUrl } : {}),
    ...(products.length ? { products } : {}),
    ...(commerceMeta ? { commerceMeta } : {}),
    subtitles: mergeSubtitleCandidates(previous.subtitles, patch.subtitles)
  };
}

function openVideoPreviewModal(mediaUrl, title, products = [], commerceMeta = {}, options = {}) {
  closeVideoPreviewModal();

  const loadingMedia = options.loadingMedia !== undefined ? Boolean(options.loadingMedia) : !mediaUrl;
  const mediaMessage = options.mediaMessage || (mediaUrl ? '' : '正在解析播放地址...');
  const backdrop = document.createElement('div');
  backdrop.className = 'helper-video-preview-backdrop';
  backdrop.innerHTML = `
    <div class="helper-video-preview-dialog" role="dialog" aria-modal="true">
      <div class="helper-video-preview-head">
        <div class="helper-video-preview-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <button class="helper-video-preview-close" type="button" aria-label="关闭播放器">×</button>
      </div>
      <div class="helper-video-preview-body">
        <div class="helper-video-preview-player${loadingMedia ? ' is-loading' : ''}">
          <video class="helper-video-preview-video"${mediaUrl ? ` src="${escapeAttribute(mediaUrl)}"` : ''} controls autoplay playsinline></video>
          <div class="helper-video-preview-media-status">${escapeHtml(mediaMessage)}</div>
          <div class="helper-video-preview-synced-subtitle" aria-live="polite"><span></span></div>
        </div>
        <div class="helper-video-preview-url">${escapeHtml(mediaUrl)}</div>
        <div class="helper-video-subtitles-slot">
          ${renderPreviewSubtitles({
            status: options.subtitleMessage || '正在读取字幕并准备翻译...',
            text: '',
            original: '',
            loading: true
          })}
        </div>
        <div class="helper-video-products-slot">
          ${renderPreviewProducts(products, commerceMeta, {
            loading: Boolean(options.loadingProducts),
            message: options.productMessage || ''
          })}
        </div>
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeVideoPreviewModal();
    }
  });
  backdrop.querySelector('.helper-video-preview-close').addEventListener('click', closeVideoPreviewModal);

  document.body.appendChild(backdrop);

  const video = backdrop.querySelector('video');
  bindPreviewVideoStatusCleanup(video);
  bindPreviewSubtitleActions();
  if (video && mediaUrl) {
    video.play().catch(() => {
      showToast('浏览器已阻止自动播放，请手动点击播放');
    });
  }
}

function updateVideoPreviewMedia(mediaUrl, message = '') {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal || !mediaUrl) return;
  const video = modal.querySelector('.helper-video-preview-video');
  const urlBox = modal.querySelector('.helper-video-preview-url');
  const player = modal.querySelector('.helper-video-preview-player');
  if (video && video.getAttribute('src') !== mediaUrl) {
    video.src = mediaUrl;
    video.load();
    bindPreviewVideoStatusCleanup(video);
  }
  if (urlBox) {
    urlBox.textContent = mediaUrl;
  }
  if (player) {
    player.classList.remove('is-loading');
  }
  updateVideoPreviewMediaStatus(message || '播放地址已就绪');
  if (video) {
    video.play().catch(() => {
      updateVideoPreviewMediaStatus('播放地址已就绪，请手动点击视频播放');
    });
  }
}

function bindPreviewVideoStatusCleanup(video) {
  if (!video || video.dataset.previewStatusCleanupBound === '1') return;
  video.dataset.previewStatusCleanupBound = '1';
  ['playing', 'canplay', 'timeupdate'].forEach((eventName) => {
    video.addEventListener(eventName, () => clearVideoPreviewMediaStatus(), { once: eventName !== 'timeupdate' });
  });
}

function updateVideoPreviewMediaStatus(message = '', isError = false) {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  if (previewMediaStatusTimer) {
    clearTimeout(previewMediaStatusTimer);
    previewMediaStatusTimer = null;
  }
  const statusEl = modal.querySelector('.helper-video-preview-media-status');
  const player = modal.querySelector('.helper-video-preview-player');
  if (statusEl) {
    statusEl.textContent = message || '';
    statusEl.style.color = isError ? '#ff8a9c' : 'rgba(255,255,255,0.82)';
  }
  if (player) {
    player.classList.toggle('is-loading', Boolean(message && !isError && !modal.querySelector('.helper-video-preview-video')?.src));
  }
  if (message && !isError && !/正在|失败|阻止|手动/.test(message)) {
    previewMediaStatusTimer = setTimeout(() => clearVideoPreviewMediaStatus(), 1500);
  }
}

function clearVideoPreviewMediaStatus() {
  if (previewMediaStatusTimer) {
    clearTimeout(previewMediaStatusTimer);
    previewMediaStatusTimer = null;
  }
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const statusEl = modal.querySelector('.helper-video-preview-media-status');
  if (!statusEl || !statusEl.textContent) return;
  statusEl.textContent = '';
  statusEl.style.color = 'rgba(255,255,255,0.82)';
  const player = modal.querySelector('.helper-video-preview-player');
  if (player) {
    player.classList.remove('is-loading');
  }
}

function updateVideoPreviewProducts(products, commerceMeta = {}, state = {}) {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const slot = modal.querySelector('.helper-video-products-slot');
  if (!slot) return;
  slot.innerHTML = renderPreviewProducts(products, commerceMeta, state);
}

function updateVideoPreviewSubtitles(state = {}) {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const slot = modal.querySelector('.helper-video-subtitles-slot');
  if (!slot) return;
  slot.innerHTML = renderPreviewSubtitles(state);
  bindPreviewSubtitleActions(state);
}

function closeVideoPreviewModal() {
  if (previewMediaStatusTimer) {
    clearTimeout(previewMediaStatusTimer);
    previewMediaStatusTimer = null;
  }
  const oldModal = document.querySelector('.helper-video-preview-backdrop');
  if (!oldModal) return;
  const video = oldModal.querySelector('video');
  if (video) {
    if (video._helperSyncedSubtitleCleanup) {
      video._helperSyncedSubtitleCleanup();
      video._helperSyncedSubtitleCleanup = null;
    }
    stopPreviewAsrTranslation();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  oldModal.remove();
}

async function loadPreviewSubtitleTranslation(videoId, info = {}, title = '') {
  updateVideoPreviewSubtitles({
    status: '读取中',
    text: '正在查找视频字幕...',
    original: '',
    loading: true
  });

  let source = await resolvePreviewSubtitleSource(videoId, info, title);
  if (!source || !source.text) {
    updateVideoPreviewSubtitles({
      status: '无字幕',
      text: '暂未从 TikTok 接口中读取到字幕或可翻译的简介。',
      original: '',
      loading: false
    });
    return null;
  }

  const originalText = trimTextForTranslation(source.text, PREVIEW_TRANSLATION_TEXT_LIMIT);
  updateVideoPreviewSubtitles({
    status: source.kind === 'subtitle' ? '字幕已读取' : '简介已读取',
    text: source.kind === 'subtitle' ? '正在翻译字幕为中文...' : '未拿到字幕，正在翻译视频简介为中文...',
    original: originalText,
    loading: true
  });

  const result = await sendRuntimeMessage({
    action: TRANSLATE_TEXT_ACTION,
    text: originalText,
    sourceLanguage: source.language || '',
    targetLanguage: 'zh-CN',
    title: title || info.desc || ''
  });

  if (!result || !result.success) {
    updateVideoPreviewSubtitles({
      status: result && result.needConfig ? '未启用 AI' : '翻译失败',
      text: normalizeErrorText(result && result.error ? result.error : '翻译没有返回有效结果'),
      original: originalText,
      loading: false
    });
    return null;
  }

  updateVideoPreviewSubtitles({
    status: getTranslationProviderLabel(result.provider, source.kind),
    text: result.text || '',
    original: originalText,
    loading: false
  });
  if (source.kind === 'subtitle' && Array.isArray(source.cues) && source.cues.length) {
    const translatedCues = buildTranslatedSubtitleCues(source.cues, result.text || '');
    if (translatedCues.length) {
      bindSyncedPreviewSubtitles(translatedCues);
      updateVideoPreviewSubtitles({
        status: '同步中文字幕',
        text: '已启用跟随播放进度的中文字幕。',
        original: '',
        loading: false,
        mode: 'synced'
      });
    }
  }
  return result.text || '';
}

async function resolvePreviewSubtitleSource(videoId, info = {}, title = '') {
  const candidates = mergeSubtitleCandidates(info.subtitles, videoId && apiVideos[videoId] && apiVideos[videoId].subtitles);
  for (const candidate of candidates) {
    if (!candidate || !candidate.url) continue;
    try {
      const result = await sendRuntimeMessage({
        action: FETCH_SUBTITLE_TEXT_ACTION,
        url: candidate.url,
        videoId
      });
      if (!result || !result.success || !result.text) continue;
      const parsed = parseSubtitlePayload(result.text, result.contentType || candidate.format);
      if (parsed && parsed.text) {
        return {
          kind: 'subtitle',
          text: parsed.text,
          cues: parsed.cues,
          language: candidate.language || ''
        };
      }
    } catch (error) {
      console.warn('[达人数据助手][content] 字幕文件读取失败:', candidate.url, error);
    }
  }

  const fallbackText = normalizePreviewFallbackText(info.desc || title || '');
  if (fallbackText) {
    return {
      kind: 'description',
      text: fallbackText,
      language: ''
    };
  }
  return null;
}

function parseSubtitlePayload(rawText, contentType = '') {
  const text = String(rawText || '').trim();
  if (!text) return { text: '', cues: [] };

  const parsedJsonText = parseSubtitleJsonText(text);
  if (parsedJsonText) return { text: parsedJsonText, cues: [] };

  const cues = parseTimedSubtitleCues(text);
  if (cues.length) {
    return {
      text: dedupeSubtitleLines(cues.map((cue) => cue.text)).join('\n').trim(),
      cues
    };
  }

  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line &&
      !/^WEBVTT/i.test(line) &&
      !/^NOTE\b/i.test(line) &&
      !/^\d+$/.test(line) &&
      !/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(line) &&
      !/^\d{2}:\d{2}[,.]\d{1,3}\s+-->\s+\d{2}:\d{2}[,.]\d{1,3}/.test(line)
    )
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/\{\\.*?\}/g, '').trim())
    .filter(Boolean);

  return {
    text: dedupeSubtitleLines(lines).join('\n').trim(),
    cues: []
  };
}

function parseTimedSubtitleCues(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '');
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  blocks.forEach((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) return;
    const timing = parseSubtitleTiming(lines[timeIndex]);
    if (!timing) return;
    const textLines = lines.slice(timeIndex + 1)
      .map((line) => line.replace(/<[^>]+>/g, '').replace(/\{\\.*?\}/g, '').trim())
      .filter(Boolean);
    const cueText = dedupeSubtitleLines(textLines).join('\n').trim();
    if (!cueText) return;
    cues.push({
      start: timing.start,
      end: timing.end,
      text: cueText
    });
  });

  return cues.sort((a, b) => a.start - b.start);
}

function parseSubtitleTiming(line) {
  const parts = String(line || '').split('-->');
  if (parts.length < 2) return null;
  const start = parseSubtitleTime(parts[0]);
  const end = parseSubtitleTime(parts[1].split(/\s+/)[0]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function parseSubtitleTime(value) {
  const text = String(value || '').trim().replace(',', '.');
  const parts = text.split(':');
  if (parts.length < 2) return NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function parseSubtitleJsonText(text) {
  if (!/^[\[{]/.test(text)) return '';
  try {
    const payload = JSON.parse(text);
    const lines = [];
    collectSubtitleJsonLines(payload, lines, 0, new Set());
    return dedupeSubtitleLines(lines).join('\n').trim();
  } catch (error) {
    return '';
  }
}

function collectSubtitleJsonLines(value, lines, depth, seen) {
  if (!value || depth > 8) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text && !/^https?:\/\//i.test(text) && text.length <= 500) lines.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSubtitleJsonLines(item, lines, depth + 1, seen));
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  ['text', 'content', 'caption', 'subtitle', 'utterance'].forEach((key) => {
    if (typeof value[key] === 'string') collectSubtitleJsonLines(value[key], lines, depth + 1, seen);
  });
  Object.entries(value).forEach(([key, child]) => {
    if (/url|link|uri|time|start|end|duration/i.test(key)) return;
    collectSubtitleJsonLines(child, lines, depth + 1, seen);
  });
}

function dedupeSubtitleLines(lines) {
  const result = [];
  const seen = new Set();
  (lines || []).forEach((line) => {
    const normalized = String(line || '').replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function normalizePreviewFallbackText(text) {
  return String(text || '')
    .replace(/#[^\s#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimTextForTranslation(text, maxLength) {
  const safeText = String(text || '').trim();
  if (!maxLength || safeText.length <= maxLength) return safeText;
  return `${safeText.slice(0, maxLength)}\n\n[字幕较长，已截取前 ${maxLength} 字符翻译]`;
}

function buildTranslatedSubtitleCues(cues, translatedText) {
  const safeCues = Array.isArray(cues) ? cues.filter((cue) => cue && cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end)) : [];
  if (!safeCues.length) return [];
  const translatedLines = dedupeSubtitleLines(String(translatedText || '').split(/\r?\n/));
  return safeCues.map((cue, index) => ({
    start: cue.start,
    end: cue.end,
    text: translatedLines[index] || translatedLines[Math.min(index, translatedLines.length - 1)] || cue.text
  })).filter((cue) => cue.text);
}

function bindSyncedPreviewSubtitles(cues) {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal || !Array.isArray(cues) || !cues.length) return;
  const video = modal.querySelector('.helper-video-preview-video');
  const overlay = modal.querySelector('.helper-video-preview-synced-subtitle');
  const textEl = overlay && overlay.querySelector('span');
  if (!video || !overlay || !textEl) return;

  video._helperSyncedSubtitleCues = cues;
  if (video._helperSyncedSubtitleCleanup) {
    video._helperSyncedSubtitleCleanup();
  }

  const update = () => {
    const active = findActiveSubtitleCue(video._helperSyncedSubtitleCues || [], video.currentTime || 0);
    if (active && active.text) {
      textEl.textContent = active.text;
      overlay.classList.add('is-visible');
    } else {
      textEl.textContent = '';
      overlay.classList.remove('is-visible');
    }
  };
  const clear = () => {
    textEl.textContent = '';
    overlay.classList.remove('is-visible');
  };
  ['timeupdate', 'seeked', 'play', 'playing', 'loadedmetadata'].forEach((eventName) => {
    video.addEventListener(eventName, update);
  });
  ['pause', 'ended', 'emptied'].forEach((eventName) => {
    video.addEventListener(eventName, eventName === 'pause' ? update : clear);
  });
  video._helperSyncedSubtitleCleanup = () => {
    ['timeupdate', 'seeked', 'play', 'playing', 'loadedmetadata'].forEach((eventName) => {
      video.removeEventListener(eventName, update);
    });
    ['pause', 'ended', 'emptied'].forEach((eventName) => {
      video.removeEventListener(eventName, eventName === 'pause' ? update : clear);
    });
  };
  update();
}

function findActiveSubtitleCue(cues, currentTime) {
  return cues.find((cue) => currentTime >= cue.start && currentTime <= cue.end) || null;
}

function bindPreviewSubtitleActions() {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const button = modal.querySelector('.helper-video-asr-toggle');
  if (!button || button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (previewAsrActive) {
      stopPreviewAsrTranslation();
      updateVideoPreviewSubtitles({
        status: '实时听译已停止',
        text: '已停止实时 ASR 听译。需要继续时可再次开启。',
        original: '',
        loading: false
      });
      setPreviewSubtitleOverlayText('', false);
      return;
    }
    startPreviewAsrTranslation();
  });
}

async function startPreviewAsrTranslation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    updateVideoPreviewSubtitles({
      status: '不支持实时识别',
      text: '当前浏览器不支持免费的 Web Speech 实时识别，无法用 ASR 生成同步字幕。',
      original: '',
      loading: false
    });
    return;
  }

  stopPreviewAsrTranslation({ silent: true });
  previewAsrActive = true;
  previewAsrStopRequested = false;
  previewAsrTranslateSeq += 1;
  clearTimedPreviewSubtitles();

  updateVideoPreviewSubtitles({
    status: '请求听译权限',
    text: '正在请求麦克风/系统声音输入权限，请在浏览器权限框中点击允许。',
    original: '',
    loading: false
  });
  try {
    previewAsrMediaStream = await requestPreviewAsrAudioPermission();
  } catch (error) {
    previewAsrActive = false;
    previewAsrStopRequested = true;
    updateVideoPreviewSubtitles({
      status: '需要授权',
      text: normalizeAsrPermissionError(error),
      original: '',
      loading: false
    });
    setPreviewSubtitleOverlayText('', false);
    return;
  }

  const recognition = new SpeechRecognition();
  previewAsrRecognition = recognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.lang = inferAsrLanguageFromVisibleText();

  recognition.onstart = () => {
    updateVideoPreviewSubtitles({
      status: `实时听译中 ${recognition.lang}`,
      text: '正在听视频声音并翻译成中文。若没有识别结果，请把系统声音路由到麦克风输入，或调大外放音量。',
      original: '',
      loading: false
    });
  };

  recognition.onresult = (event) => {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result && result[0] ? String(result[0].transcript || '').trim() : '';
      if (!transcript) continue;
      if (result.isFinal) {
        finalText += `${transcript} `;
      } else {
        interim += `${transcript} `;
      }
    }
    const liveText = (finalText || interim).trim();
    if (!liveText) return;
    updateVideoPreviewSubtitles({
      status: finalText ? '正在翻译当前语音' : '正在识别当前语音',
      text: liveText,
      original: '',
      loading: false
    });
    if (finalText) {
      translateAsrTextToChinese(finalText.trim());
    }
  };

  recognition.onerror = (event) => {
    const errorText = normalizeAsrError(event && event.error);
    if (event && (event.error === 'not-allowed' || event.error === 'service-not-allowed')) {
      previewAsrActive = false;
      previewAsrStopRequested = true;
      releasePreviewAsrMediaStream();
    }
    updateVideoPreviewSubtitles({
      status: '实时听译异常',
      text: errorText,
      original: '',
      loading: false
    });
  };

  recognition.onend = () => {
    if (!previewAsrActive || previewAsrStopRequested) return;
    clearTimeout(previewAsrRestartTimer);
    previewAsrRestartTimer = setTimeout(() => {
      if (!previewAsrActive || previewAsrStopRequested) return;
      try {
        recognition.start();
      } catch (error) {
        console.warn('[达人数据助手][content] ASR 重启失败:', error);
      }
    }, 450);
  };

  try {
    recognition.start();
  } catch (error) {
    previewAsrActive = false;
    previewAsrStopRequested = true;
    releasePreviewAsrMediaStream();
    updateVideoPreviewSubtitles({
      status: '实时听译启动失败',
      text: normalizeErrorText(error) || '浏览器拒绝启动实时语音识别，请刷新页面后重试。',
      original: '',
      loading: false
    });
  }
}

function stopPreviewAsrTranslation(options = {}) {
  previewAsrActive = false;
  previewAsrStopRequested = true;
  previewAsrTranslateSeq += 1;
  clearTimeout(previewAsrRestartTimer);
  previewAsrRestartTimer = null;
  if (previewAsrRecognition) {
    try {
      previewAsrRecognition.onend = null;
      previewAsrRecognition.stop();
    } catch (error) {
      if (!options.silent) console.warn('[达人数据助手][content] 停止 ASR 失败:', error);
    }
  }
  previewAsrRecognition = null;
  releasePreviewAsrMediaStream();
  refreshPreviewAsrButton();
}

async function requestPreviewAsrAudioPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前页面不支持请求音频输入权限。');
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

function releasePreviewAsrMediaStream() {
  if (!previewAsrMediaStream) return;
  previewAsrMediaStream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (error) {
      console.warn('[达人数据助手][content] 释放 ASR 音频轨失败:', error);
    }
  });
  previewAsrMediaStream = null;
}

async function translateAsrTextToChinese(text) {
  const currentSeq = ++previewAsrTranslateSeq;
  try {
    const result = await sendRuntimeMessage({
      action: TRANSLATE_TEXT_ACTION,
      text,
      sourceLanguage: '',
      targetLanguage: 'zh-CN',
      title: '实时 ASR 字幕'
    });
    if (!previewAsrActive || currentSeq !== previewAsrTranslateSeq || !result || !result.success) return;
    const translated = result.text || '';
    setPreviewSubtitleOverlayText(translated, Boolean(translated));
    updateVideoPreviewSubtitles({
      status: getTranslationProviderLabel(result.provider, 'asr'),
      text: translated || '正在等待下一句语音...',
      original: text,
      loading: false
    });
  } catch (error) {
    updateVideoPreviewSubtitles({
      status: '实时翻译失败',
      text: normalizeErrorText(error) || '实时语音翻译失败',
      original: text,
      loading: false
    });
  }
}

function setPreviewSubtitleOverlayText(text, visible = true) {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const overlay = modal.querySelector('.helper-video-preview-synced-subtitle');
  const textEl = overlay && overlay.querySelector('span');
  if (!overlay || !textEl) return;
  textEl.textContent = text || '';
  overlay.classList.toggle('is-visible', Boolean(visible && text));
}

function getTranslationProviderLabel(provider, kind) {
  const prefix = provider === 'ai' ? 'AI' : '免费';
  if (kind === 'asr') return `${prefix}实时听译`;
  if (kind === 'subtitle') return `${prefix}中文字幕`;
  return `${prefix}中文简介`;
}

function clearTimedPreviewSubtitles() {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  if (!modal) return;
  const video = modal.querySelector('.helper-video-preview-video');
  if (!video) return;
  if (video._helperSyncedSubtitleCleanup) {
    video._helperSyncedSubtitleCleanup();
    video._helperSyncedSubtitleCleanup = null;
  }
  video._helperSyncedSubtitleCues = [];
}

function inferAsrLanguageFromVisibleText() {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  const text = modal ? modal.textContent || '' : '';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th-TH';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  return 'th-TH';
}

function normalizeAsrError(error) {
  const text = String(error || '').trim();
  if (text === 'not-allowed' || text === 'service-not-allowed') {
    return '浏览器没有麦克风/语音识别权限，请允许权限后再开启实时听译。';
  }
  if (text === 'no-speech') return '暂时没有识别到声音，请确认视频在播放且浏览器能听到声音。';
  if (text === 'audio-capture') return '没有可用的麦克风或系统音频输入。';
  if (text === 'network') return '免费语音识别服务网络异常，请稍后重试。';
  return text ? `实时识别异常：${text}` : '实时识别异常，请稍后重试。';
}

function normalizeAsrPermissionError(error) {
  const text = String(error && error.name ? error.name : (error && error.message ? error.message : error || '')).trim();
  if (/notallowed|permission|denied/i.test(text)) {
    return '浏览器没有麦克风/系统声音输入权限，请在弹出的权限框中点击允许，或到浏览器地址栏权限设置里打开麦克风权限。';
  }
  if (/notfound|devicesnotfound/i.test(text)) {
    return '没有找到可用的麦克风或系统音频输入设备。';
  }
  return normalizeErrorText(error) || '无法请求音频输入权限，请刷新页面后重试。';
}

function refreshPreviewAsrButton() {
  const modal = document.querySelector('.helper-video-preview-backdrop');
  const button = modal && modal.querySelector('.helper-video-asr-toggle');
  if (!button) return;
  button.textContent = previewAsrActive ? '停止实时听译' : '开启实时听译';
}

function renderPreviewSubtitles(state = {}) {
  const loadingHtml = state.loading ? '<span class="helper-video-products-spinner"></span>' : '';
  const status = state.status || '字幕翻译';
  const text = state.text || '';
  const original = state.original || '';
  const title = state.mode === 'synced' ? '同步中文字幕' : '字幕自动翻译';
  const actionsHtml = state.mode === 'synced'
    ? ''
    : `
      <div class="helper-video-subtitles-actions">
        <button class="helper-video-subtitles-btn helper-video-asr-toggle" type="button">
          ${previewAsrActive ? '停止实时听译' : '开启实时听译'}
        </button>
        <span class="helper-video-subtitles-hint">无时间轴字幕时可用，需允许麦克风/系统声音输入。</span>
      </div>
    `;
  return `
    <div class="helper-video-subtitles">
      <div class="helper-video-subtitles-head">
        <span>${escapeHtml(title)}</span>
        <span class="helper-video-subtitles-status">${loadingHtml}${escapeHtml(status)}</span>
      </div>
      <div class="helper-video-subtitles-text">${escapeHtml(text || '等待字幕解析结果...')}</div>
      ${original ? `<div class="helper-video-subtitles-original">${escapeHtml(original)}</div>` : ''}
      ${actionsHtml}
    </div>
  `;
}

function renderPreviewProducts(products, commerceMeta = {}, state = {}) {
  const safeProducts = Array.isArray(products) ? products.filter(item => item && item.name).slice(0, 8) : [];
  const loadingHtml = state && state.loading
    ? `
      <div class="helper-video-products-progress">
        <span class="helper-video-products-spinner"></span>
        <span>${escapeHtml(state.message || '正在解析挂车商品信息...')}</span>
      </div>
    `
    : '';
  if (!safeProducts.length) {
    const safeMeta = normalizeCommerceMeta(commerceMeta, safeProducts);
    const externalStatuses = safeMeta.sourceStatuses.filter((status) => status.includes('external') || status.includes('douyin.wtf'));
    const sessionStatuses = safeMeta.sourceStatuses.filter((status) => status.includes('session-'));
    const checkedExternal = externalStatuses.length > 0;
    const externalFailed = externalStatuses.some((status) => status.includes(':error'));
    const sessionFailed = sessionStatuses.some((status) => status.includes(':error'));
    const externalText = externalFailed
      ? '已额外请求外部 TikTok/Douyin 解析源，但该源请求失败；系统已尝试 TikTok 详情页兜底。'
      : (checkedExternal
      ? '已额外请求外部 TikTok/Douyin 解析源，但该源返回的 anchors/products_info/bottom_products/right_products 也为空。'
      : '');
    const sessionText = sessionFailed
      ? ' 已捕获到当前浏览器会话的商品信号，但商品页可能受登录状态、地区或可售范围限制。'
      : (sessionStatuses.length ? ' 已读取当前浏览器会话中的商品请求，但尚未获得完整商品字段。' : '');
    const emptyText = state && state.loading
      ? '正在读取 TikTok 详情页、外部解析源和商品页数据，解析到商品后会自动显示在这里。'
      : (safeMeta.isCommerceVideo
        ? `已识别到这是 TikTok 电商/挂车视频，但当前可访问数据没有下发商品名称、价格或商品链接。${externalText}${sessionText} 为避免误判，暂不展示商品。`
        : '暂未从该视频解析到挂车商品信息。');
    const metaText = safeMeta.anchorTypes.length ? `锚点类型：${escapeHtml(safeMeta.anchorTypes.join(', '))}` : '';
    const sourceText = safeMeta.sourceStatuses.length ? `解析链路：${escapeHtml(safeMeta.sourceStatuses.join(' / '))}` : '';
    return `
      <div class="helper-video-products">
        <div class="helper-video-products-title">
          <span>挂车商品</span>
          <span class="helper-video-products-count">${state && state.loading ? '解析中' : '0 个'}</span>
        </div>
        ${loadingHtml}
        <div class="helper-video-products-empty">
          ${escapeHtml(emptyText)}
          ${metaText ? `<div class="helper-video-products-meta">${metaText}</div>` : ''}
          ${sourceText ? `<div class="helper-video-products-meta">${sourceText}</div>` : ''}
        </div>
      </div>
    `;
  }

  const listHtml = safeProducts.map((product) => {
    const imageHtml = product.image
      ? `<img class="helper-video-product-img" src="${escapeAttribute(product.image)}" alt="">`
      : `<div class="helper-video-product-img"></div>`;
    const priceHtml = product.price ? `<span class="helper-video-product-price">${escapeHtml(product.price)}</span>` : '';
    const originalPriceHtml = product.originalPrice ? `<span class="helper-video-product-origin-price">${escapeHtml(product.originalPrice)}</span>` : '';
    const shopHtml = product.shopName ? `<span>${escapeHtml(product.shopName)}</span>` : '';
    const ratingHtml = product.rating ? `<span>评分 ${escapeHtml(product.rating)}${product.reviewCount ? `(${escapeHtml(product.reviewCount)})` : ''}</span>` : '';
    const soldHtml = product.soldCount ? `<span>销量 ${escapeHtml(product.soldCount)}</span>` : '';
    const extraHtml = [shopHtml, ratingHtml, soldHtml].filter(Boolean).join('');
    const inner = `
      ${imageHtml}
      <div class="helper-video-product-info">
        <div class="helper-video-product-name" title="${escapeHtml(product.name)}">${escapeHtml(product.name)}</div>
        <div class="helper-video-product-meta">${priceHtml}${originalPriceHtml}</div>
        ${extraHtml ? `<div class="helper-video-product-extra">${extraHtml}</div>` : ''}
      </div>
    `;
    if (product.url) {
      return `<a class="helper-video-product-card" href="${escapeAttribute(product.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    return `<div class="helper-video-product-card">${inner}</div>`;
  }).join('');

  return `
    <div class="helper-video-products">
      <div class="helper-video-products-title">
        <span>挂车商品</span>
        <span class="helper-video-products-count">${safeProducts.length} 个</span>
      </div>
      ${loadingHtml}
      <div class="helper-video-product-list">${listHtml}</div>
    </div>
  `;
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
      shopName: product.shopName || '',
      rating: product.rating || '',
      reviewCount: product.reviewCount || '',
      soldCount: product.soldCount || '',
      originalPrice: product.originalPrice || ''
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

/**
 * 列表页视频一键直接下载处理函数
 * @param {string} videoId - 视频的唯一标识符 ID
 * @param {string} title - 视频的标题文本
 */
async function handleVideoDownloadDirect(videoId, title) {
  if (!videoId) {
    showToast('无效的视频 ID！');
    return;
  }
  const info = apiVideos[videoId];
  const card = getScannedCardByVideoId(videoId);
  const filename = buildVideoFilename(title || (info && info.desc) || 'video', videoId);
  showToast('正在解析真实下载地址，请稍候...');

  try {
    let resolved = await requestPageContextDownload({
      videoId,
      filename,
      preferredUrl: (info && info.playUrl) || '',
      detailUrl: card && card.url ? card.url : '',
      mode: 'resolveUrl'
    });

    if (resolved && resolved.mediaUrl) {
      console.log('[达人数据助手][content] 已解析下载地址:', resolved.mediaUrl);
      await downloadResolvedMedia(resolved.mediaUrl, resolved.filename || filename, videoId);
      return;
    }

    throw new Error('未解析到可用的视频下载地址');
    } catch (error) {
      console.error('[达人数据助手][content] 解析或下载主线路失败:', error);
      try {
        showToast('主线路失败，正在尝试外部解析下载...');
        const external = await enrichVideoWithExternalDetail(videoId, card && card.url ? card.url : '', info || {});
        if (external.mediaUrl) {
          await downloadResolvedMedia(external.mediaUrl, filename, videoId);
          return;
        }
      } catch (fallbackError) {
        console.warn('[达人数据助手][content] 外部解析下载失败:', fallbackError);
      }
      if (info && info.playUrl) {
        showToast('主线路下载失败，正在尝试备用下载...');
        await downloadVideoFallback(info.playUrl, filename, videoId);
        return;
      }
    showToast('直接下载失败: ' + error.message);
  }
}

async function downloadResolvedMedia(mediaUrl, filename, videoId) {
  const directResult = await sendRuntimeMessage({
    action: 'download',
    url: mediaUrl,
    filename
  });

  if (directResult && directResult.success) {
    showToast('视频下载已启动！');
    return;
  }

  const directError = directResult && directResult.error ? directResult.error : '浏览器直接下载失败';
  console.warn('[达人数据助手][content] 直接下载失败，尝试后台拉流:', directError, mediaUrl);
  showToast('直接保存失败，正在尝试后台拉流...');

  const bufferResult = await sendRuntimeMessage({
    action: 'fetch_media_buffer',
    url: mediaUrl,
    videoId
  });

  if (!bufferResult || !bufferResult.success || !bufferResult.base64) {
    throw new Error(bufferResult && bufferResult.error ? bufferResult.error : directError);
  }

  const dataUrl = `data:${bufferResult.contentType || 'video/mp4'};base64,${bufferResult.base64}`;
  const saveResult = await sendRuntimeMessage({
    action: 'download_base64',
    dataUrl,
    filename
  });

  if (!saveResult || !saveResult.success) {
    throw new Error(saveResult && saveResult.error ? saveResult.error : '后台拉流保存失败');
  }

  showToast('视频下载已启动！');
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      reject(new Error('EXTENSION_CONTEXT_INVALIDATED'));
      return;
    }
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(normalizeErrorText(chrome.runtime.lastError.message)));
        return;
      }
      resolve(res || {});
    });
  });
}

function normalizeErrorText(error) {
  const text = String(error && error.message ? error.message : (error || '')).trim();
  if (!text) return '';
  if (/extension context invalidated|context invalidated|EXTENSION_CONTEXT_INVALIDATED/i.test(text)) {
    return '扩展刚更新或重新加载过，请刷新当前 TikTok 页面后再试。';
  }
  if (/receiving end does not exist|message port closed|Could not establish connection/i.test(text)) {
    return '扩展后台暂时不可用，请刷新当前 TikTok 页面后再试。';
  }
  return text;
}

function getFriendlyRuntimeErrorMessage(error) {
  const text = normalizeErrorText(error);
  if (!text) return '';
  return {
    text,
    refreshRequired: /刷新当前 TikTok 页面/.test(text)
  };
}

/**
 * 下载视频的备用 fallback 逻辑（处理 blob 及普通直链）
 * @param {string} videoUrl - 视频的源链接地址
 * @param {string} filename - 保存的文件名称
 */
async function downloadVideoFallback(videoUrl, filename, videoId = '') {
  if (videoUrl.startsWith('blob:')) {
    showToast('正在为您解密视频流，请稍候...');
    try {
      const response = await fetch(videoUrl);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          action: "download_base64",
          dataUrl: reader.result,
          filename: filename
        }, (res) => {
          if (res && res.success) showToast('加密视频下载成功！');
          else showToast('下载失败: ' + (res ? res.error : '未知错误'));
        });
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      showToast('获取加密视频流异常: ' + err.message);
    }
  } else {
    showToast('正在开始下载视频，请稍候...');
    try {
      await downloadResolvedMedia(videoUrl, filename, videoId);
    } catch (error) {
      showToast('下载失败: ' + error.message);
    }
  }
}

/**
 * 监听来自弹窗的消息，提供视频统计数据
 * @param {Object} message - 消息体，包含 action
 * @param {Object} sender - 消息发送者
 * @param {Function} sendResponse - 回调函数，用于发送视频统计数据
 * @returns {boolean} 返回 true 保持消息通道开启
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getVideoStats") {
    scanCards();
    const total = scannedCards.length;
    const totalViews = scannedCards.reduce((sum, item) => sum + item.views, 0);
    const avgViews = total > 0 ? Math.round(totalViews / total) : 0;

    sendResponse({ total: total, avgViews: avgViews });
    return true;
  }
  return false;
});

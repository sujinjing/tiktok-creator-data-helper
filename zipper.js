/**
 * 扩展隔离打包页：负责跨域拉取 TikTok 媒体文件并生成 zip。
 * 这里运行在 chrome-extension:// 页面内，避免 TikTok 页面上下文和内容脚本消息大小限制。
 */

const ZIP_REQUEST_TYPE = 'TIKTOK_HELPER_ZIP_REQUEST';
const ZIP_STATUS_TYPE = 'TIKTOK_HELPER_ZIP_STATUS';

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== ZIP_REQUEST_TYPE) return;

  handleZipRequest(data).catch((error) => {
    postZipStatus(data.requestId, 'error', error && error.message ? error.message : '批量打包失败');
  });
});

/**
 * 处理一次 zip 打包请求
 * @param {Object} payload - 打包请求
 */
async function handleZipRequest(payload) {
  const { requestId, zipName, files } = payload || {};
  if (!requestId) return;
  if (!window.JSZip) {
    throw new Error('JSZip 未加载，请重新加载扩展后刷新页面');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可打包的视频');
  }

  const zip = new window.JSZip();
  const failed = [];
  let successCount = 0;

  for (let index = 0; index < files.length; index++) {
    const file = files[index] || {};
    try {
      postZipStatus(requestId, 'progress', `正在下载第 ${index + 1}/${files.length} 个视频...`);
      const buffer = await fetchMediaArrayBuffer(file);
      zip.file(safeFilename(file.filename, index), buffer, {
        binary: true,
        compression: 'STORE'
      });
      successCount += 1;
    } catch (error) {
      failed.push({
        videoId: file.videoId || '',
        filename: file.filename || '',
        error: error && error.message ? error.message : '下载失败'
      });
    }
  }

  if (successCount === 0) {
    throw new Error('批量打包失败，没有成功获取到视频文件');
  }

  postZipStatus(requestId, 'progress', `正在生成压缩包，共 ${successCount} 个视频...`);
  const zipBlob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (metadata) => {
      if (metadata && typeof metadata.percent === 'number') {
        const percent = Math.min(99, Math.max(0, Math.round(metadata.percent)));
        postZipStatus(requestId, 'progress', `正在生成压缩包 ${percent}%...`);
      }
    }
  );

  await downloadZipBlob(zipBlob, safeZipName(zipName));
  postZipStatus(requestId, 'success', `压缩包下载已启动，共 ${successCount} 个视频`, {
    filename: safeZipName(zipName),
    failed
  });
}

/**
 * 拉取单个媒体文件为 ArrayBuffer
 * @param {Object} file - 媒体文件描述
 * @returns {Promise<ArrayBuffer>} 媒体二进制
 */
async function fetchMediaArrayBuffer(file) {
  if (!file.url || typeof file.url !== 'string') {
    throw new Error('缺少视频地址');
  }

  const response = await fetch(file.url, {
    method: 'GET',
    credentials: 'include',
    referrer: file.videoId ? getTikTokPlayerUrl(file.videoId) : 'https://www.tiktok.com/',
    referrerPolicy: 'strict-origin-when-cross-origin',
    headers: {
      Accept: 'video/mp4,video/*,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`视频请求失败（${response.status}）`);
  }

  const contentType = response.headers.get('content-type') || '';
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 2048 || /text\/html|application\/json/i.test(contentType)) {
    throw new Error('拿到的不是有效视频文件');
  }

  return buffer;
}

/**
 * 触发 zip 文件下载
 * @param {Blob} zipBlob - 压缩包 Blob
 * @param {string} filename - 下载文件名
 * @returns {Promise<void>}
 */
function downloadZipBlob(zipBlob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(zipBlob);
    chrome.downloads.download({
      url,
      filename,
      saveAs: false
    }, (downloadId) => {
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!downloadId) {
        reject(new Error('浏览器未启动下载'));
        return;
      }
      resolve();
    });
  });
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
 * 清理 zip 内部文件名
 * @param {string} filename - 原始文件名
 * @param {number} index - 文件序号
 * @returns {string} 安全文件名
 */
function safeFilename(filename, index) {
  const fallback = `tiktok_video_${index + 1}.mp4`;
  return String(filename || fallback)
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
}

/**
 * 清理 zip 下载文件名
 * @param {string} zipName - 原始压缩包名
 * @returns {string} 安全压缩包名
 */
function safeZipName(zipName) {
  const name = String(zipName || `tiktok_batch_${Date.now()}.zip`)
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim();
  return name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`;
}

/**
 * 向内容脚本回传打包状态
 * @param {string} requestId - 请求 ID
 * @param {"progress"|"success"|"error"} status - 状态
 * @param {string} message - 提示文本
 * @param {Object=} extra - 额外字段
 */
function postZipStatus(requestId, status, message, extra = {}) {
  if (!requestId || !window.parent) return;
  window.parent.postMessage({
    type: ZIP_STATUS_TYPE,
    requestId,
    status,
    message,
    ...extra
  }, '*');
}

/**
 * 达人数据助手 - 弹窗脚本
 * 负责主题、可选 AI 配置、页面数据读取以及大模型接口调用逻辑
 */

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    models: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini'
    ]
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  moonshot: {
    label: 'Kimi / Moonshot',
    endpoint: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']
  },
  qwen: {
    label: '通义千问',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max']
  },
  zhipu: {
    label: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air']
  },
  sensenova: {
    label: 'SenseNova',
    endpoint: 'https://token.sensenova.cn/v1',
    models: ['sensenova-6.7-flash-lite', 'deepseek-v4-flash']
  },
  custom: {
    label: '自定义',
    endpoint: '',
    models: ['custom']
  }
};

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadConfig();
  fetchPageStats();
});

function bindEvents() {
  document.querySelectorAll('.theme-option').forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.theme, true));
  });

  document.getElementById('toolbar-visible').addEventListener('change', (event) => {
    const visible = Boolean(event.target.checked);
    syncToolbarVisibilityControl(visible);
    chrome.storage.local.set({ toolbarVisible: visible });
    notifyActiveTabToolbarVisibility(visible);
  });

  document.getElementById('ai-enabled').addEventListener('change', () => {
    syncAiConfigVisibility();
    persistAiConfigDraft();
  });
  document.getElementById('provider-select').addEventListener('change', () => {
    applyProviderPreset(true);
    persistAiConfigDraft();
  });
  document.getElementById('model-select').addEventListener('change', () => {
    syncModelInputVisibility();
    persistAiConfigDraft();
  });
  ['api-url', 'api-key', 'ai-model', 'script-prompt'].forEach((id) => {
    document.getElementById(id).addEventListener('input', persistAiConfigDraft);
  });
  document.getElementById('save-config-btn').addEventListener('click', saveConfig);
  document.getElementById('generate-script-btn').addEventListener('click', generateScript);
  document.getElementById('copy-result-btn').addEventListener('click', copyResult);
}

/**
 * 从本地存储加载配置信息，并填充到界面输入框中
 */
async function loadConfig() {
  const data = await chrome.storage.local.get([
    'popupTheme',
    'toolbarVisible',
    'aiEnabled',
    'aiProvider',
    'apiUrl',
    'apiKey',
    'aiModel',
    'prompt'
  ]);

  setTheme(data.popupTheme || 'neon', false);
  const toolbarVisible = data.toolbarVisible !== false;
  document.getElementById('toolbar-visible').checked = toolbarVisible;
  syncToolbarVisibilityControl(toolbarVisible);

  document.getElementById('ai-enabled').checked = Boolean(data.aiEnabled);
  document.getElementById('provider-select').value = data.aiProvider || 'openai';
  applyProviderPreset(false);

  if (data.apiUrl) document.getElementById('api-url').value = data.apiUrl;
  if (data.apiKey) document.getElementById('api-key').value = data.apiKey;
  setModelValue(data.aiModel || '');
  if (data.prompt) document.getElementById('script-prompt').value = data.prompt;

  syncAiConfigVisibility();
}

function syncToolbarVisibilityControl(visible) {
  const state = document.querySelector('.toolbar-visibility-state');
  if (state) state.textContent = visible ? '显示' : '隐藏';
}

/**
 * 立即同步当前标签页，避免仅依赖 storage 事件时悬浮入口延迟或未隐藏。
 * @param {boolean} visible - 是否显示页面悬浮助手
 */
async function notifyActiveTabToolbarVisibility(visible) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { action: 'setToolbarVisibility', visible }, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.warn('同步页面悬浮助手状态失败:', error);
  }
}

function persistAiConfigDraft() {
  const data = getCurrentAiConfig();
  chrome.storage.local.set({
    aiEnabled: data.aiEnabled,
    aiProvider: data.aiProvider,
    apiUrl: data.apiUrl,
    apiKey: data.apiKey,
    aiModel: data.aiModel,
    prompt: data.prompt
  });
}

function setTheme(theme, persist) {
  const safeTheme = ['neon', 'paper', 'ocean', 'ember'].includes(theme) ? theme : 'neon';
  document.body.dataset.theme = safeTheme;
  document.querySelectorAll('.theme-option').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.theme === safeTheme);
  });
  if (persist) {
    chrome.storage.local.set({ popupTheme: safeTheme });
  }
}

function syncAiConfigVisibility() {
  const enabled = document.getElementById('ai-enabled').checked;
  const fields = document.getElementById('ai-config-fields');
  const status = document.getElementById('ai-status-pill');
  const panel = document.getElementById('ai-config-panel');
  const generateBtn = document.getElementById('generate-script-btn');

  fields.classList.toggle('is-visible', enabled);
  status.classList.toggle('is-on', enabled);
  status.textContent = enabled ? '已启用' : '未启用';
  generateBtn.disabled = !enabled;
  generateBtn.textContent = enabled ? '一键生成脚本' : '启用 AI 后可生成脚本';
  if (enabled) {
    panel.open = true;
  }
}

function applyProviderPreset(shouldOverwrite) {
  const providerKey = document.getElementById('provider-select').value || 'openai';
  const provider = PROVIDERS[providerKey] || PROVIDERS.openai;
  const endpointInput = document.getElementById('api-url');

  renderModelOptions(provider.models);
  if (shouldOverwrite || !endpointInput.value.trim()) {
    endpointInput.value = provider.endpoint;
  }
  endpointInput.readOnly = providerKey !== 'custom';
  endpointInput.placeholder = providerKey === 'custom' ? 'https://your-api.example.com/v1' : provider.endpoint;
  syncModelInputVisibility();
}

function renderModelOptions(models) {
  const select = document.getElementById('model-select');
  select.innerHTML = '';
  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model === 'custom' ? '自定义模型' : model;
    select.appendChild(option);
  });
  if (!models.includes('custom')) {
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = '自定义模型';
    select.appendChild(customOption);
  }
}

function setModelValue(model) {
  const select = document.getElementById('model-select');
  const input = document.getElementById('ai-model');
  const options = Array.from(select.options).map((option) => option.value);
  if (model && options.includes(model)) {
    select.value = model;
    input.value = '';
  } else if (model) {
    select.value = 'custom';
    input.value = model;
  } else {
    select.selectedIndex = 0;
    input.value = '';
  }
  syncModelInputVisibility();
}

function syncModelInputVisibility() {
  const select = document.getElementById('model-select');
  const input = document.getElementById('ai-model');
  const isCustom = select.value === 'custom';
  input.classList.toggle('is-visible', isCustom);
  if (!isCustom) {
    input.value = '';
  }
}

/**
 * 保存用户输入的配置信息到本地存储中
 */
async function saveConfig() {
  const { aiEnabled, aiProvider, apiUrl, apiKey, aiModel, prompt } = getCurrentAiConfig();

  if (aiEnabled && (!apiUrl || !apiKey || !aiModel)) {
    alert('启用 AI 时，请补全接口地址、密钥和模型。');
    return;
  }

  await chrome.storage.local.set({ aiEnabled, aiProvider, apiUrl, apiKey, aiModel, prompt });
  syncAiConfigVisibility();
  alert(aiEnabled ? 'AI 配置保存成功！' : '已保存：当前不启用 AI。');
}

function getCurrentAiConfig() {
  const aiEnabled = document.getElementById('ai-enabled').checked;
  const aiProvider = document.getElementById('provider-select').value;
  const apiUrl = document.getElementById('api-url').value.trim();
  const apiKey = document.getElementById('api-key').value.trim();
  const selectedModel = document.getElementById('model-select').value;
  const customModel = document.getElementById('ai-model').value.trim();
  const aiModel = selectedModel === 'custom' ? customModel : selectedModel;
  const prompt = document.getElementById('script-prompt').value.trim();
  return { aiEnabled, aiProvider, apiUrl, apiKey, aiModel, prompt };
}

/**
 * 向当前活动的标签页发送消息，获取视频统计数据并渲染到弹窗页面
 */
async function fetchPageStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, { action: 'getVideoStats' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        return;
      }

      document.getElementById('total-videos').textContent = response.total || 0;
      document.getElementById('avg-views').textContent = formatViews(response.avgViews || 0);
    });
  } catch (err) {
    console.error('获取页面统计数据失败:', err);
  }
}

/**
 * 格式化播放量数字为易读字符串
 * @param {number} num - 原始播放量数字
 * @returns {string} 格式化后的文本
 */
function formatViews(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

/**
 * 触发人工智能脚本生成的主要入口方法
 */
async function generateScript() {
  const data = getCurrentAiConfig();
  if (!data.aiEnabled) {
    alert('AI 当前未启用。需要生成脚本时，先展开 AI 配置并打开开关。');
    return;
  }
  if (!data.apiKey) {
    alert('请先填写并保存您的接口密钥 (API Key)！');
    return;
  }

  const resultArea = document.getElementById('result-area');
  const resultContent = document.getElementById('result-content');

  resultArea.style.display = 'block';
  resultContent.textContent = '正在为您构思脚本，请耐心等待...';

  const videoSummary = `当前页面扫描到视频 ${document.getElementById('total-videos').textContent} 个，平均播放量为 ${document.getElementById('avg-views').textContent}`;

  const result = await fetchAIScript(data, data.prompt, videoSummary);
  resultContent.textContent = result;
  chrome.storage.local.set(data);
}

/**
 * 执行网络请求，调用 OpenAI 兼容接口生成文案
 * @param {Object} config - 包含 apiUrl, apiKey, aiModel 的配置对象
 * @param {string} prompt - 用户的指令
 * @param {string} videoContext - 从页面提取的上下文信息
 * @returns {Promise<string>} 生成后的文案结果
 */
async function fetchAIScript(config, prompt, videoContext) {
  const baseUrl = (config.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const systemPrompt = `你是一个出色的跨境电商短视频文案大师。当前环境背景是：${videoContext}。请根据用户的需求生成高转化的视频脚本。`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.aiModel || 'gpt-5.5',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt || '请帮我写一段带货短视频文案' }
        ]
      })
    });

    const resData = await response.json();
    return resData?.choices?.[0]?.message?.content || resData?.error?.message || '生成失败：接口未返回有效内容。';
  } catch (error) {
    return `生成失败，原因：${error.message}`;
  }
}

/**
 * 复制生成的结果文本到用户剪贴板
 */
function copyResult() {
  const content = document.getElementById('result-content').textContent;
  navigator.clipboard.writeText(content).then(() => {
    alert('结果已成功复制到剪贴板！');
  }).catch((err) => {
    console.error('复制失败:', err);
  });
}

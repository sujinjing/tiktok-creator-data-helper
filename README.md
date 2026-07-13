# 达人数据助手

达人数据助手是一款运行在 TikTok 网页端的 Chrome 扩展，用于扫描达人主页视频数据、辅助筛选素材，并导出视频与挂车商品信息。

> 本项目采用 **source-available** 模式公开源码，并非 OSI 定义的开源软件。个人学习、研究和非商业用途可依照 [PolyForm Noncommercial 1.0.0](./LICENSE) 使用；商业使用需要另行取得书面授权。

## 功能

- 在视频卡片上展示播放量、点赞、评论、分享、互动率、发布日期和时长。
- 支持播放量排序、日期筛选、自动滚动和视频多选。
- 支持单个或批量解析、下载视频。
- 导出 Excel 兼容的 CSV，可选择补全挂车商品名称、价格、店铺、评分、销量和链接。
- 视频预览、字幕读取与可选 AI 翻译。
- 可配置 OpenAI、DeepSeek、Kimi、通义千问、智谱 GLM、SenseNova 或自定义 OpenAI 兼容接口。
- 悬浮工具栏支持拖动、左右边缘吸附、隐藏恢复和位置记忆。

## 从源码安装

本仓库不发布可直接安装的 ZIP 或 Release 安装包。

1. 克隆仓库：

   ```bash
   git clone git@github.com:sujinjing/tiktok-creator-data-helper.git
   ```

2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择克隆后的 `tiktok-creator-data-helper` 目录。
6. 打开或刷新 TikTok 达人主页。

代码更新后，需要在 `chrome://extensions/` 中点击扩展的“重新加载”，并刷新已经打开的 TikTok 页面。

## AI 配置

AI 功能默认关闭，不配置也不影响数据扫描、导出和下载。

API Key 由用户在扩展弹窗中填写，并保存到浏览器的 `chrome.storage.local`。仓库不包含任何可用密钥。启用 AI、翻译或外部解析前，请阅读 [隐私说明](./PRIVACY.md)。

## 目录

```text
manifest.json       Chrome Extension Manifest V3 配置
content.js          页面数据解析、卡片浮层和悬浮工具栏
hook.js             TikTok 页面主世界网络数据监听
background.js       下载、跨域读取、商品解析和 AI 请求
popup/              扩展弹窗与 AI 配置界面
assets/             页面悬浮工具栏资源
vendor/             本地打包依赖
zipper.*            浏览器内批量打包页面
```

## 数据与安全

- 不包含运营方自建的数据收集后端或遥测代码。
- TikTok 视频数据主要在当前页面和扩展本地处理。
- AI 请求仅在用户启用并配置后发送到所选服务商。
- 外部解析兜底可能把公开的视频 ID 或链接发送给第三方解析服务。
- 请勿提交 API Key、账号 Cookie、抓包响应或真实业务数据。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 许可

Copyright 2026 su_jin.

本项目使用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。允许个人学习、研究、测试及其他非商业用途。商业部署、商业分发、付费服务或其他商业用途需要单独授权。

问题反馈可以通过 GitHub Issues 提交。提交 Pull Request 前，请先通过 Issue 说明用途和改动范围。

# Architecture

VideoLens AI 的 MVP 采用 Chrome MV3 插件结构，不需要前端构建工具。

## Modules

- Content Script：注入 YouTube / B 站页面，显示 `Ask AI` 按钮，获取视频信息、当前字幕上下文、相关字幕时间块和当前帧截图，并执行时间戳跳转。
- Side Panel：提供聊天 UI、快捷提问、设置、本地历史、视频级分层记忆和 Markdown 导出。通过统一接口获取视频上下文，不参与字幕与语音来源选择。
- Background Service Worker：打开侧边栏，通过统一视频文本接口处理字幕优先与语音回退，组合上下文与视频记忆，调用 OpenAI-compatible 模型服务，按批次生成滚动记忆摘要，并通过 Native Messaging 管理 VideoLens Bridge。
- VideoLens Bridge：扩展按需启动的本地宿主，内嵌授权、令牌刷新、协议翻译和模型路由能力；首次需要转写时自动准备独立运行环境并启动本机视频处理。
- Storage：使用 `chrome.storage.local` 保存设置、按视频隔离的问答记录、长期摘要和摘要覆盖记录 ID。厂商令牌不进入扩展存储。
- Video Text Service：字幕不能提供完整文本时，使用 yt-dlp 获取完整源音频，再用 faster-whisper 从 00:00 转写。任务及完整文本在本地服务中缓存，与当前播放位置及侧栏生命周期独立。扩展不再使用 tabCapture 或 Offscreen Audio。

模型路由保持两种方式：API 接入直接使用配置的 Base URL 和 API Key；订阅账号仅使用 Native Messaging 获取的本机 Bridge 凭证。`resolveSettings` 检查订阅账号及模型，`requestModelJSON` 统一发送问答、摘要和测试请求。两种路径不自动互相回退，也不混用密钥。详见 [模型接入](model-access.md)。

ChatGPT / Codex 模型通过 Native Messaging 的 `models.list` 从当前账号上游目录读取，不再采用 CPA 的内置套餐快照。目录按账号隔离缓存 5 分钟，手动刷新跳过缓存；可展示的文本模型同时登记到 SDK 模型注册表和调度器。注册表回调及推理前恢复可阻止令牌刷新把模型换回旧快照。图像生成、隐藏模型和非文本模型不进入问答菜单，令牌及上游内置提示词不进入扩展。

## Message Flow

```text
YouTube page
  -> content script
  -> side panel
  -> background worker
  -> configured AI provider
```

提问时，侧边栏先整理当前视频记忆，再调用 Background 的 `VIDEO_LENS_GET_VIDEO_CONTEXT` 收集当前视频上下文，最后把以下内容交给模型：

1. 当前视频长期摘要。
2. 从较早问答中检索到的相关记录。
3. 最近 6 轮原始问答。
4. 当前时间点字幕、相关字幕片段和可选当前帧。

较早问答每累计 3 轮触发一次滚动摘要，单次最多整理 8 轮。摘要失败时不会阻断当前提问，系统会继续使用相关旧问答和最近对话。

文本获取由 `ensureFullVideoText` 负责：完整字幕轨道 → 完整源音频转写任务。缓存保留全片，`getVideoTextContext` 先排除 `end > currentTime` 的文本，再按长度选取已播放范围的全文或窗口与相关片段，概览检索也受此限制。结果为 `textContext: { items, relatedItems, source, recordingStart: 0, complete: true, availableUntil }`；`complete` 表示整段记录已就绪，`availableUntil` 表示本次回答的文本截止时间。模型请求构建时再次检查普通与相关文本。source 只用于内部可靠性提示，不在聊天或导出笔记中展示。

问答的 `contextEnd` 和摘要的 `summaryThrough` 记录其可接触内容的截止时间；只有时间范围不超过当前播放位置的问答和摘要才能注入模型。缺少这些范围字段的旧记录继续显示，但不参与模型历史上下文。摘要遇到回退时，从符合范围的问答重建；不会删除原始问答。

`VIDEO_LENS_PREPARE_CONTEXT` 在助手打开时发起完整文本准备；`VIDEO_LENS_GET_VIDEO_CONTEXT` 在后台任务未完成时返回 pending，聊天侧等待完整记录就绪后才调用模型。取消本次等待或关闭侧栏不会取消后台任务。当前播放时间决定本次回答可用文本的截止位置和检索窗口，绝不作为音频起点发送给文本服务。详情见 [完整视频文本](video-text.md)。

没有完整字幕或文本缓存时，后台通过 Native Messaging 的 `text.config` 请求自动发现服务。Bridge 在环境准备期间立即返回 starting，不阻塞授权等消息；准备完成后返回固定本机端点 `127.0.0.1:18318/v1` 和独立凭证。扩展忽略旧版手动文本服务设置，凭证只在后台内存中使用，不进入视频页面或设置存储。

联网搜索在 Background 的 `prepareWebSearch` / `searchPublicWeb` 中执行：先通过已有聊天接口获取严格 JSON 查询计划，再从公开搜索页面或 MediaWiki 搜索 API 获取结果摘要，最后将经过校验的来源作为不可信外部数据加入回答请求。规划与回答都只读取播放位置之前的文本，不需要模型厂商专有的工具协议或额外搜索密钥。前端保留开关，安全渲染 HTTP(S) 引用和实际搜索结果列表，历史与 Markdown 导出保留来源。详情见 [联网搜索](web-search.md)。

## Account Authorization

账号模式使用 VideoLens 自有 Native Messaging 宿主：

```text
Side Panel
  -> Background Service Worker
  -> chrome.runtime.connectNative("com.videolens.bridge")
  -> VideoLens Bridge
  -> http://127.0.0.1:18317/v0/management/*
  -> Official OAuth page
  -> %LOCALAPPDATA%/VideoLens/Bridge/auths

Question
  -> http://127.0.0.1:18317/v1/chat/completions
  -> authorized Codex / Claude Code / Gemini CLI account
```

安全限制：

1. Bridge 由 Native Messaging 自动启动，只绑定 `127.0.0.1`，并使用每台机器独立生成的本地凭证。
2. GPT 授权页只允许 `auth.openai.com`。
3. Claude 授权页只允许 `claude.ai`。
4. Gemini 授权页只允许 `accounts.google.com`。
5. 三个账号渠道互斥；授权新渠道前和退出账号时删除 Bridge 凭证并终止当前宿主进程。
6. 视频页 content script 只接收字幕窗口和截图参数，不接收 API Key、Bridge 访问凭证或厂商令牌。

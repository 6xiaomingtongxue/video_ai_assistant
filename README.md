# VideoLens AI

VideoLens AI 是一个 Chrome MV3 插件原型，用于在观看 YouTube / B 站学习视频时直接向 AI 提问。它会在视频页注入 `Ask AI` 入口，并在浏览器侧边栏中提供聊天、快捷提问、视频上下文、当前帧截图、时间戳跳转和 Markdown 笔记导出。

## 当前能力

- YouTube / B 站视频页面识别与悬浮入口
- 获取视频标题、URL、当前播放时间和总时长
- 尝试读取 YouTube / B 站字幕轨道，截取当前上下文并检索其他相关时间片段
- 字幕轨道不可用时，回退捕获播放器中实际显示的 AI/自动字幕
- 通过统一的视频文本接口从 00:00 获取完整记录，自动读取整条字幕或在后台转写完整源音频
- 用户主动提问时按需截取当前视频帧
- 自动获取视频文本，并根据模型能力和设置附加当前画面，无需选择文本来源或上下文模式
- OpenAI-compatible `/chat/completions` 模型调用
- 两种模型访问方式：Base URL + API Key（DeepSeek / 中转站 / 本地服务）与自己的订阅账号
- 支持 GPT / Codex、Claude / Claude Code、Gemini / Gemini CLI OAuth 授权与模型刷新
- 按视频保存问答记录，并使用“最近 6 轮 + 长期摘要 + 相关旧问答”的分层记忆
- 点击回答里的 `mm:ss` / `hh:mm:ss` 时间戳跳回视频
- 导出 Markdown 学习笔记

## 本地加载

1. 打开 Chrome 的 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库的 `extension/` 目录。
5. 打开 YouTube 或 B 站视频页，点击页面中的 `Ask AI` 或扩展图标。

## 模型配置

侧边栏右上角设置支持两种访问方式。

API 接入：

- `API Key`
- `Base URL`，默认 `https://api.openai.com/v1`
- `模型名称`
- 是否支持图像输入
- 可快速填写 DeepSeek 等服务配置、获取模型列表，也可手动填写模型 ID
- “测试所选模型”通过实际小请求验证调用，不依赖服务是否实现模型列表接口

订阅账号：

- 安装 VideoLens Bridge，本地服务由扩展按需自动启动
- GPT / Codex、Claude / Claude Code 或 Gemini / Gemini CLI 授权账号
- 授权后自动刷新并选择当前渠道模型
- 三个账号渠道互斥；切换或退出时清理旧渠道的本地授权信息
- 调用前检查当前账号与所选模型；支持提交本次授权的本机回调地址

两条路径独立保存配置，聊天和长期摘要共用所选路由，不自动跨方式切换。详细设置和参考实现见 [`docs/model-access.md`](docs/model-access.md)。

账号授权通过 VideoLens 自有的 Native Messaging 宿主完成。扩展不会读取 ChatGPT、Claude 或 Google 网页 Cookie，也不会保存厂商访问令牌；令牌只保存在 `%LOCALAPPDATA%\VideoLens\Bridge\auths`。Bridge 仅绑定 `127.0.0.1:18317`，每台机器会生成独立的本地访问凭证。

本地开发安装：

```powershell
npm run bridge:build
npm run bridge:install
```

安装后重新加载扩展。开发版 Manifest 固定了扩展 ID；Chrome 商店发布时，安装程序必须使用商店分配的扩展 ID 注册 Native Messaging 宿主。最终用户不需要安装、配置或启动 CLIProxyAPI。

聊天模型每次接收截至当前播放位置的视频文本、符合该时间范围的最近 6 轮问答、长期记忆摘要和相关旧问答，以及用户启用时的当前帧图像。已播放部分文本较短时全部发送，较长时只在已播放范围内选择窗口和相关片段；总结也只覆盖已播放部分。整段视频仍会识别并缓存。

点击发送时先锁定视频时间和画面，等待期间继续播放或拖动进度不会改变本次问题的上下文。没有完整字幕时，只需识别进度覆盖该提问时间点，就能先回答；后台仍从 00:00 继续完成整段转写和完整缓存。首次使用仍需准备环境、下载识别模型和源音频。

长课程会在已播放文本上建立分块索引，组合当前讲解、相关早期原文与全局线索，而不必每次发送一两小时全文。支持按课程术语、`10:00`、`第10分钟` 或 `10分钟前` 找回内容；此前没有问过的知识点也能检索。索引在本地从缓存构建，不增加模型调用，原有聊天摘要继续保留。详见 [长课程记忆](docs/course-memory.md)。

输入框下方可开关“联网搜索”。默认按需检索外部知识，回答附可点击来源，来源随历史保存并可导出；无需另配搜索密钥，视频防剧透范围继续生效。搜索使用结果摘要，服务不可用时会明确提示。详见 [联网搜索说明](docs/web-search.md)。

回答由统一运行框架管理：常见片段解释跳过搜索规划，只调用一次模型；需要搜索时最多一次规划、两个查询、一次回答。回答阶段设有总时限，生成期间可点击“停止回答”。脱敏轨迹和离线回放评测用于检查调用预算、取消与防剧透，详见 [Harness 说明](docs/question-harness.md)。

调用预算按每次提问重新计算，不限制同一视频的提问次数，长课程也按相同的单次预算处理。长期对话摘要的额外模型调用单独计算，课程原文索引不调用模型。

无论视频播放到哪里才打开助手，后台都从 00:00 获取整段视频文本。有完整字幕时直接缓存全文；没有完整字幕时，VideoLens Bridge 自动准备运行环境并启动本机处理，用 yt-dlp 获取完整音频，再用 faster-whisper 从头转写。无需填写服务地址、密钥、识别模型或安装 Docker，API 和订阅账号两种模式均可使用。首次使用会下载运行环境和识别模型，后续复用本地缓存。处理不改变视频播放位置，关闭助手后任务和完整记录仍保留。使用方法见 [`docs/video-text.md`](docs/video-text.md)。

当较早问答累计 3 轮时，插件会使用同一个模型服务执行一次滚动摘要，单次最多整理 8 轮。这会产生额外模型调用，但避免每次重复发送完整历史。

## 开发验证

扩展本身没有前端构建步骤。可运行：

```bash
npm run validate
npm test
npm run test:course-memory
npm run eval:harness
```

`validate` 会检查 Manifest、扩展文件和主要 JavaScript 语法；`test` 会验证长期记忆、长课程检索、旧问答检索、字幕检索、账号授权、语音转文字回退、回答预算、停止回答与离线场景回放。`test:course-memory` 可单独检查 1/2/12 小时模拟课程文本，`eval:harness` 可单独运行 15 个固定场景；它们不调用真实模型或网络，也不代表回答质量评分。

## Windows 发布

生成 Chrome Web Store 扩展 ZIP 和 Windows Bridge ZIP：

```powershell
npm run release:windows
```

商店版必须使用 Chrome Web Store 实际分配的扩展 ID 打包 Bridge。完整安装方式、安全检查和代码签名要求见 [`docs/release.md`](docs/release.md)。

## 仓库结构

```text
extension/
  manifest.json
  src/
    background/
      service_worker.js
      question_harness.mjs
      course_memory.mjs
    content/
    sidepanel/
bridge/
  main.go
scripts/
  build-bridge.ps1
  install-bridge.ps1
  uninstall-bridge.ps1
  test-account-auth.mjs
  test-memory.mjs
  test-course-memory.mjs
  test-question-harness.mjs
  test-answer-cancellation.mjs
  eval-question-harness.mjs
  evals/
  helpers/
  validate-extension.mjs
docs/
  question-harness.md
  course-memory.md
video_ai_assistant_requirements.md
```

## 说明

这是按需求文档落地的 MVP 原型。YouTube 字幕接口和视频帧截图可能受平台页面结构、字幕公开状态、浏览器安全策略或 DRM 限制影响；失败时侧边栏会显示明确提示，并尽量退化到可用的字幕问答模式。

# Contributing

本项目由 Chrome MV3 扩展和 VideoLens Bridge 组成。提交改动时请优先保持模块边界清晰：

- `extension/src/content/` 负责页面注入、视频信息、字幕、截图和跳转。
- `extension/src/background/` 负责插件 API、侧边栏打开和模型服务调用。
- `extension/src/sidepanel/` 负责聊天 UI、设置、本地历史和导出。
- `bridge/` 负责 Native Messaging 生命周期、本地授权凭证和模型代理。
- `speech/` 负责完整源音频获取、从 00:00 转写、任务去重和文本缓存；不要把文本服务凭证交给视频页面。

提交前运行：

```bash
npm run validate
npm test
npm run test:speech-service
npm run bridge:build
```

新增平台时，建议把平台差异限制在 content 层的适配函数中，并保持返回数据结构与需求文档中的 `VideoInfo`、`TranscriptItem`、`FrameSnapshot` 一致。

# Adapter Development

当前 MVP 的平台适配逻辑位于 `extension/src/content/content_script.js`。

新增平台时建议实现以下能力：

- 页面匹配与视频元素识别
- 标题、URL、当前时间、总时长获取
- 字幕轨道发现和解析
- 当前帧截图
- 跳转到指定秒数

统一返回结构应保持：

```ts
interface VideoInfo {
  title: string;
  url: string;
  currentTime: number;
  duration?: number | null;
  platform: string;
}

interface TranscriptItem {
  start: number;
  end: number;
  text: string;
}

interface FrameSnapshot {
  timestamp: number;
  imageDataUrl: string;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  capturedAt: string;
}
```

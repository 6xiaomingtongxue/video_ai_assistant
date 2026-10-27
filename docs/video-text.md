# 从 00:00 获取完整视频文本

不论在视频哪个时间点打开 VideoLens，文本记录都以视频源的 `00:00` 为起点，而不是以打开助手的时刻为起点。

## 获取流程

1. 存在完整字幕轨道时，直接读取并缓存整条字幕。
2. 没有完整字幕时，通过 VideoLens Bridge 自动准备运行环境并启动本机视频文本服务，再提交视频链接。
3. 服务使用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 获取完整源音频，再使用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 从头转写，保存带视频时间戳的文本。
4. 转写与播放器独立，不改变当前播放位置；暂停、跳转或关闭助手不影响后台任务。
5. 点击发送时先锁定时间点和画面，再等待识别进度覆盖该时间点，不必等全片转写完成。只将 `00:00` 到提问时刻的文本发送给聊天模型；后台继续完成整段转写和缓存。该范围内文本较短时全部发送；较长时选取提问位置之前的窗口和相关片段。概览或“总结整个视频”也只总结截至提问时刻的部分。

提问快照独立于字幕获取、下载环境和转写等待。继续播放、暂停或拖动进度都不会改变已经发出的这个问题的时间和截图；再次提问会创建新快照。切换视频会取消原问题，关闭助手或取消等待不会取消已经提交的后台转写任务。截图无法取得时保留原提问时间，使用文字回答，不改用后来画面。

整段识别和完整缓存始终保留，继续播放会解锁后续文本，回退播放则重新按较早位置筛选，不重复下载或识别。字幕和识别结果只有片段级时间戳，因此跨过当前播放位置的片段暂不发送，等该片段播放结束后再纳入。

历史问答和滚动摘要同样受本次播放位置限制，避免回退后从历史中带入后续内容。旧版本问答及摘要缺少可靠的文本范围记录，仍可在界面查看，但不再自动发给模型；新记录保存 `contextEnd`，新摘要保存 `summaryThrough`，用于范围检查。模型提示词要求不透露或猜测后续视频内容。

聊天界面不提供字幕或语音来源选择，也不展示来源标签。等待时显示目标提问时刻及准备进度，用户可以取消本次等待；后台任务仍会完成并缓存结果。

## 自动准备

安装或更新 VideoLens Bridge 后，重新加载扩展并刷新视频页面即可。设置页不再提供视频文本服务地址、API Key、模型或语言输入；服务地址和独立密钥由 Bridge 自动发现，默认识别模型为 `Systran/faster-whisper-small`，语言自动识别。旧版手动填写的配置不再使用。

API 接入和订阅账号模式共用这套流程。存在完整字幕或已缓存的完整文本时，不启动本机处理。首次需要转写时，Bridge 在自己的数据目录中自动准备独立 Python、Node.js 和识别依赖；第一次处理视频时下载识别模型。之后复用环境和模型，无需安装 Docker、修改系统 PATH 或执行启动命令。首次准备期间助手显示进度，可取消本次等待。

本机服务仅绑定 `127.0.0.1:18318`，使用独立凭证保护。环境、模型和文本保存在 `%LOCALAPPDATA%\VideoLens\Bridge\text-service`；安装过程记录在 `setup.log`，服务记录在 `service.log`。下载或启动失败会显示错误，恢复网络后可重试；更新安装保留已下载的环境、账号凭证和完整文本。

识别依赖限制 PyAV 为 `>=11,<19`，避免 faster-whisper 1.2.x 与 PyAV 19 的音频解码接口不兼容。安装过程实际解码一段测试音频，通过后才标记环境就绪。更新依赖时自动修复已有环境，保留识别模型缓存。

运行时通过 [uv](https://docs.astral.sh/uv/guides/install-python/) 管理独立 Python，JavaScript 运行时来自 [Node.js 官方发布目录](https://nodejs.org/download/release/latest-v22.x/)。下载的 uv 和 Node.js 压缩包在解压前校验官方 SHA-256。

## 开发调试时独立运行

以下方式供开发调试服务接口使用；扩展正常使用由 Bridge 自动启动的服务，不读取这些开发地址。

已安装并启动 Docker Desktop 时，在项目根目录执行：

```powershell
npm run speech:up
```

该命令构建并启动 `speech/` 服务，内含 yt-dlp、faster-whisper、FFmpeg 和 YouTube 提取所需的 Node.js 运行时。服务仅暴露到本机 `127.0.0.1:8000`。首次启动需要下载镜像和依赖；第一次处理视频时会自动下载模型。

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

响应应包含 `wholeVideoText: true`。旧版仅提供 `/audio/transcriptions` 的 Speaches 服务不支持完整视频任务，需要改用本项目服务，或实现下述兼容接口。

没有 Docker 时也可使用 Python 3.10+，并安装 FFmpeg 和 Node.js 22+（参见 [yt-dlp 的运行时要求](https://github.com/yt-dlp/yt-dlp/wiki/EJS)）：

```powershell
python -m venv .tmp\speech-env
.tmp\speech-env\Scripts\python -m pip install -r speech\requirements.txt
.tmp\speech-env\Scripts\python speech\server.py
```

本地 Python 方式默认将模型和文本缓存保存在当前目录的 `data/`，可通过环境变量 `VIDEOLENS_TEXT_DATA` 修改目录。Docker 方式保存在 `text-data` 命名卷中。

独立调试默认使用 `http://127.0.0.1:8000/v1`，可通过 `VIDEOLENS_API_KEY` 启用 Bearer 认证；启用后健康检查也需要同一凭证。视频处于第 10 分钟、拖到结尾或暂停，都不会影响文本从头获取。

停止服务（保留已完成文本和模型缓存）：

```powershell
npm run speech:down
```

## 服务接口

`POST /v1/video-transcriptions`

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID&t=600",
  "model": "Systran/faster-whisper-small",
  "language": "zh"
}
```

服务规范化 URL 时删除起播时间，B 站保留分 P 参数。响应包含 `id`、`status`、`recordingStart: 0`、`duration`、`processedUntil` 和 `segments`。首次创建返回 HTTP 202；命中完整缓存可返回 HTTP 200。

通过 `GET /v1/video-transcriptions/{id}` 查询状态。状态为 `queued`、`downloading`、`transcribing`、`completed` 或 `failed`。默认 GET 仍只有 `completed` 返回文本；增加 `?partial=1` 可读取按时间顺序生成的已处理片段，POST 创建或复用任务时也可返回已处理片段。健康检查同时声明 `wholeVideoText: true` 和 `progressiveText: true`，Bridge 会核对两种能力。

扩展在任务完成，或 `processedUntil` 已覆盖固定的提问时间时开始回答；只发送结束时间不超过提问时刻的片段。未完成任务的 `textContext.complete` 为 false，不会被写入浏览器完整文本存档。后台仍执行同一项整段任务，完成后服务缓存全片文本；后续问题可以复用，任务不按提问时间拆分或重复下载。

失败结果包含 `failedStage`、`errorCode` 和固定的安全提示 `error`，区分音频下载、解码组件兼容性及识别失败。扩展按已知错误码显示提示，不展示底层异常中的地址或凭证；再次提问会重试失败任务。

服务串行处理转写，最多接受 5 个未完成任务。已完成结果保存到磁盘，服务重启后可以复用；未完成任务重启后从 00:00 重新处理。

## 数据与限制

- 浏览器不再采集标签页音频或请求麦克风；不依赖打开助手之前的浏览器录音。
- 服务仅接受 YouTube 和 B 站视频地址。它使用当前环境可正常获取的源音频，不读取浏览器 Cookie，不绕过付费、登录或 DRM 访问限制。平台要求登录或拒绝下载时会报错。
- 临时音频在任务结束或失败后删除；完整文本和模型保留在本地缓存。扩展自动流程只连接自己的本机服务。
- Chrome 扩展缓存最近若干条完整文本，限制其存储占用；不会通过截断一条视频文本来适配缓存。超出浏览器缓存预算的转写结果仍可从本地服务重新读取。
- 录播视频最长支持 12 小时，下载文件最大 1 GiB；不支持直播或尚未开始的视频。首次下载模型和处理长视频可能需要较长时间。
- 语音识别可能有误。内部提示词保留可靠性信息，聊天界面不显示获取来源。
- “获取整段视频文本”不等于每次向聊天模型发送任意长度的全文；长视频在完整记录上做检索，以控制模型上下文长度。

## 验证

```powershell
npm run validate
npm test
npm run test:speech-service
```

测试覆盖：中途打开仍保留全片缓存、任务请求不带时间偏移、转写中读取已处理部分、处理到提问时刻即可回答、后台继续至结尾、快照早于字幕与模型准备、截图解码延迟不改变时间、长视频早期内容检索、等待与取消、视频切换、服务重启缓存、URL 与模型校验、任务去重、时间戳、认证、临时音频清理和错误结果。

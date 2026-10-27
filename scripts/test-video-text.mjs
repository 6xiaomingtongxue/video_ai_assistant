import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (name) => fs.readFileSync(path.join(process.cwd(), "extension/src", name), "utf8");
const info = { url: "https://www.youtube.com/watch?v=abcdefghijk&t=600", videoKey: "abcdefghijk", platform: "youtube", currentTime: 600, duration: 900 };
const fullItems = [
  { start: 0, end: 8, text: "课程从梯度下降的定义开始。" },
  { start: 590, end: 610, text: "当前片段讨论学习率。" },
  { start: 890, end: 900, text: "最后总结优化方法。" }
];
const storage = {};
const network = [];
const pageRequests = [];
let native = true;
let jobStatus = "queued";
let jobStart = 0;
let missingJob = false;
let serviceFailure = false;
let runtimeReady = true;
let nativeFailure = "";
let jobErrorCode = "";
const nativeRequests = [];
const event = () => ({ addListener() {} });
const background = vm.createContext({
  URL, AbortController, setTimeout, clearTimeout, console,
  fetch: async (url, options) => {
    network.push({ url, options });
    if (serviceFailure) return { ok: false, status: 503 };
    if (missingJob && options.method === "GET") { missingJob = false; return { ok: false, status: 404 }; }
    return { ok: true, status: 200, json: async () => ({
      id: "a".repeat(64), status: jobStatus, recordingStart: jobStart,
      errorCode: jobErrorCode, error: "private-upstream-token",
      processedUntil: jobStatus === "completed" ? 900 : 30, duration: 900,
      segments: jobStatus === "completed" ? fullItems : []
    }) };
  },
  chrome: {
    runtime: {
      getURL: (name) => `chrome-extension://test/${name}`, onInstalled: event(), onMessage: event(),
      connectNative(name) {
        assert.equal(name, "com.videolens.bridge");
        let receive;
        return {
          onMessage: { addListener(callback) { receive = callback; } }, onDisconnect: event(),
          postMessage(message) {
            nativeRequests.push(message);
            queueMicrotask(() => receive(nativeFailure
              ? { id: message.id, ok: false, error: nativeFailure }
              : { id: message.id, ok: true, data: runtimeReady
                ? { status: "ready", baseUrl: "http://127.0.0.1:18318/v1", apiKey: "automatic-text-key", model: "Systran/faster-whisper-small" }
                : { status: "starting" } }));
          }
        };
      }
    },
    action: { onClicked: event() }, commands: { onCommand: event() },
    storage: { local: {
      get(key, callback) { callback({ [key]: storage[key] }); },
      set(value, callback) { Object.assign(storage, structuredClone(value)); callback(); }
    } },
    tabs: { async sendMessage(tabId, message) {
      pageRequests.push(message);
      return { ok: true, data: {
        videoInfo: { ...info }, transcriptContext: native ? [fullItems[1]] : [], relatedTranscriptContext: [],
        ...(native && message.payload?.includeFullText ? { fullTextTrack: { complete: true, items: fullItems } } : {}),
        frameSnapshot: message.payload?.contextMode === "transcript-and-frame" ? { imageDataUrl: "data:image/jpeg;base64,test" } : null,
        warnings: native ? [] : ["字幕获取失败"]
      } };
    } }
  }
});
vm.runInContext(read("background/service_worker.js"), background);
const panel = { url: "chrome-extension://test/src/sidepanel/index.html?embedded=1" };
const settings = { speechToText: { baseUrl: "https://old-manual-service.example/v1", apiKey: "text-service-key" }, aiProvider: { apiKey: "chat-secret" } };

await background.prepareVideoContext(7, settings);
let context = await background.getVideoContext(7, "整个视频讲了什么？", settings);
assert.equal(network.length, 0, "full native text must not start a speech job");
assert.equal(nativeRequests.length, 0, "subtitles must not need a local runtime or Bridge");
assert.equal(context.textContext.recordingStart, 0);
assert.equal(context.textContext.complete, true);
assert.equal(context.textContext.items[0].start, 0, "opening at 10:00 must still include the opening");
assert.equal(context.textContext.items.at(-1).end, 8, "a segment crossing 10:00 must not leak later words");
assert.equal(context.textContext.availableUntil, 600);
assert.ok(!JSON.stringify(pageRequests).includes("text-service-key"));
assert.ok(!JSON.stringify(pageRequests).includes("chat-secret"));
await vm.runInContext("textArchiveWrite", background);
assert.equal(storage["videolens:textArchive"]["youtube:abcdefghijk"].items[0].start, 0);
assert.equal(storage["videolens:textArchive"]["youtube:abcdefghijk"].items.at(-1).end, 900,
  "the archive must retain the entire video even when answering earlier");

native = false;
info.videoKey = "newvideo001";
info.url = "https://www.youtube.com/watch?v=newvideo001&t=600";
runtimeReady = false;
context = await background.getVideoContext(7, "解释", settings);
assert.equal(context.pending, true);
assert.equal(context.preparation, "runtime");
assert.equal(network.length, 0, "wait for automatic setup before submitting a job");
runtimeReady = true;
await background.prepareVideoContext(7, settings);
const body = JSON.parse(network[0].options.body);
assert.deepEqual(Object.keys(body).sort(), ["language", "model", "url"]);
assert.equal(body.url, info.url, "currentTime is not sent as a seek/start offset");
assert.equal(network[0].options.headers.Authorization, "Bearer automatic-text-key");
assert.match(network[0].url, /^http:\/\/127\.0\.0\.1:18318\/v1\//);
assert.equal(body.language, "", "language is detected automatically");
assert.equal(network[0].options.credentials, "omit");
assert.equal(network[0].options.redirect, "error");
context = await background.getVideoContext(7, "解释当前片段", settings);
assert.equal(context.pending, true);
assert.ok(!context.textContext, "partial text must not masquerade as a complete recording");
jobStatus = "completed";
context = await background.getVideoContext(7, "解释开头的定义", settings);
assert.equal(context.textContext.items[0].start, 0);
assert.equal(context.textContext.items.at(-1).end, 8);
assert.equal(context.warnings.length, 0);
const completedContext = context;
const callsBeforeRelease = network.length;
const bridgeCallsBeforeRelease = nativeRequests.length;
await background.releaseVideoContext(7);
await background.getVideoContext(7, "再解释", settings);
assert.equal(network.length, callsBeforeRelease, "closing the panel must retain complete text");
assert.equal(nativeRequests.length, bridgeCallsBeforeRelease, "cached full text works without starting Bridge");
info.currentTime = 900;
const endingContext = await background.getVideoContext(7, "总结", settings);
assert.equal(endingContext.textContext.items.at(-1).end, 900, "later playback unlocks cached text");
info.currentTime = 600;
const rewoundContext = await background.getVideoContext(7, "总结", settings);
assert.equal(rewoundContext.textContext.items.at(-1).end, 8, "rewinding restores the earlier cutoff");
assert.equal(network.length, callsBeforeRelease, "changing playback time must reuse the full cache");
await vm.runInContext("textArchiveWrite", background);
assert.equal(storage["videolens:textArchive"]["youtube:newvideo001"].items.at(-1).end, 900);
assert.ok(!JSON.stringify(storage).includes("automatic-text-key"));
assert.ok(!background.mergeSettings(settings).speechToText, "retire stored manual service configuration");
assert.equal(background.mergeSettings({ contextAfterSeconds: 300 }).contextAfterSeconds, 0,
  "old forward-window settings must not enable future context");
nativeFailure = "unsupported native message type";
await assert.rejects(background.getWholeVideoService(), /更新 VideoLens Bridge/);
nativeFailure = "Specified native messaging host not found";
await assert.rejects(background.getWholeVideoService(), /安装 VideoLens Bridge/);
nativeFailure = "";

const longItems = Array.from({ length: 200 }, (_, index) => ({
  start: index * 30, end: index * 30 + 29,
  text: index === 0 ? "开头介绍对比学习。".repeat(20) : `第${index}段课程内容。`.repeat(20)
}));
const record = { items: longItems, source: "speech-to-text", duration: 6000 };
const windowSettings = { contextBeforeSeconds: 60, contextAfterSeconds: 30 };
const selected = background.getVideoTextContext(record, 5500, "开头的对比学习是什么？", windowSettings);
assert.ok(selected.relatedItems.some((item) => item.start === 0));
assert.ok(selected.items.some((item) => item.start >= 5400));
assert.ok([...selected.items, ...selected.relatedItems].every((item) => item.end <= 5500));
const overview = background.getVideoTextContext(record, 5500, "总结整个视频", windowSettings);
assert.ok(overview.relatedItems.some((item) => item.start === 0));
assert.ok(overview.relatedItems.some((item) => item.end >= 5300));
assert.ok([...overview.items, ...overview.relatedItems].every((item) => item.end <= 5500),
  "whole-video questions must summarize only the played prefix");
assert.equal(record.items.at(-1).end, 5999, "selection must not mutate the complete record");
const earlyPrefix = background.getVideoTextContext(record, 120, "总结", windowSettings);
assert.equal(earlyPrefix.items.length, 4, "a short played prefix is sent in full even for a long video");
for (const cutoff of [0, -10, NaN, Infinity]) {
  assert.equal(background.getVideoTextContext(record, cutoff, "总结", windowSettings).items.length, 0);
}
const boundaries = background.getVideoTextContext({ items: [
  { start: 1, end: 10, text: "已经播放" },
  { start: 10, end: 11, text: "尚未播放" },
  { start: 10, end: 10, text: "刚开始的零长度片段" },
  { start: 9, end: 12, text: "横跨边界" }
] }, 10, "解释", windowSettings);
assert.equal(boundaries.items.length, 1);
assert.equal(boundaries.items[0].text, "已经播放");

info.videoKey = "restart0001";
info.url = "https://www.youtube.com/watch?v=restart0001";
jobStatus = "transcribing";
await background.prepareVideoContext(7, settings);
missingJob = true;
const previousPosts = network.filter((item) => item.options.method === "POST").length;
await background.getVideoContext(7, "解释", settings);
assert.equal(network.filter((item) => item.options.method === "POST").length, previousPosts + 1);
jobStart = 600;
await assert.rejects(background.getVideoContext(7, "解释", settings), /00:00/);
jobStart = 0;
serviceFailure = true;
await assert.rejects(background.getVideoContext(7, "解释", settings), /503/);
serviceFailure = false;
jobStatus = "failed";
jobErrorCode = "audio_decoder_incompatible";
await assert.rejects(background.getVideoContext(7, "解释", settings), /音频解码组件版本不兼容/);
const postsBeforeRetry = network.filter((item) => item.options.method === "POST").length;
jobStatus = "queued";
await background.getVideoContext(7, "重试", settings);
assert.equal(network.filter((item) => item.options.method === "POST").length, postsBeforeRetry + 1,
  "a failed cached job must be resubmitted on retry");
jobStatus = "failed";
jobErrorCode = "unknown-upstream-code";
await assert.rejects(background.getVideoContext(7, "解释", settings), (error) => {
  assert.match(error.message, /完整视频内容获取失败/);
  assert.ok(!error.message.includes("private-upstream-token"));
  return true;
});
await assert.rejects(background.handleVideoContextMessage({ type: "VIDEO_LENS_GET_VIDEO_CONTEXT", tabId: 7 }, { url: "https://www.youtube.com" }), /侧栏/);

const sidepanel = vm.createContext({
  URL, console, structuredClone, document: { addEventListener() {} },
  window: { setTimeout(callback) { queueMicrotask(callback); } }
});
vm.runInContext(read("sidepanel/sidepanel.js"), sidepanel);
assert.equal(sidepanel.mergeSettings({ contextAfterSeconds: 300 }).contextAfterSeconds, 0);
const panelRequests = [];
let pendingOnce = true;
sidepanel.mockSend = async (request) => {
  panelRequests.push(request);
  if (request.type === "VIDEO_LENS_GET_VIDEO_CONTEXT") {
    if (pendingOnce) { pendingOnce = false; return { pending: true, videoInfo: info, processedUntil: 300, duration: 900 }; }
    return completedContext;
  }
  if (request.type === "VIDEO_LENS_ASK_AI") return { answer: "完整视频的回答" };
  throw new Error(`Unexpected request: ${request.type}`);
};
vm.runInContext(`
  renderModeState = () => {}; renderChat = () => {}; render = () => {};
  showToast = () => {}; sendRuntime = mockSend; assertActiveRequestSession = () => {};
  prepareVideoMemory = async () => ({}); persistCurrentSession = async () => {}; createId = () => 'record';
  dom.questionInput = {value: ''}; state.targetTabId = 7;
`, sidepanel);
await sidepanel.sendQuestion("解释视频开头");
assert.equal(panelRequests.filter((request) => request.type === "VIDEO_LENS_GET_VIDEO_CONTEXT").length, 2);
assert.equal(panelRequests.filter((request) => request.type === "VIDEO_LENS_ASK_AI").length, 1);
assert.equal(vm.runInContext("state.records[0].textContext.items[0].start", sidepanel), 0);
assert.equal(vm.runInContext("state.records[0].contextEnd", sidepanel), 600);
sidepanel.mockCancel = async () => {
  vm.runInContext("state.cancelContextRequest = true", sidepanel);
  return { pending: true, videoInfo: info };
};
vm.runInContext("sendRuntime = mockCancel", sidepanel);
await assert.rejects(sidepanel.getCompleteVideoContext("解释", "session"), /已取消/);
assert.equal(vm.runInContext("state.waitingForVideoText", sidepanel), false);
const html = read("sidepanel/index.html");
assert.ok(!/audioCaptureButton|modeBadge|name="contextMode"/.test(html));
assert.ok(!/speechBaseUrlInput|speechApiKeyInput|speechModelInput|speechLanguageInput|高级：视频文本服务/.test(html));
assert.ok(!/afterInput|向后上下文秒数/.test(html));
console.log("Complete-video text tests passed.");

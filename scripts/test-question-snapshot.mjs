import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadContent(options = {}) {
  const video = { currentTime: 12, duration: 1800, paused: false, seeking: false, playbackRate: 1,
    readyState: 4, videoWidth: 640, videoHeight: 360,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 360 }) };
  const location = { href: "https://www.youtube.com/watch?v=snapshot001", hostname: "www.youtube.com" };
  const captures = [], requests = [];
  let now = 0, networkCalls = 0;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class TestImage {
    naturalWidth = 1280;
    naturalHeight = 720;
    set src(value) {
      queueMicrotask(() => {
        now += 5000;
        video.currentTime = 17; // Image decoding takes time while playback continues.
        if (options.switchVideo) location.href = "https://www.youtube.com/watch?v=switched001";
        this.onload();
      });
    }
  }
  const content = vm.createContext({ URL, console, Date: TestDate, queueMicrotask, Image: TestImage, location,
    window: { innerWidth: 1280, innerHeight: 720 },
    fetch: async () => { networkCalls++; throw new Error("Snapshot must not request subtitles"); },
    document: { title: "Snapshot test - YouTube", querySelector: () => null, querySelectorAll: selector => selector === "video" ? [video] : [],
      createElement(tag) {
        assert.equal(tag, "canvas");
        let kind = "";
        return { getContext() { return { drawImage(source) { kind = source === video ? "video" : "screen";
          captures.push({ kind, time: video.currentTime }); } }; },
          toDataURL() {
            if (kind === "video" && (options.screenFallback || options.failFrame)) throw new Error("Tainted canvas");
            return `data:image/jpeg;base64,${kind}-at12`;
          } };
      } },
    chrome: { runtime: { sendMessage(message, callback) {
      requests.push(message);
      callback(options.failFrame ? { ok: false, error: { message: "Screenshot unavailable" } }
        : { ok: true, data: { imageDataUrl: "data:image/jpeg;base64,screen-at12", capturedAt: new TestDate().toISOString() } });
    } } }
  });
  const source = fs.readFileSync("extension/src/content/content_script.js", "utf8")
    .replace("\n  init();\n", "\n")
    .replace(/\n\}\)\(\);\s*$/, "\n globalThis.snapshotTest = { collectContext };\n})();");
  vm.runInContext(source, content);
  return { video, captures, requests, networkCalls: () => networkCalls,
    capture: mode => content.snapshotTest.collectContext({ snapshotOnly: true, contextMode: mode || "transcript-and-frame", settings: {} }) };
}

{
  const content = loadContent();
  const snapshot = await content.capture();
  content.video.currentTime = 600;
  assert.equal(snapshot.snapshotOnly, true);
  assert.equal(snapshot.videoInfo.currentTime, 12);
  assert.equal(snapshot.frameSnapshot.timestamp, 12);
  assert.equal(snapshot.frameSnapshot.imageDataUrl, "data:image/jpeg;base64,video-at12");
  assert.equal(content.captures.length, 1);
  assert.equal(content.networkCalls(), 0, "capture must happen before any subtitle/network work");
}
{
  const content = loadContent({ screenFallback: true });
  const snapshot = await content.capture();
  assert.equal(content.video.currentTime, 17);
  assert.equal(snapshot.videoInfo.currentTime, 12, "decoding a screenshot must not move the frozen video time");
  assert.equal(snapshot.frameSnapshot.timestamp, 12);
  assert.equal(snapshot.frameSnapshot.imageDataUrl, "data:image/jpeg;base64,screen-at12");
  assert.equal(content.requests.length, 1);
  assert.equal(content.networkCalls(), 0);
}
{
  const content = loadContent({ failFrame: true });
  const snapshot = await content.capture();
  assert.equal(snapshot.videoInfo.currentTime, 12);
  assert.equal(snapshot.frameSnapshot, null);
  assert.equal(snapshot.warnings.length, 1);
}
{
  const content = loadContent();
  const snapshot = await content.capture("transcript-only");
  assert.equal(snapshot.frameSnapshot, null);
  assert.equal(snapshot.videoInfo.currentTime, 12);
  assert.equal(content.captures.length, 0);
}
{
  const content = loadContent({ screenFallback: true, switchVideo: true });
  await assert.rejects(content.capture(), /视频已切换/);
}
console.log("Question snapshot timing, fallback, video switch and capture-order tests passed.");

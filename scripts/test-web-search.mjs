import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { evaluateBackground } from "./helpers/background-vm.mjs";

const bing = `<ol><li class="b_algo"><h2><a href="https://docs.example.com/gradient">Gradient descent documentation</a></h2>
<p>Gradient descent uses a learning rate. &amp; Symbols are preserved.</p></li></ol>`;
const wiki = JSON.stringify({ query: { search: [{ title: "Gradient descent", snippet: "An optimization method" }] } });
const completion = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({
  model: "test-model", choices: [{ message: { content } }]
}) });
const event = () => ({ addListener() {} });
const videoContext = { videoInfo: { currentTime: 100, title: "private-video-title",
  platform: "bilibili", url: "https://www.bilibili.com/video/BV1private" }, textContext: { complete: true, items: [
  { start: 0, end: 20, text: "gradient descent introduction" },
  { start: 90, end: 110, text: "crossing-video-secret" },
  { start: 150, end: 160, text: "future-video-secret" }
] } };

function loadBackground(options = {}) {
  const network = [], modelRequests = [];
  const background = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, atob, console,
    fetch: async (url, request) => {
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(request.body);
        modelRequests.push(body);
        const isPlan = body.messages[0].content.includes("仅输出 JSON");
        return completion(isPlan ? options.plan ?? '{"search":true,"queries":["gradient descent"]}'
          : "视频讲解采用了梯度下降。[参考资料](https://docs.example.com/gradient)");
      }
      network.push({ url, request });
      const page = options.fail ? "" : url.includes("wikipedia.org") ? wiki : options.fallback ? "" : bing;
      return { ok: true, status: options.fail ? 503 : 200, headers: { get() { return null; } }, text: async () => page };
    },
    chrome: { runtime: { getURL: value => `chrome-extension://test/${value}`, onInstalled: event(), onMessage: event() },
      action: { onClicked: event() }, commands: { onCommand: event() } }
  });
  evaluateBackground(background);
  if (options.account) {
    background.testResolvedSettings = { authMode: "account", enableWebSearch: true, language: "zh-CN",
      aiProvider: { accessMode: "account", apiKey: "private-account-key", baseUrl: "http://127.0.0.1:18317/v1", model: "test-model" } };
    vm.runInContext("resolveSettings = async () => testResolvedSettings", background);
  }
  const ask = (settings = {}, question = "请联网核实 gradient descent") => background.askAI({ question, context: videoContext, conversation: [] }, {
    authMode: "api-key", aiProvider: { apiKey: "private-model-key", baseUrl: "https://model.example/v1", model: "test-model" }, ...settings
  });
  return { background, network, modelRequests, ask };
}

for (const account of [false, true]) {
  const { ask, network, modelRequests } = loadBackground({ account });
  const answer = await ask();
  assert.equal(answer.webSearch.status, "completed");
  assert.equal(answer.webSearch.sources[0].url, "https://docs.example.com/gradient");
  assert.equal(modelRequests.length, 2, "one plain JSON planning call and one answer call, without provider-specific tools");
  const plan = JSON.stringify(modelRequests[0]);
  assert.ok(plan.includes("gradient descent introduction"));
  for (const forbidden of ["private-video-title", "BV1private", "crossing-video-secret", "future-video-secret"]) {
    assert.ok(!plan.includes(forbidden), `planner leaked ${forbidden}`);
  }
  assert.ok(!JSON.stringify(modelRequests[1]).includes("future-video-secret"));
  assert.match(modelRequests[1].messages[0].content, /不得据此透露或猜测视频后续/);
  assert.match(modelRequests[1].messages.at(-1).content, /搜索结果摘要/);
  assert.equal(network.length, 1);
  assert.equal(network[0].request.credentials, "omit");
  assert.equal(network[0].request.referrerPolicy, "no-referrer");
  assert.ok(!JSON.stringify(network).includes("private-"), "search requests must never carry video titles, model keys or account keys");
  await ask();
  assert.equal(network.length, 1, "reuse the bounded five-minute query cache");
}

{
  const { ask, modelRequests, network } = loadBackground();
  assert.equal((await ask({ enableWebSearch: false })).webSearch.status, "disabled");
  assert.equal(modelRequests.length, 1);
  assert.equal(network.length, 0);
}
{
  const { ask, modelRequests, network } = loadBackground({ plan: '{"search":false,"queries":[]}' });
  assert.equal((await ask({}, "梯度下降有什么背景知识？")).webSearch.status, "not-needed");
  assert.equal(modelRequests.length, 2);
  assert.equal(network.length, 0);
}
for (const options of [{ fail: true }, { plan: "not json; secret-upstream-error" }]) {
  const { ask } = loadBackground(options);
  const answer = await ask();
  assert.equal(answer.webSearch.status, "failed");
  assert.equal(answer.webSearch.sources.length, 0);
  assert.match(answer.warnings.join(" "), /联网搜索暂不可用/);
  assert.ok(answer.answer);
  assert.ok(!JSON.stringify(answer).includes("secret-upstream-error"));
}
{
  const { ask, network } = loadBackground({ fallback: true });
  const answer = await ask();
  assert.equal(answer.webSearch.status, "completed");
  assert.equal(answer.webSearch.sources[0].url, "https://en.wikipedia.org/wiki/Gradient_descent");
  assert.equal(network.length, 3, "fall back to a documented search API when public search pages are unavailable");
}
{
  const { ask, network, modelRequests } = loadBackground();
  await ask({}, "视频接下来会发生什么，联网找结局");
  assert.equal(network.length, 0);
  assert.equal(modelRequests.length, 1, "do not plan or search for video spoilers");
}
{
  const { background } = loadBackground();
  const encoded = "a1" + Buffer.from("https://docs.example.com/gradient?a=1&b=2").toString("base64url");
  assert.equal(background.normalizeSearchURL(`https://www.bing.com/ck/a?u=${encoded}`, "bing"), "https://docs.example.com/gradient?a=1&b=2");
  assert.equal(background.normalizeSearchURL("javascript:alert(1)", "bing"), "");
  assert.equal(background.normalizeSearchURL("http://127.0.0.1/private", "bing"), "");
  assert.equal(background.normalizeSearchURL("https://token@docs.example.com", "bing"), "");
  assert.equal(background.normalizeSearchURL("https://www.bilibili.com/video/BV1future", "bing"), "");
  const duck = `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fgradient" class="result__a"><b>Gradient descent</b></a>
    <div class="result__snippet">An optimization method.</div>`;
  assert.equal(background.parseWebSearchResults(duck, "duckduckgo")[0].url, "https://docs.example.com/gradient");
  assert.equal(background.parseWebSearchResults("<script>" + bing + "</script>", "bing").length, 0);
  assert.equal(background.rankWebSearchSources([{ title: "Restaurant planning rules", snippet: "Unrelated", url: "https://example.com" }], "gradient descent").length, 0);
}

class Element {
  constructor() { this.children = []; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  querySelector() { return new Element(); }
}
const panel = vm.createContext({ URL, console, structuredClone, document: { addEventListener() {}, createElement: () => new Element() } });
vm.runInContext(fs.readFileSync("extension/src/sidepanel/sidepanel.js", "utf8"), panel);
const rendered = panel.renderMarkdown('[官方资料](https://docs.example.com/x?a=1&b=2) 01:20 `02:30` [坏链接](javascript:alert(1)) <script>alert(1)</script>');
assert.match(rendered, /href="https:\/\/docs.example.com\/x\?a=1&amp;b=2"/);
assert.match(rendered, /rel="noopener noreferrer"/);
assert.match(rendered, /data-seconds="80"/);
assert.match(rendered, /<code>02:30<\/code>/);
assert.ok(!rendered.includes('<a href="javascript:'));
assert.ok(!rendered.includes("<script>"));
const record = { id: "test", question: "Explain", timestamp: 10, answer: "Answer", webSearch: { sources: [
  { title: "Gradient descent docs", url: "https://docs.example.com/gradient" },
  { title: "Duplicate", url: "https://docs.example.com/gradient" },
  { title: "Bad", url: "javascript:alert(1)" }
] } };
const message = panel.createAssistantMessage(record);
assert.ok(message.children.some((element) => element.className === "web-sources"));
const markdown = panel.buildMarkdown({ title: "Video", url: "https://www.youtube.com/watch?v=test" }, [record]);
assert.match(markdown, /### 联网搜索结果/);
assert.match(markdown, /\[Gradient descent docs\]\(https:\/\/docs.example.com\/gradient\)/);
assert.ok(!markdown.includes("javascript:"));
console.log("Web search, privacy, playback limits and source rendering tests passed.");

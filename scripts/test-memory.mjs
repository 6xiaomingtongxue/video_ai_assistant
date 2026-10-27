import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { evaluateBackground } from "./helpers/background-vm.mjs";

const root = process.cwd();
const extensionDir = path.join(root, "extension");

function createEvent() {
  return { addListener() {} };
}

function loadBackgroundScript() {
  const context = vm.createContext({
    URL,
    console,
    fetch: async () => {
      throw new Error("Network access is not expected in memory unit tests.");
    },
    chrome: {
      runtime: {
        lastError: null,
        getURL: (value) => `chrome-extension://test/${value}`,
        onInstalled: createEvent(),
        onMessage: createEvent()
      },
      action: { onClicked: createEvent() },
      commands: { onCommand: createEvent() },
      sidePanel: {},
      tabs: {},
      storage: { local: {} }
    }
  });
  const source = fs.readFileSync(path.join(extensionDir, "src/background/service_worker.js"), "utf8");
  evaluateBackground(context, source);
  return context;
}

function loadSidepanelScript() {
  const context = vm.createContext({
    URL,
    Blob,
    console,
    structuredClone,
    window: {},
    document: { addEventListener() {} }
  });
  const source = fs.readFileSync(path.join(extensionDir, "src/sidepanel/sidepanel.js"), "utf8");
  new vm.Script(source, { filename: "sidepanel.js" }).runInContext(context);
  return context;
}

function loadContentMemoryHelpers() {
  const context = vm.createContext({
    URL,
    console,
    location: {
      href: "https://www.youtube.com/watch?v=test",
      hostname: "www.youtube.com",
      origin: "https://www.youtube.com",
      protocol: "https:"
    }
  });
  const source = fs.readFileSync(path.join(extensionDir, "src/content/content_script.js"), "utf8")
    .replace("\n  init();\n", "\n")
    .replace(/\n\}\)\(\);\s*$/, [
      "",
      "  globalThis.__memoryTest = {",
      "    buildTranscriptChunks,",
      "    selectRelevantTranscriptChunks",
      "  };",
      "})();"
    ].join("\n"));
  new vm.Script(source, { filename: "content_script.js" }).runInContext(context);
  return context.__memoryTest;
}

function testBackgroundMemoryPrompt() {
  const context = loadBackgroundScript();
  const conversation = Array.from({ length: 8 }, (_, index) => ({
    id: `recent-${index}`,
    timestamp: index * 30,
    contextEnd: index * 30,
    question: `Question ${index}`,
    answer: `Answer ${index}`
  }));
  const request = context.buildChatCompletionRequest({
    question: "How does gradient descent work?",
    context: {
      videoInfo: {
        title: "Machine learning lesson",
        platform: "youtube",
        url: "https://www.youtube.com/watch?v=test",
        currentTime: 320
      },
      contextMode: "transcript-only",
      transcriptContext: [{ start: 300, end: 330, text: "Current explanation" }],
      relatedTranscriptContext: [{ start: 90, end: 130, text: "Earlier gradient descent definition" }],
      frameSnapshot: null
    },
    conversation,
    memory: {
      summary: "The video introduced supervised learning.",
      summaryThrough: 100,
      pendingRecords: [],
      relevantRecords: [{
        id: "older-relevant",
        timestamp: 100,
        contextEnd: 100,
        question: "What is a gradient?",
        answer: "A gradient points in the direction of steepest increase."
      }]
    },
    settings: {
      language: "en-US",
      aiProvider: { model: "test-model", supportsVision: false }
    }
  });

  const historyMessages = request.body.messages.filter((message) => {
    return message.role === "user" && String(message.content).startsWith("历史追问");
  });
  assert.equal(historyMessages.length, 6, "Only the latest six raw turns should be included.");
  assert.match(request.body.messages[0].content, /supervised learning/);
  assert.match(request.body.messages[0].content, /steepest increase/);
  assert.match(request.body.messages.at(-1).content, /Earlier gradient descent definition/);

  const summaryRequest = context.buildMemorySummaryRequest(
    "Existing memory",
    conversation.slice(0, 3),
    { language: "en-US", aiProvider: { model: "test-model" } }
  );
  assert.equal(summaryRequest.model, "test-model");
  assert.equal(summaryRequest.max_tokens, 700);
  assert.match(summaryRequest.messages[1].content, /Existing memory/);
}

function testSidepanelHistoryRetrieval() {
  const context = loadSidepanelScript();
  const records = [
    { id: "intro", timestamp: 10, contextEnd: 10, question: "课程介绍", answer: "介绍课程安排", transcriptContext: [] },
    { id: "gradient", timestamp: 100, contextEnd: 100, question: "什么是梯度下降", answer: "梯度下降通过迭代优化损失函数", transcriptContext: [] },
    { id: "network", timestamp: 200, contextEnd: 200, question: "神经网络层数", answer: "讨论隐藏层", transcriptContext: [] }
  ];
  const relevant = context.selectRelevantHistoryRecords("梯度下降如何优化", records, 150, 2);
  assert.equal(relevant[0].id, "gradient");
  assert.equal(vm.runInContext("MEMORY_POLICY.recentTurns", context), 6);

  const normalized = context.normalizeVideoMemory({
    summary: " summary ",
    coveredRecordIds: ["a", "a", ""],
    updatedAt: "now"
  });
  assert.equal(normalized.summary, "summary");
  assert.deepEqual([...normalized.coveredRecordIds], ["a"]);

  vm.runInContext('state.sessionKey = "youtube:test-video"', context);
  assert.doesNotThrow(() => context.assertActiveRequestSession("youtube:test-video"));
  assert.throws(
    () => context.assertActiveRequestSession("youtube:another-video"),
    /视频已切换/
  );
}

function testPlaybackLimitedModelRequest() {
  const context = loadBackgroundScript();
  const safe = { id: "safe", timestamp: 20, contextEnd: 20, question: "safe question", answer: "safe answer" };
  const future = { id: "future", timestamp: 150, contextEnd: 150, question: "future-question", answer: "future-answer" };
  const legacy = { id: "legacy", timestamp: 10, question: "legacy-question", answer: "legacy-answer" };
  const earlySpoiler = { id: "spoiler", timestamp: 10, contextEnd: 150,
    question: "old-full-video-question", answer: "old-full-video-answer" };
  const info = { currentTime: 100, title: "Lesson", platform: "youtube", url: "https://www.youtube.com/watch?v=test" };
  const text = [
    { start: 0, end: 10, text: "played-text" },
    { start: 90, end: 110, text: "crossing-text-leak" },
    { start: 150, end: 160, text: "future-text-leak" }
  ];
  const request = (memory) => context.buildChatCompletionRequest({
    question: "总结整个视频", context: { videoInfo: info, textContext: { complete: true, items: text, relatedItems: text } },
    conversation: [safe, legacy, earlySpoiler, future], memory,
    settings: { language: "zh-CN", aiProvider: { model: "test", supportsVision: false } }
  });
  const result = request({ summary: "future-summary-leak", summaryThrough: 150,
    relevantRecords: [safe, future, legacy, earlySpoiler], pendingRecords: [earlySpoiler] });
  const body = JSON.stringify(result.body);
  for (const forbidden of ["crossing-text-leak", "future-text-leak", "future-summary-leak",
    "future-question", "future-answer", "legacy-question", "legacy-answer", "old-full-video-question", "old-full-video-answer"]) {
    assert.ok(!body.includes(forbidden), `outgoing model request leaked ${forbidden}`);
  }
  assert.ok(body.includes("played-text"));
  assert.ok(body.includes("safe answer"));
  assert.match(result.body.messages[0].content, /不透露或猜测后续/);
  assert.match(result.body.messages.at(-1).content, /00:00 - 01:40/);
  assert.ok(JSON.stringify(request({ summary: "safe-summary", summaryThrough: 90 }).body).includes("safe-summary"));
  assert.ok(!JSON.stringify(request({ summary: "unscoped-summary" }).body).includes("unscoped-summary"));
  const legacyPrompt = context.buildUserPrompt("解释", {
    videoInfo: info, transcriptContext: text, relatedTranscriptContext: text
  }, false);
  assert.ok(!legacyPrompt.includes("future-text-leak"));
  assert.ok(!legacyPrompt.includes("crossing-text-leak"));
}

async function testPlaybackLimitedMemorySummary() {
  const context = loadSidepanelScript();
  context.testRecords = [
    ...Array.from({ length: 12 }, (_, index) => ({ id: `safe-${index}`, timestamp: index * 5 + 5,
      contextEnd: index * 5 + 5, question: `safe question ${index}`, answer: `safe answer ${index}` })),
    { id: "future", timestamp: 200, contextEnd: 200, question: "future-question-leak", answer: "future-answer-leak" },
    { id: "legacy", timestamp: 1, question: "legacy-question-leak", answer: "legacy-answer-leak" }
  ];
  const requests = [];
  context.mockSend = async (message) => {
    requests.push(message);
    return { summary: "safe regenerated summary" };
  };
  vm.runInContext(`
    state.sessionKey = 'youtube:test-video'; state.records = testRecords;
    state.memory = { summary: 'future-summary-leak', summaryThrough: 200, coveredRecordIds: ['future'] };
    sendRuntime = mockSend; persistCurrentSession = async () => {};
    renderModeState = () => {}; renderChat = () => {};
  `, context);
  const memory = await context.prepareVideoMemory("总结", "youtube:test-video", 100);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.existingSummary, "");
  assert.ok(requests[0].payload.records.every((record) => record.contextEnd <= 100));
  assert.equal(memory.summary, "safe regenerated summary");
  assert.equal(memory.summaryThrough, 30);
  assert.ok(!JSON.stringify([requests, memory]).includes("future-"));
  assert.ok(!JSON.stringify([requests, memory]).includes("legacy-"));
  assert.equal(vm.runInContext("state.records.length", context), 14, "do not delete future or old displayed history");
  const rewound = await context.prepareVideoMemory("总结", "youtube:test-video", 5);
  assert.equal(rewound.summary, "", "a later summary is withheld after rewinding");
  assert.equal(requests.length, 1, "no summary call without enough eligible older records");
  assert.equal(vm.runInContext("state.memory.summary", context), "safe regenerated summary", "retain the cached later summary");
}

function testTranscriptRetrieval() {
  const helpers = loadContentMemoryHelpers();
  assert.ok(helpers, "Content memory helpers should be exposed to the test context.");
  const items = [
    { start: 0, end: 12, text: "课程介绍和学习目标" },
    { start: 100, end: 112, text: "梯度下降用于优化损失函数" },
    { start: 120, end: 132, text: "学习率决定每次参数更新幅度" },
    { start: 240, end: 252, text: "神经网络隐藏层结构" }
  ];
  const chunks = helpers.buildTranscriptChunks(items);
  assert.ok(chunks.length >= 3);

  const relevant = helpers.selectRelevantTranscriptChunks(
    items,
    "梯度下降和学习率有什么关系",
    0,
    [items[0]]
  );
  assert.ok(relevant.some((item) => item.text.includes("梯度下降")));

  const overview = helpers.selectRelevantTranscriptChunks(items, "总结整个视频", 0, [items[0]]);
  assert.ok(overview.length > 0 && overview.length <= 8);
}

testBackgroundMemoryPrompt();
testSidepanelHistoryRetrieval();
testPlaybackLimitedModelRequest();
await testPlaybackLimitedMemorySummary();
testTranscriptRetrieval();
console.log("Video memory tests passed.");

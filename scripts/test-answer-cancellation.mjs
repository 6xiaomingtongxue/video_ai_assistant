import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createQuestionReplay, fixtureQuestion } from "./helpers/question-replay.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Cancellation test did not reach its expected phase")), 3000);
  })]); } finally { clearTimeout(timer); }
}

for (const phase of ["plan", "search", "answer"]) {
  const started = deferred();
  let aborted = 0;
  const hold = request => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => { aborted++; reject(request.signal.reason); }, { once: true });
    started.resolve();
  });
  const replay = createQuestionReplay({
    onModel: ({ phase: current, request, completion }) => current === phase ? hold(request)
      : completion(current === "plan" ? '{"search":true,"queries":["gradient descent"]}' : "answer"),
    ...(phase === "search" ? { onSearch: ({ request }) => hold(request) } : {})
  });
  const result = replay.ask(fixtureQuestion(phase === "answer" ? "解释当前片段" : "联网查找 gradient descent"))
    .then(value => ({ value }), error => ({ error }));
  await within(started.promise);
  const denied = replay.cancel("fixture-request", "https://www.bilibili.com/video/BV1untrusted");
  assert.equal(denied.ok, false, "a content page cannot cancel panel requests");
  assert.equal(aborted, 0);
  assert.equal(replay.cancel("fixture-request").data.cancelled, true);
  const { error } = await within(result);
  assert.equal(error.code, "cancelled");
  assert.equal(aborted, 1, "cancel must reach the actual fetch signal");
  assert.equal(error.harnessTrace.status, "cancelled");
  assert.equal(replay.active(), 0);
  assert.equal(replay.cancel("fixture-request").data.cancelled, false);
  if (phase !== "answer") assert.ok(!replay.modelRequests.some(request => request.phase === "answer"));
  assert.equal(replay.searchRequests.length, phase === "search" ? 1 : 0, "cancel must not launch a search fallback");
  const wireError = replay.context.normalizeError(error);
  assert.equal(wireError.code, "cancelled");
  assert.equal(wireError.trace.status, "cancelled");
}

// Model resolution can be cancelled even when a Native Messaging read has not returned.
{
  const replay = createQuestionReplay();
  const resolution = deferred();
  replay.context.resolveFixture = () => resolution.promise;
  vm.runInContext("resolveSettings = resolveFixture", replay.context);
  const result = replay.ask(fixtureQuestion()).catch(error => error);
  assert.equal(replay.cancel("fixture-request").data.cancelled, true);
  const error = await within(result);
  assert.equal(error.code, "cancelled");
  assert.equal(replay.modelRequests.length, 0);
  assert.equal(replay.active(), 0);
  resolution.resolve(replay.settings);
}

function loadPanel() {
  const panel = vm.createContext({ URL, console, structuredClone,
    document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(new URL("../extension/src/sidepanel/sidepanel.js", import.meta.url), "utf8"), panel);
  const evaluate = source => vm.runInContext(source, panel);
  const answer = deferred(), started = deferred();
  const payload = fixtureQuestion();
  panel.testContext = payload.context;
  panel.toasts = [];
  panel.saved = [];
  panel.mockSend = async message => {
    if (message.type === "VIDEO_LENS_CAPTURE_CONTEXT") return payload.context;
    if (message.type === "VIDEO_LENS_ASK_AI") { panel.lastPayload = message.payload; started.resolve(); return answer.promise; }
    if (message.type === "VIDEO_LENS_CANCEL_ANSWER") return { cancelled: true };
    throw new Error("Unexpected panel message");
  };
  evaluate(`
    state.sessionKey = 'original-video'; state.videoInfo = testContext.videoInfo; state.targetTabId = 1;
    Object.assign(dom, { questionInput: {value:''}, sendButton:{}, clearButton:{}, exportButton:{}, statusLine:{} });
    render = () => renderModeState(); renderChat = () => {};
    getQuestionVideoContext = async () => testContext;
    prepareVideoMemory = async () => ({warnings:[]});
    assertActiveRequestSession = key => { if (state.sessionKey !== key) throw new Error('Video changed'); };
    createId = () => 'panel-fixture';
    showToast = text => toasts.push(text);
    persistCurrentSession = async () => { saved.push(...state.records); };
    sendRuntime = mockSend;
  `);
  return { panel, evaluate, answer, started };
}

for (const switchVideo of [false, true]) {
  const { panel, evaluate, answer, started } = loadPanel();
  panel.testContext.textContext.courseMemory = { version: 1, kind: "course-excerpts", availableUntil: 100, blocks: [] };
  const pending = panel.sendQuestion("解释当前片段");
  await within(started.promise);
  assert.equal(evaluate("dom.sendButton.textContent"), "停止回答");
  assert.equal(evaluate("dom.sendButton.disabled"), false);
  await panel.stopAnswer();
  assert.equal(evaluate("dom.sendButton.textContent"), "正在停止");
  if (switchVideo) evaluate("state.sessionKey = 'next-video'");
  // A response already completed by the server can race with the cancel acknowledgement.
  answer.resolve({ answer: "LATE_ANSWER", trace: { status: "completed" } });
  await pending;
  assert.equal(evaluate("state.records.length"), 0, "never save a cancelled late answer");
  assert.equal(panel.saved.length, 0);
  assert.equal(evaluate("dom.questionInput.value"), switchVideo ? "" : "解释当前片段");
  assert.equal(evaluate("state.sending"), false);
  assert.equal(evaluate("state.answerRequestId"), null);
  assert.equal(evaluate("dom.sendButton.textContent"), "发送");
}
{
  const { panel, evaluate, answer, started } = loadPanel();
  panel.testContext.textContext.courseMemory = { version: 1, kind: "course-excerpts", availableUntil: 100, blocks: [] };
  const pending = panel.sendQuestion("解释当前片段");
  await within(started.promise);
  answer.resolve({ answer: "VISIBLE_ANSWER", trace: { scope: "answer", status: "completed", modelCalls: 1 } });
  await pending;
  assert.equal(panel.saved.length, 1);
  assert.equal(panel.saved[0].runTrace.modelCalls, 1);
  assert.equal(panel.lastPayload.context.textContext.courseMemory.kind, "course-excerpts");
  assert.equal(panel.saved[0].textContext.courseMemory, undefined, "do not duplicate the derived course index per question");
  assert.equal(evaluate("state.sending"), false);
}
console.log("Answer cancellation, sender validation, signal propagation, late-response and panel recovery tests passed.");

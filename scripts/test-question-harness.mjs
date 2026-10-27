import assert from "node:assert/strict";
import { QuestionRun, HarnessError, freezeAnswerRequest, skipSearchPlanning } from "../extension/src/background/question_harness.mjs";

{
  const run = new QuestionRun();
  let calls = 0;
  await run.model("search-plan", async () => { calls++; }, { reserve: 1 });
  await assert.rejects(run.model("search-plan", async () => { calls++; }, { reserve: 1 }), error => error.code === "model_budget");
  await run.model("answer", async () => { calls++; });
  await assert.rejects(run.model("answer", async () => { calls++; }), error => error.code === "model_budget");
  assert.equal(calls, 2, "reserve the final answer call and never retry paid model calls implicitly");
  const trace = run.finish();
  assert.equal(trace.modelCalls, 2);
  assert.equal(trace.status, "completed");
}
{
  const run = new QuestionRun({ modelCalls: 1 });
  await assert.rejects(run.model("search-plan", async () => {}, { reserve: 1 }), error => error.code === "model_budget");
  await run.model("answer", async () => {});
  run.finish();
}
{
  const run = new QuestionRun();
  let calls = 0;
  await Promise.all([run.tool("web-search", async () => { calls++; }), run.tool("web-search", async () => { calls++; })]);
  await assert.rejects(run.tool("web-search", async () => { calls++; }), error => error.code === "tool_budget");
  assert.equal(calls, 2);
  await assert.rejects(run.step("private-key-must-not-enter-trace", async () => {}), error => error.code === "invalid_stage");
  assert.ok(!JSON.stringify(run.finish()).includes("private-key"));
}
{
  const run = new QuestionRun();
  let child;
  const started = new Promise(resolve => {
    run.pending = run.model("answer", signal => { child = signal; resolve(); return new Promise(() => {}); });
  });
  await started;
  run.cancel();
  await assert.rejects(run.pending, error => error.code === "cancelled");
  assert.equal(child.aborted, true);
  let dispatched = false;
  await assert.rejects(run.tool("web-search", async () => { dispatched = true; }), error => error.code === "cancelled");
  assert.equal(dispatched, false);
  assert.equal(run.finish(new HarnessError("cancelled", "Stopped")).status, "cancelled");
}
{
  const run = new QuestionRun();
  await assert.rejects(run.tool("web-search", () => new Promise(() => {}), { timeoutMs: 5 }), error => error.code === "stage_timeout");
  await run.model("answer", async () => "still answer without search");
  const trace = run.finish();
  assert.equal(trace.stages[0].status, "timeout");
  assert.equal(trace.status, "completed", "an optional tool timeout must leave room for the final answer");
}
{
  const run = new QuestionRun({ timeoutMs: 10 });
  await assert.rejects(run.model("answer", () => new Promise(() => {})), error => /timeout/.test(error.code));
  run.finish(new HarnessError("run_timeout", "Timeout"));
}
{
  const run = new QuestionRun();
  await assert.rejects(run.model("answer", () => { throw new Error("private-provider-key-and-transcript"); }));
  const trace = run.finish(new Error("private-provider-key-and-transcript"));
  assert.equal(trace.stages[0].errorCode, "operation_failed");
  assert.ok(!JSON.stringify(trace).includes("private-provider-key"));
}
{
  const input = { question: "解释当前片段", context: { videoInfo: { currentTime: 10 },
    frameSnapshot: { timestamp: 20, imageDataUrl: "future-picture" }, textContext: { items: [{ start: 0, end: 3, text: "played" }] } } };
  const snapshot = freezeAnswerRequest(input);
  input.context.videoInfo.currentTime = 300;
  input.context.textContext.items[0].text = "later mutation";
  assert.equal(snapshot.context.videoInfo.currentTime, 10);
  assert.equal(snapshot.context.textContext.items[0].text, "played");
  assert.equal(snapshot.context.frameSnapshot, null);
  assert.equal(snapshot.policyWarnings.length, 1);
  assert.ok(Object.isFrozen(snapshot.context.textContext.items));
  assert.equal(freezeAnswerRequest({ ...input, context: { videoInfo: { currentTime: 10 },
    frameSnapshot: { timestamp: 10.01, imageDataUrl: "future-picture" } } }).context.frameSnapshot, null,
    "even a slightly later frame must not cross the playback cutoff");
  assert.throws(() => freezeAnswerRequest({ context: { videoInfo: { currentTime: Infinity } } }), error => error.code === "invalid_context");
}
assert.equal(skipSearchPlanning("请解释当前视频片段在讲什么。"), true);
assert.equal(skipSearchPlanning("请将当前片段整理成学习笔记。"), true);
assert.equal(skipSearchPlanning("请结合一个简单例子解释当前内容。"), true);
assert.equal(skipSearchPlanning("请联网解释当前视频提到的最新数据。"), false);
assert.equal(skipSearchPlanning("解释当前版本的配置方法"), false);
console.log("Question harness budgets, cancellation, deadlines, snapshot and trace privacy tests passed.");

import assert from "node:assert/strict";
import vm from "node:vm";
import { buildCourseContext, safeCourseMemory, COURSE_MEMORY_POLICY as policy } from "../extension/src/background/course_memory.mjs";
import { evaluateBackground } from "./helpers/background-vm.mjs";

function lecture(hours) {
  return Array.from({ length: hours * 120 }, (_, index) => ({ start: index * 30, end: index * 30 + 28,
    text: `第${Math.floor(index / 10) + 1}块学习线索 TOPIC_${Math.floor(index / 10)}。` +
      "我们通过一个具体计算例子逐步推导参数更新过程，检查假设、边界条件以及每一步的推理依据。".repeat(6) }));
}
const event = () => ({ addListener() {} });
function background() {
  const context = vm.createContext({ URL, console, fetch: () => { throw new Error("Long-course memory must be entirely local"); },
    chrome: { runtime: { getURL: path => `chrome-extension://test/${path}`, onInstalled: event(), onMessage: event() },
      action: { onClicked: event() }, commands: { onCommand: event() } } });
  evaluateBackground(context);
  return context;
}
const worker = background();
const textChars = items => items.reduce((sum, item) => sum + item.text.length, 0);
function assertBounded(context, cutoff) {
  assert.ok(textChars(context.items) <= policy.windowChars);
  assert.ok(textChars(context.relatedItems) <= policy.relatedChars);
  assert.ok(textChars(context.courseMemory.blocks.flatMap(block => block.items)) <= policy.outlineChars);
  assert.ok(context.courseMemory.blocks.length <= policy.maxBlocks);
  assert.ok([...context.items, ...context.relatedItems, ...context.courseMemory.blocks.flatMap(block => block.items)]
    .every(item => item.start < cutoff && item.end <= cutoff));
}

for (const hours of [1, 2, 12]) {
  const items = lecture(hours);
  const cutoff = hours * 3600;
  const record = { items, source: "speech-to-text", duration: cutoff, complete: true };
  const immutableOriginal = JSON.stringify(record);
  const selected = worker.getVideoTextContext(record, cutoff, "总结目前已经播放的课程内容", { contextBeforeSeconds: 60 });
  assertBounded(selected, cutoff);
  const expected = Math.ceil(cutoff / selected.courseMemory.blockSeconds);
  assert.equal(selected.courseMemory.blocks.length, expected, "represent every played time block, rather than only twelve sampled chunks");
  assert.equal(selected.courseMemory.blocks[0].start, 0);
  assert.equal(selected.courseMemory.blocks.at(-1).end, cutoff - 2);
  assert.equal(selected.complete, true);
  assert.equal(JSON.stringify(record), immutableOriginal, "derived memory must never truncate the transcript cache");
  // Reopening the panel/worker reconstructs the same memory from its persisted transcript.
  const reloaded = background().getVideoTextContext(JSON.parse(immutableOriginal), cutoff, "总结目前已经播放的课程内容", { contextBeforeSeconds: 60 });
  assert.equal(JSON.stringify(reloaded), JSON.stringify(selected));
}

const items = lecture(2);
items[57].text = "对比学习损失把正样本拉近、负样本推远。EARLY_UNASKED_FACT。";
items[20].text = "这个非显著片段只在 10:00 出现，TIME_REFERENCE_FACT。";
items[160].text = "小时和分钟组合定位的原始内容，HOUR_REFERENCE_FACT。";
items[165].text = "相对于当前时刻的早期内容，RELATIVE_REFERENCE_FACT。";
items[230].text = "FUTURE_LECTURE_FACT，尚未播放的课程结论。";
const record = { items, duration: 7200, complete: true, source: "subtitles" };
const settings = { contextBeforeSeconds: 60, language: "zh-CN", aiProvider: { model: "fixture", supportsVision: false } };
{
  const context = worker.getVideoTextContext(record, 6600, "前面讲过的对比学习损失是什么？", settings);
  assert.ok(context.relatedItems.some(item => item.text.includes("EARLY_UNASKED_FACT")), "find facts from an hour earlier even when no question was asked there");
  assertBounded(context, 6600);
  const request = worker.buildChatCompletionRequest({ question: "前面讲过的对比学习损失是什么？", context: {
    videoInfo: { currentTime: 6600 }, textContext: context }, conversation: [], settings });
  const outgoing = JSON.stringify(request.body);
  assert.ok(outgoing.includes("EARLY_UNASKED_FACT"));
  assert.ok(!outgoing.includes("FUTURE_LECTURE_FACT"));
  assert.ok(outgoing.includes("原文节选，不是完整章节摘要"));
}
for (const [question, marker] of [
  ["10:00 讲了什么", "TIME_REFERENCE_FACT"],
  ["第10分钟讲了什么", "TIME_REFERENCE_FACT"],
  ["1小时20分钟讲了什么", "HOUR_REFERENCE_FACT"],
  ["01:20:00 讲了什么", "HOUR_REFERENCE_FACT"],
  ["10分钟前讲了什么", "RELATIVE_REFERENCE_FACT"]
]) {
  const context = worker.getVideoTextContext(record, 5550, question, settings);
  assert.ok(context.relatedItems.some(item => item.text.includes(marker)), `missing time reference: ${question}`);
  assertBounded(context, 5550);
}
{
  const later = worker.getVideoTextContext(record, 6600, "总结", settings);
  const earlier = worker.getVideoTextContext(record, 1800, "总结", settings);
  assertBounded(earlier, 1800);
  assert.equal(earlier.courseMemory.blocks.length, 6);
  assert.equal(safeCourseMemory(later.courseMemory, 1800), null, "a later block map must never be reused after rewind");
  assert.ok(!JSON.stringify(earlier).includes("HOUR_REFERENCE_FACT"));
  const prompt = worker.buildUserPrompt("总结", { videoInfo: { currentTime: 1800 }, textContext: later }, false);
  assert.ok(!prompt.includes("HOUR_REFERENCE_FACT"));
  assert.ok(!prompt.includes("FUTURE_LECTURE_FACT"));
}
{
  const prefix = worker.getVideoTextContext(record, 90, "解释", settings);
  assert.equal(prefix.items.length, 3);
  assert.equal(prefix.courseMemory, undefined, "short prefixes still use the full available original text");
  const partial = worker.getVideoTextContext({ ...record, complete: false, items: items.slice(0, 150) }, 4200, "总结", settings);
  assert.equal(partial.complete, false);
  assertBounded(partial, 4200);
  assert.ok(!JSON.stringify(partial).includes("HOUR_REFERENCE_FACT"));
}
{
  const large = [{ start: 0, end: 10, text: "一小时前的原始资料。".repeat(2000) + "稀疏矩阵结论是 BIG_SEGMENT_NEEDLE。" },
    { start: 7100, end: 7120, text: "当前正在讲的内容。".repeat(2000) }];
  const context = buildCourseContext(large, 7200, "稀疏矩阵的结论是什么", 180);
  assertBounded(context, 7200);
  assert.ok(context.relatedItems.some(item => item.start === 0));
  assert.ok(context.relatedItems.some(item => item.text.includes("BIG_SEGMENT_NEEDLE")), "oversized transcript segments must keep the matched evidence, not merely their first lines");
}
{
  const bad = { version: 1, kind: "course-excerpts", availableUntil: 100, blocks: [
    { start: 0, end: 50, items: [{ start: 0, end: 20, text: "SAFE_TEXT" }, { start: 30, end: 150, text: "FUTURE_TEXT" }] },
    { start: 90, end: 150, items: [{ start: 90, end: 150, text: "FUTURE_BLOCK" }] }
  ] };
  const filtered = safeCourseMemory(bad, 100);
  assert.ok(JSON.stringify(filtered).includes("SAFE_TEXT"));
  assert.ok(!JSON.stringify(filtered).includes("FUTURE_"));
  assert.equal(safeCourseMemory({ ...bad, availableUntil: NaN }, 100), null);
}
console.log("Long-course memory tests passed: 1h/2h/12h coverage, unasked early facts, timestamps, rewind, reload, partial progress and prompt budgets.");

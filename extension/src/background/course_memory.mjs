// Long-course memory is derived from the cached transcript, never from unplayed
// text or from model-generated facts. These are excerpts, not chapter summaries.
export const COURSE_MEMORY_POLICY = Object.freeze({
  blockSeconds: 300, maxBlocks: 36, windowChars: 3000,
  relatedChars: 4800, outlineChars: 3600, relatedLimit: 8,
  chunkSeconds: 75, chunkChars: 700
});

const STOP_WORDS = new Set(("当前 视频 片段 课程 内容 什么 如何 怎么 为什么 解释 总结 概括 梳理 整理 前面 之前 这个 那个 一下 已经 提到 这里 现在 "
  + "the and what how why does this that video course explain please summary summarize earlier before").split(/\s+/));
const isOverview = question => /总结|概括|梳理|整个|全视频|整体|summary|summari[sz]e|overview|whole\s+(?:video|course)/i.test(question);
const clip = (text, length) => text.length <= length ? text : text.slice(0, Math.max(0, length - 1)).trimEnd() + "…";
const textSize = items => items.reduce((sum, item) => sum + item.text.length, 0);
const key = item => `${item.start}:${item.end}`;

function safeItems(items, cutoff) {
  return (Array.isArray(items) ? items : []).filter(item => Number.isFinite(item?.start)
    && Number.isFinite(item?.end) && item.start >= 0 && item.start < cutoff
    && item.end >= item.start && item.end <= cutoff && typeof item.text === "string" && item.text.trim())
    .map(({ start, end, text }) => ({ start, end, text: text.trim() })).sort((a, b) => a.start - b.start);
}

function terms(value, limit = 48) {
  const text = String(value || "").normalize("NFKC").toLowerCase();
  return [...new Set([...(text.match(/[a-z0-9][a-z0-9_+-]{1,}/g) || []),
    ...[...text.matchAll(/[\u3400-\u9fff]{2,}/g)].flatMap(([word]) =>
      Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))])]
    .filter(term => !STOP_WORDS.has(term)).slice(0, limit);
}

function chunksOf(items) {
  const chunks = [];
  for (const item of items) {
    const last = chunks.at(-1);
    if (last && item.end - last.start <= COURSE_MEMORY_POLICY.chunkSeconds
      && last.text.length + item.text.length + 1 <= COURSE_MEMORY_POLICY.chunkChars) {
      last.end = item.end;
      last.text += " " + item.text;
    } else chunks.push({ ...item });
  }
  return chunks;
}

function withinBudget(items, budget, newestFirst = false) {
  const output = [];
  for (const item of newestFirst ? [...items].reverse() : items) {
    if (budget < 2) break;
    const text = item.text.length > budget && newestFirst
      ? "…" + item.text.slice(-(budget - 1)) : clip(item.text, budget);
    output.push({ ...item, text });
    budget -= text.length;
  }
  return output.sort((a, b) => a.start - b.start);
}

function timeReferences(question, cutoff) {
  const targets = [];
  for (const match of question.matchAll(/\b(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\b/g)) {
    if (Number(match[3]) >= 60 || (match[1] && Number(match[2]) >= 60)) continue;
    targets.push(Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
  }
  for (const match of question.matchAll(/(?:(\d+(?:\.\d+)?)\s*小时(?:\s*(\d+)\s*分(?:钟)?)?|(\d+(?:\.\d+)?)\s*分(?:钟)?)(?:\s*(\d+)\s*秒)?(前)?/g)) {
    const time = Number(match[1] || 0) * 3600 + Number(match[2] || match[3] || 0) * 60 + Number(match[4] || 0);
    targets.push(match[5] ? cutoff - time : time);
  }
  if (/开头|开始时|最开始|at\s+the\s+(?:start|beginning)/i.test(question)) targets.push(0);
  return [...new Set(targets.filter(time => time >= 0 && time < cutoff))].slice(0, 4);
}

function focusExcerpt(item, queryTerms) {
  if (item.text.length <= COURSE_MEMORY_POLICY.chunkChars) return item;
  const lower = item.text.toLowerCase();
  const positions = queryTerms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 180) : 0;
  return { ...item, text: (start > 0 ? "…" : "") + clip(item.text.slice(start), COURSE_MEMORY_POLICY.chunkChars - (start > 0 ? 1 : 0)) };
}

function findRelated(chunks, window, cutoff, question) {
  const windowStart = window[0]?.start ?? cutoff;
  const outside = chunks.filter(item => item.end < windowStart);
  if (!outside.length) return [];
  const query = terms(question);
  const hints = terms(window.slice(-3).map(item => item.text).join(" "), 32);
  const normalized = outside.map(item => item.text.normalize("NFKC").toLowerCase());
  const weights = new Map([...new Set([...query, ...hints])].map(term => [term,
    Math.log(1 + outside.length / (1 + normalized.filter(text => text.includes(term)).length))]));
  const ranked = outside.map((item, index) => {
    const primary = query.reduce((sum, term) => sum + (normalized[index].includes(term) ? weights.get(term) : 0), 0);
    const hint = hints.reduce((sum, term) => sum + (normalized[index].includes(term) ? weights.get(term) : 0), 0);
    return { item, score: primary, hint };
  });
  const hasQueryMatch = ranked.some(entry => entry.score > 0);
  ranked.forEach(entry => { entry.score = hasQueryMatch ? entry.score + Math.min(entry.hint * 0.03, entry.score * 0.2) : entry.hint; });
  ranked.sort((a, b) => b.score - a.score || a.item.start - b.item.start);
  const selected = [], seen = new Set();
  const add = item => { if (item && !seen.has(key(item))) { selected.push(item); seen.add(key(item)); } };
  for (const target of timeReferences(question, cutoff)) {
    const distance = item => target >= item.start && target <= item.end ? 0 : Math.min(Math.abs(item.start - target), Math.abs(item.end - target));
    add([...outside].sort((a, b) => distance(a) - distance(b))[0]);
  }
  // Spread overview evidence across the full played range; the block map below
  // represents every block, so these originals supplement it rather than replace it.
  if (isOverview(question)) {
    for (let index = 0; index < Math.min(4, outside.length); index++) {
      add(outside[Math.round(index * (outside.length - 1) / Math.max(1, Math.min(4, outside.length) - 1))]);
    }
  }
  const perBlock = new Map();
  for (const { item, score } of ranked) {
    if (score <= 0 || selected.length >= COURSE_MEMORY_POLICY.relatedLimit - 1) continue;
    const block = Math.floor(item.start / COURSE_MEMORY_POLICY.blockSeconds);
    if ((perBlock.get(block) || 0) >= 2) continue;
    add(item);
    perBlock.set(block, (perBlock.get(block) || 0) + 1);
  }
  // Keep an opening anchor even when the current question is a vague follow-up.
  if (selected.length < COURSE_MEMORY_POLICY.relatedLimit) add(outside[0]);
  return withinBudget(selected.slice(0, COURSE_MEMORY_POLICY.relatedLimit)
    .map(item => focusExcerpt(item, query)), COURSE_MEMORY_POLICY.relatedChars);
}

function makeBlockMap(items, cutoff) {
  const policy = COURSE_MEMORY_POLICY;
  const blockSeconds = policy.blockSeconds * Math.max(1, Math.ceil(cutoff / policy.blockSeconds / policy.maxBlocks));
  const groups = new Map();
  for (const item of items) {
    const id = Math.floor(item.start / blockSeconds);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  const blocks = [...groups.values()];
  const budget = Math.floor(policy.outlineChars / Math.max(1, blocks.length));
  return { version: 1, kind: "course-excerpts", availableUntil: cutoff, blockSeconds,
    blocks: blocks.map(block => {
      // A block is not reduced to its first line: retain time-separated excerpts
      // plus a sentence containing terms repeated within this block.
      const termSets = block.map(item => new Set(terms(item.text, 80)));
      const frequencies = new Map();
      for (const set of termSets) for (const term of set) frequencies.set(term, (frequencies.get(term) || 0) + 1);
      const representative = block.map((item, index) => ({ item, score: [...termSets[index]].reduce((sum, term) =>
        sum + (frequencies.get(term) > 1 ? 1 : 0), 0) / Math.sqrt(Math.max(1, item.text.length)) }))
        .sort((a, b) => b.score - a.score || a.item.start - b.item.start)[0]?.item;
      const chosen = [...new Map([block[0], representative, block[Math.floor((block.length - 1) / 2)], block.at(-1)]
        .map(item => [key(item), item])).values()].sort((a, b) => a.start - b.start);
      const perItem = Math.floor(budget / chosen.length);
      return { start: block[0].start, end: Math.max(...block.map(item => item.end)),
        items: chosen.map(item => ({ ...item, text: clip(item.text, perItem) })) };
    }) };
}

export function buildCourseContext(items, cutoff, question, beforeSeconds = 60) {
  const played = safeItems(items, cutoff);
  const start = Math.max(0, cutoff - Math.max(0, Number(beforeSeconds) || 0));
  const window = played.filter(item => item.end >= start);
  const current = withinBudget(window, COURSE_MEMORY_POLICY.windowChars, true);
  return { items: current, relatedItems: findRelated(chunksOf(played), current, cutoff, String(question || "")),
    courseMemory: makeBlockMap(played, cutoff) };
}

// Recheck cached/older panel payloads at the actual model boundary. A block map
// prepared at a later playback position is withheld as a whole after rewinding.
export function safeCourseMemory(memory, cutoff) {
  if (memory?.version !== 1 || memory.kind !== "course-excerpts"
    || !Number.isFinite(memory.availableUntil) || memory.availableUntil < 0 || memory.availableUntil > cutoff) return null;
  let budget = COURSE_MEMORY_POLICY.outlineChars;
  const blocks = [];
  for (const block of (Array.isArray(memory.blocks) ? memory.blocks : []).slice(0, COURSE_MEMORY_POLICY.maxBlocks)) {
    if (!Number.isFinite(block?.start) || !Number.isFinite(block?.end) || block.start < 0
      || block.end < block.start || block.end > memory.availableUntil) continue;
    const items = withinBudget(safeItems(block.items, Math.min(cutoff, block.end))
      .filter(item => item.start >= block.start), budget);
    if (!items.length) continue;
    budget -= textSize(items);
    blocks.push({ start: block.start, end: block.end, items });
  }
  return blocks.length ? { blocks, availableUntil: memory.availableUntil } : null;
}

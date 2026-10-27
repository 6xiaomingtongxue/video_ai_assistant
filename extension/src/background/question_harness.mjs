export const DEFAULT_RUN_LIMITS = Object.freeze({ timeoutMs: 150000, modelCalls: 2, toolCalls: 2 });

export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new HarnessError("cancelled", "已停止本次回答。");
}

export function linkAbortSignal(controller, signal) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function freezeAnswerRequest(payload) {
  const time = payload?.context?.videoInfo?.currentTime;
  if (!Number.isFinite(time) || time < 0) throw new HarnessError("invalid_context", "未取得有效的提问时间，请重新提问。");
  const snapshot = structuredClone({ question: String(payload.question || "").trim(), context: payload.context,
    conversation: Array.isArray(payload.conversation) ? payload.conversation : [], memory: payload.memory });
  snapshot.policyWarnings = [];
  const frame = snapshot.context.frameSnapshot;
  if (frame && (!Number.isFinite(frame.timestamp) || frame.timestamp > time || time - frame.timestamp > 0.5)) {
    snapshot.context.frameSnapshot = null;
    snapshot.policyWarnings.push("截图时间与提问范围不一致，本次仅使用提问范围内的内容。");
  }
  return deepFreeze(snapshot);
}

export function skipSearchPlanning(question) {
  const text = String(question || "").trim();
  if (/联网|上网|搜索|查找|查一下|查资料|查证|核实|最新|实时|今天|今日|现在|今年|资料|文献|官方|链接|来源|search|look\s*up|online|latest|verify/i.test(text)) return false;
  return /当前(?:视频|片段|画面|内容)|这段|片段|已播放|已经播放|this\s+(?:video|clip)|played\s+(?:part|video)/i.test(text)
    && /解释|总结|概括|整理|梳理|笔记|举例|例子|explain|summari[sz]e|notes/i.test(text);
}

// This run owns answer routing, search planning, search tools and the final model
// call. Video transcription remains an independent background job.
export class QuestionRun {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_RUN_LIMITS, ...limits };
    this.id = globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    this.started = Date.now();
    this.deadline = this.started + this.limits.timeoutMs;
    this.controller = new AbortController();
    this.status = "running";
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.stages = [];
    this.timer = setTimeout(() => this.controller.abort(new HarnessError("run_timeout", "本次回答已达到时间上限，请稍后重试。")), this.limits.timeoutMs);
  }

  get signal() { return this.controller.signal; }

  cancel() {
    if (this.status === "running") this.controller.abort(new HarnessError("cancelled", "已停止本次回答，视频识别会继续在后台进行。"));
  }

  async step(name, operation, { timeoutMs } = {}) {
    if (!["resolve-model", "search-plan", "web-search", "answer"].includes(name)) {
      throw new HarnessError("invalid_stage", "不支持的回答处理步骤。");
    }
    throwIfAborted(this.signal);
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new HarnessError("run_timeout", "本次回答已达到时间上限，请重试。");
    const stage = { name, status: "running", durationMs: 0 };
    const started = Date.now();
    this.stages.push(stage);
    const controller = new AbortController();
    const detach = linkAbortSignal(controller, this.signal);
    const timer = setTimeout(() => controller.abort(new HarnessError("stage_timeout", "本次处理超时，请稍后重试。")), Math.min(timeoutMs || remaining, remaining));
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        throwIfAborted(controller.signal);
        return operation(controller.signal);
      }), aborted]);
      throwIfAborted(controller.signal);
      stage.status = "ok";
      return result;
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      stage.errorCode = reason instanceof HarnessError ? reason.code : "operation_failed";
      stage.status = stage.errorCode === "cancelled" ? "cancelled" : /timeout/.test(stage.errorCode) ? "timeout" : "failed";
      throw reason;
    } finally {
      stage.durationMs = Math.max(0, Date.now() - started);
      clearTimeout(timer);
      detach();
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async model(name, operation, { reserve = 0, ...options } = {}) {
    throwIfAborted(this.signal);
    if (this.modelCalls + reserve >= this.limits.modelCalls) throw new HarnessError("model_budget", "本次模型调用已达到上限，请重新提问。");
    this.modelCalls++;
    return this.step(name, operation, options);
  }

  async tool(name, operation, options = {}) {
    throwIfAborted(this.signal);
    if (this.toolCalls >= this.limits.toolCalls) throw new HarnessError("tool_budget", "本次资料检索已达到上限。");
    this.toolCalls++;
    return this.step(name, operation, options);
  }

  finish(error = null) {
    clearTimeout(this.timer);
    this.status = error ? this.signal.reason?.code === "cancelled" ? "cancelled"
      : /timeout/.test(this.signal.reason?.code || error.code || "") ? "timeout" : "failed" : "completed";
    this.durationMs = Math.max(0, Date.now() - this.started);
    return this.trace();
  }

  trace() {
    // Allowlisted metadata only. Never include prompts, video text, URLs, account
    // settings, tool payloads or upstream error messages in execution traces.
    return { id: this.id, scope: "answer", status: this.status,
      ...(["completed", "failed", "disabled", "not-needed"].includes(this.searchStatus) ? { searchStatus: this.searchStatus } : {}),
      durationMs: this.durationMs ?? Math.max(0, Date.now() - this.started),
      modelCalls: this.modelCalls, toolCalls: this.toolCalls,
      stages: this.stages.map(({ name, status, durationMs, errorCode }) => ({ name, status, durationMs, ...(errorCode ? { errorCode } : {}) })) };
  }
}

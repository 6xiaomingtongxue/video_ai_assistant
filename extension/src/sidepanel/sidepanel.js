const MESSAGE = {
  GET_BASIC_INFO: "VIDEO_LENS_GET_BASIC_INFO",
  GET_VIDEO_CONTEXT: "VIDEO_LENS_GET_VIDEO_CONTEXT",
  CAPTURE_CONTEXT: "VIDEO_LENS_CAPTURE_CONTEXT",
  PREPARE_CONTEXT: "VIDEO_LENS_PREPARE_CONTEXT",
  RELEASE_CONTEXT: "VIDEO_LENS_RELEASE_CONTEXT",
  SEEK_TO: "VIDEO_LENS_SEEK_TO",
  ASK_AI: "VIDEO_LENS_ASK_AI",
  CANCEL_ANSWER: "VIDEO_LENS_CANCEL_ANSWER",
  SUMMARIZE_MEMORY: "VIDEO_LENS_SUMMARIZE_MEMORY",
  TEST_PROVIDER: "VIDEO_LENS_TEST_PROVIDER",
  LIST_API_MODELS: "VIDEO_LENS_LIST_API_MODELS",
  GET_TARGET_TAB: "VIDEO_LENS_GET_TARGET_TAB",
  START_ACCOUNT_AUTH: "VIDEO_LENS_START_ACCOUNT_AUTH",
  GET_ACCOUNT_AUTH_STATUS: "VIDEO_LENS_GET_ACCOUNT_AUTH_STATUS",
  GET_PENDING_ACCOUNT_AUTH: "VIDEO_LENS_GET_PENDING_ACCOUNT_AUTH",
  FINISH_ACCOUNT_AUTH: "VIDEO_LENS_FINISH_ACCOUNT_AUTH",
  SUBMIT_ACCOUNT_CALLBACK: "VIDEO_LENS_SUBMIT_ACCOUNT_CALLBACK",
  GET_ACCOUNT_OVERVIEW: "VIDEO_LENS_GET_ACCOUNT_OVERVIEW",
  LOGOUT_ACCOUNT: "VIDEO_LENS_LOGOUT_ACCOUNT"
};

const STORAGE = {
  SETTINGS: "videolens:settings",
  SESSIONS: "videolens:sessions"
};

const DEFAULT_SETTINGS = {
  authMode: "api-key",
  language: "zh-CN",
  contextBeforeSeconds: 60,
  contextAfterSeconds: 0,
  enableFrameInput: true,
  enableWebSearch: true,
  frameImageQuality: 0.72,
  saveHistory: true,
  aiProvider: {
    provider: "openai",
    preset: "custom",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    supportsVision: true
  },
  accountProvider: {
    provider: "gpt",
    model: "",
    supportsVision: true
  }
};

const MEMORY_POLICY = {
  recentTurns: 6,
  summaryBatchMinimum: 3,
  summaryBatchMaximum: 8,
  relevantHistoryLimit: 4,
  pendingHistoryLimit: 4
};

const API_PRESETS = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", supportsVision: false },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", supportsVision: true }
};

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  videoInfo: null,
  sessionKey: "",
  sessions: {},
  records: [],
  memory: createEmptyVideoMemory(),
  sending: false,
  loadingText: "",
  transientError: "",
  refreshTimer: null,
  chatBottomThreshold: 72,
  targetTabId: null,
  connectionFailures: 0,
  settingsAccessMode: "api-key",
  selectedAccountProvider: "gpt",
  accountOverview: null,
  pendingAccountAuth: null,
  accountPollTimer: null,
  accountPollInFlight: false,
  accountResumeRequest: null,
  accountOverviewRequestId: 0,
  waitingForVideoText: false,
  cancelContextRequest: false,
  answerRequestId: null,
  stoppingAnswer: false,
  lastRunTrace: null
};

const dom = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindDom();
  bindEvents();
  await loadSettings();
  await loadSessions();
  await resolveTargetTab();
  syncSettingsForm();
  await refreshVideoInfo();
  render();
  resumeAccountAuthorization().catch(() => {});

  state.refreshTimer = window.setInterval(refreshVideoInfo, 2500);
}

function bindDom() {
  dom.connectionStatus = document.getElementById("connectionStatus");
  dom.videoTitle = document.getElementById("videoTitle");
  dom.platformBadge = document.getElementById("platformBadge");
  dom.currentTimeButton = document.getElementById("currentTimeButton");
  dom.chatList = document.getElementById("chatList");
  dom.jumpToLatestButton = document.getElementById("jumpToLatestButton");
  dom.questionInput = document.getElementById("questionInput");
  dom.sendButton = document.getElementById("sendButton");
  dom.webSearchInput = document.getElementById("webSearchInput");
  dom.statusLine = document.getElementById("statusLine");
  dom.exportButton = document.getElementById("exportButton");
  dom.clearButton = document.getElementById("clearButton");
  dom.settingsButton = document.getElementById("settingsButton");
  dom.settingsPanel = document.getElementById("settingsPanel");
  dom.closeSettingsButton = document.getElementById("closeSettingsButton");
  dom.settingsForm = document.getElementById("settingsForm");
  dom.settingsStatus = document.getElementById("settingsStatus");
  dom.testProviderButton = document.getElementById("testProviderButton");
  dom.apiAccessTab = document.getElementById("apiAccessTab");
  dom.accountAccessTab = document.getElementById("accountAccessTab");
  dom.apiAccessFields = document.getElementById("apiAccessFields");
  dom.accountAccessFields = document.getElementById("accountAccessFields");
  dom.toast = document.getElementById("toast");
  dom.quickButtons = Array.from(document.querySelectorAll("[data-template]"));
  dom.apiKeyInput = document.getElementById("apiKeyInput");
  dom.baseUrlInput = document.getElementById("baseUrlInput");
  dom.modelInput = document.getElementById("modelInput");
  for (const id of ["apiPresetInput", "apiModelList", "refreshAPIModelsButton", "accountCallbackPanel", "accountCallbackInput", "submitAccountCallbackButton"]) {
    dom[id] = document.getElementById(id);
  }
  dom.accountModelInput = document.getElementById("accountModelInput");
  dom.accountStatus = document.getElementById("accountStatus");
  dom.refreshAccountsButton = document.getElementById("refreshAccountsButton");
  dom.logoutAccountButton = document.getElementById("logoutAccountButton");
  dom.accountAuthButtons = Array.from(document.querySelectorAll("[data-account-provider]"));
  dom.accountProviderRows = Array.from(document.querySelectorAll("[data-provider-row]"));
  dom.accountProviderStatuses = {
    gpt: document.getElementById("gptAccountStatus"),
    claude: document.getElementById("claudeAccountStatus"),
    gemini: document.getElementById("geminiAccountStatus")
  };
  dom.languageInput = document.getElementById("languageInput");
  dom.beforeInput = document.getElementById("beforeInput");
  dom.qualityInput = document.getElementById("qualityInput");
  dom.visionInput = document.getElementById("visionInput");
  dom.frameInput = document.getElementById("frameInput");
  dom.historyInput = document.getElementById("historyInput");
}

function bindEvents() {
  dom.webSearchInput.addEventListener("change", async () => {
    state.settings.enableWebSearch = dom.webSearchInput.checked;
    try { await storageSet({ [STORAGE.SETTINGS]: state.settings }); }
    catch { showToast("联网搜索设置未保存，请重试"); }
  });
  dom.sendButton.addEventListener("click", () => {
    if (state.answerRequestId) stopAnswer().catch(() => {});
    else if (state.waitingForVideoText) state.cancelContextRequest = true;
    else sendQuestion(dom.questionInput.value);
  });
  dom.questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendQuestion(dom.questionInput.value);
    }
  });

  for (const button of dom.quickButtons) {
    button.addEventListener("click", () => {
      const template = button.getAttribute("data-template");
      dom.questionInput.value = template;
      sendQuestion(template);
    });
  }

  dom.currentTimeButton.addEventListener("click", () => {
    if (state.videoInfo) seekTo(state.videoInfo.currentTime || 0);
  });

  dom.exportButton.addEventListener("click", exportMarkdown);
  dom.clearButton.addEventListener("click", clearRecords);
  dom.settingsButton.addEventListener("click", openSettings);
  dom.closeSettingsButton.addEventListener("click", closeSettings);
  dom.settingsPanel.addEventListener("click", (event) => {
    if (event.target === dom.settingsPanel) closeSettings();
  });
  dom.settingsForm.addEventListener("submit", saveSettingsFromForm);
  dom.testProviderButton.addEventListener("click", testProvider);
  dom.apiPresetInput.addEventListener("change", applyAPIPreset);
  dom.baseUrlInput.addEventListener("input", () => { dom.apiPresetInput.value = "custom"; dom.apiModelList.replaceChildren(); });
  dom.refreshAPIModelsButton.addEventListener("click", refreshAPIModels);
  dom.submitAccountCallbackButton.addEventListener("click", submitAccountCallback);
  dom.apiAccessTab.addEventListener("click", () => setSettingsAccessMode("api-key"));
  dom.accountAccessTab.addEventListener("click", () => setSettingsAccessMode("account"));
  dom.refreshAccountsButton.addEventListener("click", () => refreshAccountOverview());
  dom.logoutAccountButton.addEventListener("click", logoutAccount);
  for (const button of dom.accountAuthButtons) {
    button.addEventListener("click", () => startAccountAuthorization(button.dataset.accountProvider));
  }
  dom.accountModelInput.addEventListener("change", () => {
    const provider = dom.accountModelInput.selectedOptions[0]?.dataset.provider;
    if (provider) {
      state.selectedAccountProvider = provider;
      renderAccountOverview();
    }
  });

  dom.chatList.addEventListener("click", handleChatClick);
  dom.chatList.addEventListener("scroll", updateJumpToLatestButton, { passive: true });
  dom.jumpToLatestButton.addEventListener("click", () => {
    dom.chatList.scrollTo({ top: dom.chatList.scrollHeight, behavior: "smooth" });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dom.settingsPanel.classList.contains("open")) {
      closeSettings();
    }
  });
  window.addEventListener("pagehide", () => {
    if (state.targetTabId) sendRuntime({ type: MESSAGE.RELEASE_CONTEXT, tabId: state.targetTabId }).catch(() => {});
  });
  window.addEventListener("focus", () => {
    if (state.pendingAccountAuth) pollAccountAuthorization();
    else if (dom.settingsPanel.classList.contains("open")) resumeAccountAuthorization({ refreshIfMissing: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.pendingAccountAuth) pollAccountAuthorization();
  });
}

async function loadSettings() {
  const result = await storageGet(STORAGE.SETTINGS);
  state.settings = mergeSettings(result[STORAGE.SETTINGS]);
  const storedAccount = result[STORAGE.SETTINGS]?.accountProvider || {};
  if (storedAccount.gatewayBaseUrl || storedAccount.clientApiKey || storedAccount.managementKey) {
    await storageSet({ [STORAGE.SETTINGS]: state.settings });
  }
}

async function loadSessions() {
  const result = await storageGet(STORAGE.SESSIONS);
  state.sessions = result[STORAGE.SESSIONS] || {};
}

async function resolveTargetTab() {
  try {
    const target = await sendRuntime({ type: MESSAGE.GET_TARGET_TAB });
    if (target?.tabId) {
      state.targetTabId = target.tabId;
    }
  } catch {
    state.targetTabId = null;
  }
}

async function refreshVideoInfo() {
  try {
    const response = await sendToActiveTab({ type: MESSAGE.GET_BASIC_INFO });
    const nextInfo = response.videoInfo;
    state.videoInfo = nextInfo;
    state.transientError = "";
    state.connectionFailures = 0;
    dom.connectionStatus.textContent = "已连接视频页面";
    dom.connectionStatus.dataset.state = "connected";

    const nextKey = buildSessionKey(nextInfo);
    const sessionChanged = nextKey !== state.sessionKey;
    if (sessionChanged) {
      if (state.answerRequestId) stopAnswer().catch(() => {});
      state.sessionKey = nextKey;
      const session = getCurrentSession();
      state.records = session.records || [];
      state.memory = normalizeVideoMemory(session.memory);
      prepareVideoContext();
    }

    renderVideoInfo();
    renderModeState();
    if (sessionChanged) {
      renderChat({ forceScrollToBottom: true });
    }
  } catch (error) {
    state.connectionFailures += 1;
    if (state.videoInfo && state.connectionFailures < 3) {
      dom.connectionStatus.textContent = "正在重新连接视频";
      dom.connectionStatus.dataset.state = "reconnecting";
      return;
    }

    state.videoInfo = null;
    dom.connectionStatus.textContent = "打开 YouTube 或 B 站视频后可用";
    dom.connectionStatus.dataset.state = "disconnected";
    dom.videoTitle.textContent = "未连接视频";
    dom.currentTimeButton.textContent = "00:00";
    dom.platformBadge.textContent = "Video";
    renderModeState();
  }
}

function render(options = {}) {
  renderVideoInfo();
  renderModeState();
  renderChat(options);
}

function renderVideoInfo() {
  if (!state.videoInfo) {
    dom.videoTitle.textContent = "未连接视频";
    dom.currentTimeButton.textContent = "00:00";
    dom.platformBadge.textContent = "Video";
    return;
  }

  dom.videoTitle.textContent = state.videoInfo.title || "Untitled video";
  dom.videoTitle.title = state.videoInfo.title || "";
  dom.currentTimeButton.textContent = formatTimestamp(state.videoInfo.currentTime || 0);
  dom.platformBadge.textContent = state.videoInfo.platform || "video";
}

function renderModeState() {
  if (dom.webSearchInput) {
    dom.webSearchInput.checked = state.settings.enableWebSearch !== false;
    dom.webSearchInput.disabled = state.sending;
  }
  const canStop = Boolean(state.answerRequestId);
  dom.sendButton.disabled = state.stoppingAnswer || (state.sending && !state.waitingForVideoText && !canStop) || (!state.videoInfo && !canStop);
  dom.sendButton.textContent = state.stoppingAnswer ? "正在停止" : canStop ? "停止回答" : state.waitingForVideoText ? "取消" : "发送";
  dom.clearButton.disabled = state.sending || !state.records.length;
  dom.exportButton.disabled = !state.records.length;
  dom.statusLine.textContent = state.loadingText || getContextStatusText();
}

function prepareVideoContext() {
  if (!state.targetTabId) return;
  sendRuntime({ type: MESSAGE.PREPARE_CONTEXT, tabId: state.targetTabId, settings: state.settings }).catch(() => {});
}

async function getQuestionVideoContext(question, requestSessionKey, snapshot) {
  state.waitingForVideoText = true;
  state.cancelContextRequest = false;
  renderModeState();
  try {
    while (true) {
      if (state.cancelContextRequest) throw new Error("已取消本次提问，视频内容会继续在后台准备。");
      assertActiveRequestSession(requestSessionKey);
      const context = await sendRuntime({
        type: MESSAGE.GET_VIDEO_CONTEXT, tabId: state.targetTabId, question, settings: state.settings,
        snapshotInfo: snapshot.videoInfo
      });
      assertActiveRequestSession(requestSessionKey, context.videoInfo);
      if (state.cancelContextRequest) throw new Error("已取消本次提问，视频内容会继续在后台准备。");
      if (!context.pending) return { ...context, videoInfo: snapshot.videoInfo,
        frameSnapshot: snapshot.frameSnapshot || null,
        warnings: [...new Set([...(snapshot.warnings || []), ...(context.warnings || [])])] };
      const target = snapshot.videoInfo.currentTime;
      const progress = target > 0
        ? `（${Math.min(99, Math.floor(context.processedUntil / target * 100))}%）` : "";
      state.loadingText = context.preparation === "runtime"
        ? "首次使用，正在自动准备视频处理环境..." : `正在准备 ${formatTimestamp(target)} 之前的内容${progress}...`;
      renderModeState();
      renderChat();
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
  } finally {
    state.waitingForVideoText = false;
  }
}

function renderChat(options = {}) {
  const shouldStickToBottom = options.forceScrollToBottom || isChatNearBottom();
  const previousScrollTop = dom.chatList.scrollTop;

  dom.chatList.replaceChildren();

  if (!state.records.length && !state.sending && !state.transientError) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.videoInfo
      ? "还没有提问。可以先试试解释当前片段。"
      : "请在 YouTube 或 B 站视频页面打开侧边栏。";
    dom.chatList.appendChild(empty);
    updateJumpToLatestButton();
    return;
  }

  for (const record of state.records) {
    dom.chatList.appendChild(createUserMessage(record));
    dom.chatList.appendChild(createAssistantMessage(record));
  }

  if (state.sending) {
    const loading = document.createElement("div");
    loading.className = "loading-card";
    loading.textContent = state.loadingText || "正在生成回答...";
    dom.chatList.appendChild(loading);
  }

  if (state.transientError) {
    const error = document.createElement("div");
    error.className = "error-card";
    error.textContent = state.transientError;
    dom.chatList.appendChild(error);
  }

  if (shouldStickToBottom) {
    scrollChatToBottom();
  } else {
    dom.chatList.scrollTop = previousScrollTop;
  }
  updateJumpToLatestButton();
}

function isChatNearBottom() {
  const distanceFromBottom = dom.chatList.scrollHeight - dom.chatList.scrollTop - dom.chatList.clientHeight;
  return distanceFromBottom <= state.chatBottomThreshold;
}

function scrollChatToBottom() {
  dom.chatList.scrollTop = dom.chatList.scrollHeight;
  updateJumpToLatestButton();
}

function updateJumpToLatestButton() {
  dom.jumpToLatestButton.hidden = isChatNearBottom() || dom.chatList.scrollHeight <= dom.chatList.clientHeight;
}

function createUserMessage(record) {
  const element = document.createElement("article");
  element.className = "message user";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.appendChild(createTimeButton(record.timestamp));
  if (record.frameSnapshot?.imageDataUrl) {
    meta.appendChild(createTag("已使用画面"));
  }

  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = record.question;

  element.append(meta, content);

  if (record.frameSnapshot?.imageDataUrl) {
    element.appendChild(createFramePreview(record.frameSnapshot));
  }

  return element;
}

function createAssistantMessage(record) {
  const element = document.createElement("article");
  element.className = "message assistant";
  element.dataset.recordId = record.id;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.appendChild(createTag("AI 回答"));

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.innerHTML = [
    '<button type="button" data-action="copy">复制</button>',
    '<button type="button" data-action="delete">删除</button>'
  ].join("");
  actions.querySelector('[data-action="delete"]').disabled = state.sending;
  meta.appendChild(actions);

  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = renderMarkdown(record.answer || "");

  element.append(meta, content);

  const sources = getWebSources(record);
  if (sources.length) {
    const details = document.createElement("details");
    details.className = "web-sources";
    const summary = document.createElement("summary");
    summary.textContent = `联网搜索 · ${sources.length} 个结果`;
    details.appendChild(summary);
    const list = document.createElement("ol");
    for (const source of sources) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = source.url;
      link.textContent = source.title;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      item.appendChild(link);
      list.appendChild(item);
    }
    details.appendChild(list);
    element.appendChild(details);
  }

  const warnings = (record.warnings || []).filter((warning) => !/字幕|语音|转写|转文字|音频/.test(warning));
  if (warnings.length) {
    const warning = document.createElement("div");
    warning.className = "message-meta";
    warning.textContent = warnings.join(" ");
    element.appendChild(warning);
  }

  return element;
}

function createTimeButton(seconds) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "time-button";
  button.dataset.seconds = String(Math.max(0, Math.floor(seconds || 0)));
  button.textContent = formatTimestamp(seconds || 0);
  return button;
}

function createTag(text) {
  const tag = document.createElement("span");
  tag.className = "message-tag";
  tag.textContent = text;
  return tag;
}

function createFramePreview(frame) {
  const preview = document.createElement("div");
  preview.className = "frame-preview";
  const image = document.createElement("img");
  image.src = frame.imageDataUrl;
  image.alt = `当前帧 ${formatTimestamp(frame.timestamp)}`;
  const caption = document.createElement("div");
  caption.className = "frame-caption";
  caption.textContent = `${formatTimestamp(frame.timestamp)} · ${frame.width}×${frame.height}`;
  preview.append(image, caption);
  return preview;
}

async function stopAnswer() {
  const requestId = state.answerRequestId;
  if (!requestId || state.stoppingAnswer) return;
  state.stoppingAnswer = true;
  state.loadingText = "正在停止本次回答...";
  renderModeState();
  try { await sendRuntime({ type: MESSAGE.CANCEL_ANSWER, requestId }); }
  catch (error) {
    if (state.answerRequestId === requestId) {
      state.stoppingAnswer = false;
      renderModeState();
      showToast("暂时无法停止回答，请重试。");
    }
  }
}

async function sendQuestion(rawQuestion) {
  const question = String(rawQuestion || "").trim();
  if (!question || state.sending) return;
  const requestSessionKey = state.sessionKey;
  let answerRequestId = null;

  state.sending = true;
  state.transientError = "";
  state.loadingText = "正在分析当前片段...";
  dom.questionInput.value = "";
  try {
    assertActiveRequestSession(requestSessionKey);
    // Dispatch capture before rendering history, subtitle work or runtime polling.
    const snapshotPromise = sendRuntime({ type: MESSAGE.CAPTURE_CONTEXT,
      tabId: state.targetTabId, settings: state.settings });
    render({ forceScrollToBottom: true });
    const snapshot = await snapshotPromise;
    assertActiveRequestSession(requestSessionKey, snapshot.videoInfo);
    state.loadingText = "正在理解当前视频片段...";
    renderModeState();
    renderChat();

    const context = await getQuestionVideoContext(question, requestSessionKey, snapshot);
    assertActiveRequestSession(requestSessionKey, context.videoInfo);
    const cutoff = context.videoInfo.currentTime || 0;
    const videoMemory = await prepareVideoMemory(question, requestSessionKey, cutoff);
    assertActiveRequestSession(requestSessionKey, context.videoInfo);

    state.loadingText = state.settings.enableWebSearch !== false ? "正在分析问题，按需联网检索..." : "正在生成回答...";
    answerRequestId = createId();
    state.answerRequestId = answerRequestId;
    state.stoppingAnswer = false;
    renderModeState();
    renderChat();

    const response = await sendRuntime({
      type: MESSAGE.ASK_AI,
      payload: {
        requestId: answerRequestId,
        question,
        context,
        conversation: state.records.filter((record) => isHistoryRecordAvailable(record, cutoff))
          .slice(-MEMORY_POLICY.recentTurns),
        memory: videoMemory
      },
      settings: state.settings
    });
    state.lastRunTrace = response.trace || null;
    if (state.stoppingAnswer) {
      const error = new Error("已停止本次回答。");
      error.code = "cancelled";
      throw error;
    }
    assertActiveRequestSession(requestSessionKey, context.videoInfo);

    // The course index can be reconstructed from the transcript cache; avoid
    // duplicating the same whole-course outline in every question's history.
    const storedTextContext = { ...(context.textContext || { items: [], relatedItems: [] }) };
    delete storedTextContext.courseMemory;
    const record = {
      id: createId(),
      videoTitle: context.videoInfo.title,
      videoUrl: context.videoInfo.url,
      platform: context.videoInfo.platform,
      timestamp: context.videoInfo.currentTime || 0,
      contextEnd: cutoff,
      questionCapturedAt: snapshot.capturedAt || null,
      question,
      answer: response.answer,
      webSearch: response.webSearch || null,
      runTrace: response.trace || null,
      textContext: storedTextContext,
      frameSnapshot: context.frameSnapshot || null,
      warnings: [
        ...(context.warnings || []),
        ...(videoMemory.warnings || []),
        ...(response.warnings || [])
      ],
      createdAt: new Date().toISOString()
    };

    state.records.push(record);
    await persistCurrentSession();
    showToast(state.settings.saveHistory ? "已保存回答" : "已生成回答");
  } catch (error) {
    if (error.runTrace) state.lastRunTrace = error.runTrace;
    if (error.code === "cancelled") {
      if (state.sessionKey === requestSessionKey) {
        if (!dom.questionInput.value.trim()) dom.questionInput.value = question;
        showToast("已停止本次回答。");
      }
    } else if (state.sessionKey === requestSessionKey) state.transientError = error.message || String(error);
  } finally {
    if (!answerRequestId || state.answerRequestId === answerRequestId) {
      state.answerRequestId = null;
      state.stoppingAnswer = false;
      state.sending = false;
      state.loadingText = "";
      render();
    }
  }
}

async function prepareVideoMemory(question, requestSessionKey, currentTime) {
  const recordsSnapshot = state.records.filter((record) => isHistoryRecordAvailable(record, currentTime));
  const olderRecordCount = Math.max(0, recordsSnapshot.length - MEMORY_POLICY.recentTurns);
  const olderRecords = recordsSnapshot.slice(0, olderRecordCount);
  const validRecordIds = new Set(recordsSnapshot.map(getMemoryRecordId));
  const storedMemory = normalizeVideoMemory(state.memory);
  // A summary built later in the video (or by an older extension) cannot be
  // trimmed safely. Rebuild it from eligible records without deleting history.
  let memory = Number.isFinite(storedMemory.summaryThrough) && storedMemory.summaryThrough <= currentTime
    ? storedMemory : createEmptyVideoMemory();
  memory.coveredRecordIds = memory.coveredRecordIds.filter((id) => validRecordIds.has(id));

  const warnings = [];
  let coveredIds = new Set(memory.coveredRecordIds);
  let pendingRecords = olderRecords.filter((record) => !coveredIds.has(getMemoryRecordId(record)));

  if (pendingRecords.length >= MEMORY_POLICY.summaryBatchMinimum) {
    const summaryBatch = pendingRecords.slice(0, MEMORY_POLICY.summaryBatchMaximum);
    state.loadingText = "正在整理当前视频的长期记忆...";
    renderModeState();
    renderChat();

    try {
      const response = await sendRuntime({
        type: MESSAGE.SUMMARIZE_MEMORY,
        payload: {
          existingSummary: memory.summary,
          records: summaryBatch.map(serializeMemoryRecord)
        },
        settings: state.settings
      });
      assertActiveRequestSession(requestSessionKey);

      coveredIds = new Set([
        ...memory.coveredRecordIds,
        ...summaryBatch.map(getMemoryRecordId)
      ]);
      memory = {
        summary: response.summary,
        summaryThrough: Math.max(memory.summaryThrough || 0, ...summaryBatch.map((record) =>
          record.contextEnd ?? record.textContext.availableUntil)),
        coveredRecordIds: [...coveredIds],
        updatedAt: new Date().toISOString()
      };
      state.memory = memory;
      await persistCurrentSession();
    } catch (error) {
      if (state.sessionKey !== requestSessionKey) {
        throw new Error("视频已切换，本次提问已取消，请在新视频中重新提问。");
      }
      warnings.push(`长期记忆摘要暂未更新：${error.message || String(error)}`);
    }
  }

  coveredIds = new Set(memory.coveredRecordIds);
  pendingRecords = olderRecords.filter((record) => !coveredIds.has(getMemoryRecordId(record)));
  const relevantRecords = selectRelevantHistoryRecords(
    question,
    olderRecords,
    currentTime,
    MEMORY_POLICY.relevantHistoryLimit
  );

  return {
    summary: memory.summary,
    summaryThrough: memory.summaryThrough,
    pendingRecords: pendingRecords
      .slice(-MEMORY_POLICY.pendingHistoryLimit)
      .map(serializeMemoryRecord),
    relevantRecords: relevantRecords.map(serializeMemoryRecord),
    warnings
  };
}

function assertActiveRequestSession(requestSessionKey, contextVideoInfo = null) {
  const contextSessionKey = contextVideoInfo ? buildSessionKey(contextVideoInfo) : requestSessionKey;
  if (!requestSessionKey || state.sessionKey !== requestSessionKey || contextSessionKey !== requestSessionKey) {
    throw new Error("视频已切换，本次提问已取消，请在新视频中重新提问。");
  }
}

function createEmptyVideoMemory() {
  return {
    summary: "",
    summaryThrough: null,
    coveredRecordIds: [],
    updatedAt: null
  };
}

function normalizeVideoMemory(memory) {
  if (!memory || typeof memory !== "object") return createEmptyVideoMemory();
  return {
    summary: String(memory.summary || "").trim(),
    summaryThrough: Number.isFinite(memory.summaryThrough) && memory.summaryThrough >= 0 ? memory.summaryThrough : null,
    coveredRecordIds: [...new Set(
      (Array.isArray(memory.coveredRecordIds) ? memory.coveredRecordIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )],
    updatedAt: memory.updatedAt || null
  };
}

function getMemoryRecordId(record) {
  if (record?.id) return String(record.id);
  const timestamp = Math.max(0, Math.floor(Number(record?.timestamp) || 0));
  return `legacy:${timestamp}:${String(record?.question || "").slice(0, 80)}`;
}

function serializeMemoryRecord(record) {
  return {
    id: getMemoryRecordId(record),
    timestamp: Math.max(0, Number(record?.timestamp) || 0),
    contextEnd: record?.contextEnd ?? record?.textContext?.availableUntil ?? null,
    question: String(record?.question || ""),
    answer: String(record?.answer || "")
  };
}

function isHistoryRecordAvailable(record, currentTime) {
  const cutoff = Number(currentTime);
  const end = record?.contextEnd ?? record?.textContext?.availableUntil;
  const timestamp = Number(record?.timestamp);
  return Number.isFinite(cutoff) && cutoff >= 0 && Number.isFinite(end) && end >= 0 && end <= cutoff
    && Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= cutoff;
}

function selectRelevantHistoryRecords(question, records, currentTime, limit) {
  records = records.filter((record) => isHistoryRecordAvailable(record, currentTime));
  if (!records.length || limit <= 0) return [];
  if (isMemoryOverviewQuestion(question)) return sampleHistoryRecords(records, limit);

  const tokens = buildMemorySearchTokens(question);
  if (!tokens.length) return [];

  return records
    .map((record) => {
      const transcriptText = (record.textContext?.items || record.transcriptContext || []).map((item) => item.text || "").join(" ");
      const lexicalScore = scoreMemoryText(record.question, tokens) * 3
        + scoreMemoryText(record.answer, tokens)
        + scoreMemoryText(transcriptText, tokens) * 2;
      const distance = Math.abs((Number(record.timestamp) || 0) - (Number(currentTime) || 0));
      return {
        record,
        score: lexicalScore > 0 ? lexicalScore + 1 / (1 + distance / 300) : 0
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.record.timestamp) - Number(left.record.timestamp))
    .slice(0, limit)
    .map((item) => item.record);
}

function sampleHistoryRecords(records, limit) {
  if (records.length <= limit) return records;
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const recordIndex = Math.round(index * (records.length - 1) / Math.max(1, limit - 1));
    if (seen.has(recordIndex)) continue;
    seen.add(recordIndex);
    selected.push(records[recordIndex]);
  }
  return selected;
}

function isMemoryOverviewQuestion(question) {
  return /总结|概括|梳理|整个视频|全视频|整体|之前|前面|历史|问过|summary|summarize|overview|earlier|previous/i
    .test(String(question || ""));
}

function buildMemorySearchTokens(value) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const stopWords = new Set([
    "什么", "怎么", "如何", "为什么", "这个", "那个", "当前", "视频", "内容", "请问", "解释", "一下",
    "what", "how", "why", "this", "that", "video", "please", "explain", "about"
  ]);
  const tokens = new Set();

  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []) {
    if (!stopWords.has(word)) tokens.add(word);
  }
  for (const sequence of normalized.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 8 && !stopWords.has(sequence)) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const token = sequence.slice(index, index + 2);
      if (!stopWords.has(token)) tokens.add(token);
    }
  }

  return [...tokens].slice(0, 24);
}

function scoreMemoryText(text, tokens) {
  const haystack = String(text || "").normalize("NFKC").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    let index = haystack.indexOf(token);
    let occurrences = 0;
    while (index !== -1 && occurrences < 3) {
      occurrences += 1;
      index = haystack.indexOf(token, index + token.length);
    }
    score += occurrences * (token.length >= 4 ? 4 : 2);
  }
  return score;
}

async function persistCurrentSession() {
  if (!state.videoInfo || !state.sessionKey) return;

  if (!state.settings.saveHistory) {
    return;
  }

  const previousSession = state.sessions[state.sessionKey] || {};
  state.sessions[state.sessionKey] = {
    ...previousSession,
    sessionId: state.sessionKey,
    videoTitle: state.videoInfo.title,
    videoUrl: normalizeVideoUrl(state.videoInfo.url),
    platform: state.videoInfo.platform,
    startedAt: previousSession.startedAt || new Date().toISOString(),
    records: state.records,
    memory: {
      summary: state.memory.summary,
      summaryThrough: state.memory.summaryThrough,
      coveredRecordIds: state.memory.coveredRecordIds,
      updatedAt: state.memory.updatedAt
    }
  };

  try {
    await storageSet({ [STORAGE.SESSIONS]: state.sessions });
  } catch (error) {
    stripStoredFrameImages(state.sessions[state.sessionKey]);
    await storageSet({ [STORAGE.SESSIONS]: state.sessions });
    showToast("本地空间不足，已保存记录但未保存截图");
  }
}

function stripStoredFrameImages(session) {
  for (const record of session.records || []) {
    if (record.frameSnapshot) {
      record.frameSnapshot = {
        ...record.frameSnapshot,
        imageDataUrl: ""
      };
    }
  }
}

async function clearRecords() {
  if (state.sending) {
    showToast("回答生成完成后再清空记录");
    return;
  }
  if (!state.records.length) return;
  const confirmed = window.confirm("清空当前视频的问答记录？");
  if (!confirmed) return;

  state.records = [];
  state.memory = createEmptyVideoMemory();
  if (state.sessionKey && state.sessions[state.sessionKey]) {
    delete state.sessions[state.sessionKey];
    await storageSet({ [STORAGE.SESSIONS]: state.sessions });
  }
  render();
  showToast("记录已清空");
}

function exportMarkdown() {
  if (!state.records.length) {
    showToast("没有可导出的记录");
    return;
  }

  const info = state.videoInfo || getCurrentSession();
  const markdown = buildMarkdown(info, state.records);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(info.videoTitle || info.title || "videolens-notes")}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildMarkdown(info, records) {
  const title = info.videoTitle || info.title || "Untitled video";
  const url = normalizeVideoUrl(info.videoUrl || info.url || "");
  const lines = [
    `# 视频学习笔记：${title}`,
    "",
    `视频链接：${url}`,
    "",
    `导出时间：${new Date().toLocaleString()}`,
    ""
  ];

  records.forEach((record, index) => {
    lines.push(`## ${index + 1}. ${record.question}`);
    lines.push("");
    lines.push(`时间：${formatTimestamp(record.timestamp)}`);
    lines.push("");
    lines.push("### AI 回答");
    lines.push("");
    lines.push(record.answer || "");
    lines.push("");
    const sources = getWebSources(record);
    if (sources.length) {
      lines.push("### 联网搜索结果", "");
      for (const source of sources) {
        const title = source.title.replace(/[\[\]<>\r\n]/g, " ");
        lines.push(`- [${title}](${source.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`);
      }
      lines.push("");
    }
    const textItems = record.textContext?.items || record.transcriptContext || [];
    if (textItems.length) {
      lines.push("<details>");
      lines.push("<summary>本次视频上下文</summary>");
      lines.push("");
      for (const item of textItems) {
        lines.push(`- ${formatTimestamp(item.start)} - ${formatTimestamp(item.end)}：${item.text}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n");
}

function openSettings() {
  dom.settingsPanel.classList.add("open");
  dom.settingsPanel.inert = false;
  dom.settingsPanel.setAttribute("aria-hidden", "false");
  syncSettingsForm();
  if (state.settingsAccessMode === "account") {
    dom.accountAuthButtons[0]?.focus();
  } else {
    dom.apiKeyInput.focus();
  }
  resumeAccountAuthorization({ refreshIfMissing: true }).catch(() => {});
}

function closeSettings() {
  stopAccountAuthPolling();
  dom.settingsButton.focus();
  dom.settingsPanel.classList.remove("open");
  dom.settingsPanel.inert = true;
  dom.settingsPanel.setAttribute("aria-hidden", "true");
  dom.settingsStatus.textContent = "";
  dom.accountStatus.textContent = "";
}

function syncSettingsForm() {
  const provider = state.settings.aiProvider;
  const accountProvider = state.settings.accountProvider;
  dom.apiKeyInput.value = provider.apiKey || "";
  dom.baseUrlInput.value = provider.baseUrl || "";
  dom.modelInput.value = provider.model || "";
  dom.apiPresetInput.value = API_PRESETS[provider.preset] ? provider.preset : "custom";
  state.selectedAccountProvider = accountProvider.provider || "gpt";
  state.settingsAccessMode = state.settings.authMode === "account" ? "account" : "api-key";
  setSettingsAccessMode(state.settingsAccessMode, { focus: false });
  renderAccountOverview();
  dom.languageInput.value = state.settings.language || "zh-CN";
  dom.beforeInput.value = state.settings.contextBeforeSeconds;
  dom.qualityInput.value = state.settings.frameImageQuality;
  dom.visionInput.checked = getActiveProviderSettings().supportsVision !== false;
  dom.frameInput.checked = state.settings.enableFrameInput !== false;
  dom.historyInput.checked = state.settings.saveHistory !== false;
}

async function saveSettingsFromForm(event) {
  event.preventDefault();
  const nextSettings = buildDraftSettings();

  if (nextSettings.authMode === "account") {
    if (!nextSettings.accountProvider.model) {
      dom.settingsStatus.textContent = "请先授权账号并选择模型。";
      return;
    }
  } else if (!nextSettings.aiProvider.baseUrl || !nextSettings.aiProvider.model) {
    dom.settingsStatus.textContent = "请填写 API 服务 Base URL 和模型名称。";
    return;
  }

  state.settings = nextSettings;
  await storageSet({ [STORAGE.SETTINGS]: state.settings });
  prepareVideoContext();
  dom.settingsStatus.textContent = "设置已保存。";
  renderModeState();
  showToast("设置已保存");
}

function buildDraftSettings() {
  const selectedModelOption = dom.accountModelInput.selectedOptions[0];
  const selectedProvider = selectedModelOption?.dataset.provider
    || state.selectedAccountProvider
    || state.settings.accountProvider.provider
    || "gpt";
  return mergeSettings({
    authMode: state.settingsAccessMode,
    language: dom.languageInput.value,
    contextBeforeSeconds: Number(dom.beforeInput.value) || 60,
    contextAfterSeconds: 0,
    enableFrameInput: dom.frameInput.checked,
    enableWebSearch: dom.webSearchInput.checked,
    frameImageQuality: Number(dom.qualityInput.value) || 0.72,
    saveHistory: dom.historyInput.checked,
    aiProvider: {
      provider: "openai",
      preset: dom.apiPresetInput.value,
      apiKey: dom.apiKeyInput.value.trim(),
      baseUrl: dom.baseUrlInput.value.trim(),
      model: dom.modelInput.value.trim(),
      supportsVision: state.settingsAccessMode === "api-key"
        ? dom.visionInput.checked
        : state.settings.aiProvider.supportsVision !== false
    },
    accountProvider: {
      provider: selectedProvider,
      model: dom.accountModelInput.value || state.settings.accountProvider.model || "",
      supportsVision: state.settingsAccessMode === "account"
        ? dom.visionInput.checked
        : state.settings.accountProvider.supportsVision !== false
    }
  });
}

async function testProvider() {
  dom.settingsStatus.textContent = "正在调用所选模型...";
  dom.testProviderButton.disabled = true;
  const draft = buildDraftSettings();

  try {
    const response = await sendRuntime({ type: MESSAGE.TEST_PROVIDER, settings: draft });
    dom.settingsStatus.textContent = response.message;
  } catch (error) {
    dom.settingsStatus.textContent = error.message || String(error);
  } finally {
    dom.testProviderButton.disabled = false;
  }
}

function applyAPIPreset() {
  const preset = API_PRESETS[dom.apiPresetInput.value];
  if (!preset) return;
  let sameOrigin = false;
  try { sameOrigin = new URL(dom.baseUrlInput.value).origin === new URL(preset.baseUrl).origin; } catch {}
  if (!sameOrigin) dom.apiKeyInput.value = "";
  dom.baseUrlInput.value = preset.baseUrl;
  dom.modelInput.value = preset.model;
  dom.visionInput.checked = preset.supportsVision;
  dom.apiModelList.replaceChildren();
  dom.settingsStatus.textContent = sameOrigin ? "已填入服务配置，可继续修改。" : "已填入服务配置，请填写此服务的 API Key。";
}

async function refreshAPIModels() {
  const draft = buildDraftSettings();
  const requestProfile = JSON.stringify(draft.aiProvider);
  dom.refreshAPIModelsButton.disabled = true;
  dom.settingsStatus.textContent = "正在获取 API 模型列表...";
  try {
    const response = await sendRuntime({ type: MESSAGE.LIST_API_MODELS, settings: draft });
    if (JSON.stringify(buildDraftSettings().aiProvider) !== requestProfile) return;
    dom.apiModelList.replaceChildren();
    for (const id of response.models || []) {
      const option = document.createElement("option");
      option.value = id;
      dom.apiModelList.appendChild(option);
    }
    dom.settingsStatus.textContent = response.models?.length
      ? `已获取 ${response.models.length} 个模型，可在模型名称中选择或直接填写。`
      : "服务未返回模型，可直接填写模型名称。";
  } catch (error) {
    dom.settingsStatus.textContent = `${error.message || error} 也可以直接填写模型名称。`;
  } finally { dom.refreshAPIModelsButton.disabled = false; }
}

function setSettingsAccessMode(mode, options = {}) {
  const nextMode = mode === "account" ? "account" : "api-key";
  state.settingsAccessMode = nextMode;
  const accountSelected = nextMode === "account";
  dom.apiAccessTab.setAttribute("aria-selected", String(!accountSelected));
  dom.accountAccessTab.setAttribute("aria-selected", String(accountSelected));
  dom.apiAccessTab.tabIndex = accountSelected ? -1 : 0;
  dom.accountAccessTab.tabIndex = accountSelected ? 0 : -1;
  dom.apiAccessFields.hidden = accountSelected;
  dom.accountAccessFields.hidden = !accountSelected;
  dom.accountCallbackInput.disabled = !accountSelected;
  for (const input of [dom.apiKeyInput, dom.baseUrlInput, dom.modelInput, dom.apiPresetInput, dom.refreshAPIModelsButton]) {
    input.disabled = accountSelected;
  }
  dom.testProviderButton.textContent = "测试所选模型";
  dom.settingsStatus.textContent = "";
  const modeProvider = accountSelected ? state.settings.accountProvider : state.settings.aiProvider;
  dom.visionInput.checked = modeProvider.supportsVision !== false;

  if (options.focus !== false) {
    (accountSelected ? dom.accountAuthButtons[0] : dom.apiKeyInput)?.focus();
  }
  if (accountSelected && dom.settingsPanel.classList.contains("open")) {
    refreshAccountOverview({ quiet: true });
  }
}

async function startAccountAuthorization(provider) {
  if (state.pendingAccountAuth) return;

  state.selectedAccountProvider = provider;
  state.accountOverviewRequestId += 1;
  setAccountControlsBusy(true, provider);
  const activeProvider = state.accountOverview?.activeProvider;
  dom.accountStatus.textContent = activeProvider
    ? `正在退出 ${getAccountProviderLabel(activeProvider)} 并切换到 ${getAccountProviderLabel(provider)}...`
    : `正在打开 ${getAccountProviderLabel(provider)} 授权页面...`;

  try {
    const previousAuthMode = state.settings.authMode;
    state.settings = buildDraftSettings();
    state.settings.authMode = previousAuthMode;
    await storageSet({ [STORAGE.SETTINGS]: state.settings });
    const response = await sendRuntime({
      type: MESSAGE.START_ACCOUNT_AUTH,
      provider
    });
    resetLocalAccountSelection();
    state.pendingAccountAuth = {
      provider,
      state: response.state,
      startedAt: response.startedAt || Date.now(),
      phase: "authorizing"
    };
    state.accountOverview = null;
    renderAccountOverview();
    setAccountControlsBusy(true, provider);
    dom.accountCallbackPanel.hidden = false;
    dom.accountStatus.textContent = `请在新页面完成 ${getAccountProviderLabel(provider)} 授权。`;
    pollAccountAuthorization();
  } catch (error) {
    await loadSettings();
    syncSettingsForm();
    setAccountControlsBusy(false);
    dom.accountStatus.textContent = error.message || String(error);
  }
}

async function resumeAccountAuthorization(options = {}) {
  if (state.accountResumeRequest) return state.accountResumeRequest;
  const operation = (async () => {
    const pending = await sendRuntime({ type: MESSAGE.GET_PENDING_ACCOUNT_AUTH });
    if (!pending) {
      if (options.refreshIfMissing && state.settingsAccessMode === "account") await refreshAccountOverview({ quiet: true });
      return;
    }
    if (state.pendingAccountAuth?.state === pending.state) { pollAccountAuthorization(); return; }
    state.accountOverviewRequestId += 1;
    state.pendingAccountAuth = pending;
    state.selectedAccountProvider = pending.provider;
    setSettingsAccessMode("account", { focus: false });
    renderAccountOverview();
    setAccountControlsBusy(true, pending.provider);
    dom.accountCallbackPanel.hidden = false;
    dom.accountStatus.textContent = "正在恢复并确认账号授权...";
    pollAccountAuthorization();
  })();
  state.accountResumeRequest = operation;
  try { await operation; }
  finally { if (state.accountResumeRequest === operation) state.accountResumeRequest = null; }
}

async function submitAccountCallback() {
  const pending = state.pendingAccountAuth;
  if (!pending) return;
  dom.submitAccountCallbackButton.disabled = true;
  try {
    await sendRuntime({ type: MESSAGE.SUBMIT_ACCOUNT_CALLBACK, provider: pending.provider,
      state: pending.state, redirectUrl: dom.accountCallbackInput.value.trim() });
    dom.accountCallbackInput.value = "";
    dom.accountStatus.textContent = "已提交授权结果，正在确认订阅账号...";
  } catch (error) {
    dom.accountStatus.textContent = error.message || String(error);
  } finally { dom.submitAccountCallbackButton.disabled = false; }
}

async function pollAccountAuthorization() {
  const pending = state.pendingAccountAuth;
  if (!pending) return;
  window.clearTimeout(state.accountPollTimer);
  if (state.accountPollInFlight) {
    state.accountPollTimer = window.setTimeout(pollAccountAuthorization, 1600);
    return;
  }
  state.accountPollInFlight = true;

  try {
    const response = await sendRuntime({
      type: MESSAGE.GET_ACCOUNT_AUTH_STATUS,
      state: pending.state
    });
    if (state.pendingAccountAuth?.state !== pending.state) return;
    pending.failures = 0;
    if (response.overview) {
      state.accountOverview = response.overview;
      renderAccountOverview({ preferredProvider: pending.provider });
    }

    if (response.status === "ok") {
      const provider = pending.provider;
      if (!state.accountOverview?.accounts?.[provider]?.connected
        || !state.accountOverview.models?.some((model) => model.provider === provider)) {
        pending.phase = "credentials";
        renderAccountOverview();
        dom.accountStatus.textContent = "正在确认账号凭证与可用模型...";
        return;
      }
      await persistSelectedAccountProvider(provider, { activate: state.settingsAccessMode === "account" });
      await sendRuntime({ type: MESSAGE.FINISH_ACCOUNT_AUTH, state: pending.state }).catch(() => {});
      stopAccountAuthPolling();
      dom.accountStatus.textContent = `${getAccountProviderLabel(provider)} 账号已连接。`;
      showToast(`${getAccountProviderLabel(provider)} 账号已连接`);
      return;
    }
    if (response.status === "error") {
      stopAccountAuthPolling();
      dom.accountStatus.textContent = response.error || "账号授权失败。";
      return;
    }
    pending.phase = response.phase || "authorizing";
    renderAccountOverview();
    dom.accountStatus.textContent = pending.phase === "models" ? "账号已授权，正在同步可用模型..."
      : pending.phase === "credentials" ? "授权页面已返回，正在确认本机账号凭证..."
      : `请在授权页面完成 ${getAccountProviderLabel(pending.provider)} 登录。`;
    if (Date.now() - pending.startedAt > 5 * 60 * 1000) {
      throw new Error("账号授权已超时，请重新授权。");
    }
  } catch (error) {
    if (state.pendingAccountAuth?.state !== pending.state) return;
    pending.failures = (pending.failures || 0) + 1;
    if (pending.failures >= 3 || Date.now() - pending.startedAt > 5 * 60 * 1000) {
      stopAccountAuthPolling();
      dom.accountStatus.textContent = error.message || String(error);
    } else dom.accountStatus.textContent = `暂时无法确认授权，正在重试：${error.message || error}`;
  } finally {
    state.accountPollInFlight = false;
    if (state.pendingAccountAuth?.state === pending.state) {
      window.clearTimeout(state.accountPollTimer);
      state.accountPollTimer = window.setTimeout(pollAccountAuthorization, 1600);
    }
  }
}

function stopAccountAuthPolling() {
  window.clearTimeout(state.accountPollTimer);
  state.accountPollTimer = null;
  state.pendingAccountAuth = null;
  dom.accountCallbackPanel.hidden = true;
  dom.accountCallbackPanel.open = false;
  dom.accountCallbackInput.value = "";
  renderAccountOverview();
  setAccountControlsBusy(false);
}

async function refreshAccountOverview(options = {}) {
  if (state.pendingAccountAuth) return;
  const requestId = ++state.accountOverviewRequestId;

  setAccountControlsBusy(true);
  if (!options.quiet) dom.accountStatus.textContent = "正在刷新账号与模型...";
  try {
    const overview = await sendRuntime({
      type: MESSAGE.GET_ACCOUNT_OVERVIEW,
      refreshModels: options.quiet !== true
    });
    if (requestId !== state.accountOverviewRequestId || state.pendingAccountAuth) return;
    state.accountOverview = overview;
    if (options.preferredProvider) state.selectedAccountProvider = options.preferredProvider;
    renderAccountOverview({ preferredProvider: options.preferredProvider });
    dom.accountStatus.textContent = state.accountOverview.modelError
      ? state.accountOverview.modelError
      : state.accountOverview.gatewayOnline
        ? state.accountOverview.activeProvider ? state.settings.accountProvider.model && !state.accountOverview.models.some((model) => model.id === state.settings.accountProvider.model)
          ? "原先选择的模型已不在当前目录中，请选择模型并保存设置。" : "订阅账号已连接，请选择可用模型。" : "请选择账号并完成授权登录。"
        : "VideoLens Bridge 未启动。";
  } catch (error) {
    if (requestId !== state.accountOverviewRequestId || state.pendingAccountAuth) return;
    renderAccountOverview();
    dom.accountStatus.textContent = error.message || String(error);
  } finally {
    if (requestId === state.accountOverviewRequestId && !state.pendingAccountAuth) setAccountControlsBusy(false);
  }
}

function renderAccountOverview(options = {}) {
  const accounts = state.accountOverview?.accounts || {};
  const activeProvider = state.accountOverview?.activeProvider || "";
  for (const row of dom.accountProviderRows) {
    const provider = row.dataset.providerRow;
    const account = accounts[provider];
    const connected = Boolean(account?.connected);
    const needsReauth = Boolean(account?.needsReauth);
    const pending = state.pendingAccountAuth?.provider === provider ? state.pendingAccountAuth : null;
    row.dataset.state = connected ? "connected" : pending ? "pending" : needsReauth ? "error" : "disconnected";
    dom.accountProviderStatuses[provider].textContent = connected
      ? account.label || `${account.count || 1} 个账号`
      : pending ? pending.phase === "credentials" ? "正在确认授权" : "正在等待授权"
      : needsReauth
        ? "需要重新授权"
        : "未连接";
    const button = row.querySelector("button");
    button.textContent = pending ? "授权中" : connected || needsReauth
      ? "重新授权"
      : activeProvider
        ? "切换"
        : "授权";
  }
  dom.logoutAccountButton.disabled = !activeProvider;

  const previousModel = dom.accountModelInput.value
    || state.settings.accountProvider.model
    || "";
  const models = Array.isArray(state.accountOverview?.models) ? state.accountOverview.models : [];
  dom.accountModelInput.replaceChildren();
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = state.accountOverview?.modelError ? "暂时无法获取模型，请刷新状态"
      : activeProvider ? "正在同步可用模型" : state.pendingAccountAuth ? "等待账号授权完成" : "授权账号后选择模型";
    dom.accountModelInput.appendChild(option);
    return;
  }

  const providerOrder = ["gpt", "claude", "gemini"];
  for (const provider of providerOrder) {
    const providerModels = models.filter((model) => model.provider === provider);
    if (!providerModels.length) continue;
    const group = document.createElement("optgroup");
    group.label = getAccountProviderLabel(provider);
    for (const model of providerModels) {
      const option = document.createElement("option");
      option.value = model.id;
      option.dataset.provider = provider;
      option.textContent = model.displayName || model.id;
      group.appendChild(option);
    }
    dom.accountModelInput.appendChild(group);
  }

  const preferredProvider = options.preferredProvider || state.selectedAccountProvider;
  const preferredModel = models.find((model) => model.id === previousModel)
    || models.find((model) => model.provider === preferredProvider)
    || models[0];
  if (preferredModel) {
    dom.accountModelInput.value = preferredModel.id;
    state.selectedAccountProvider = preferredModel.provider;
  }
}

function setAccountControlsBusy(busy, activeProvider = "") {
  dom.refreshAccountsButton.disabled = busy;
  dom.logoutAccountButton.disabled = busy || !state.accountOverview?.activeProvider;
  for (const button of dom.accountAuthButtons) {
    button.disabled = busy;
    const row = button.closest(".account-provider-row");
    if (busy && button.dataset.accountProvider === activeProvider) row.dataset.state = "pending";
    if (!busy && row.dataset.state === "pending") {
      row.dataset.state = state.accountOverview?.accounts?.[button.dataset.accountProvider]?.connected
        ? "connected"
        : state.accountOverview?.accounts?.[button.dataset.accountProvider]?.needsReauth
          ? "error"
          : "disconnected";
    }
  }
}

async function logoutAccount() {
  if (state.pendingAccountAuth) stopAccountAuthPolling();
  setAccountControlsBusy(true);
  dom.accountStatus.textContent = "正在退出账号并清理本地授权信息...";
  try {
    const response = await sendRuntime({ type: MESSAGE.LOGOUT_ACCOUNT });
    state.accountOverview = null;
    resetLocalAccountSelection();
    await storageSet({ [STORAGE.SETTINGS]: state.settings });
    renderAccountOverview();
    setSettingsAccessMode("api-key", { focus: false });
    const status = response?.warning || "账号已退出，本地授权信息已清理。";
    dom.accountStatus.textContent = status;
    dom.settingsStatus.textContent = status;
    showToast(response?.warning ? "账号已退出，请检查 Bridge" : "账号已退出");
  } catch (error) {
    dom.accountStatus.textContent = error.message || String(error);
  } finally {
    setAccountControlsBusy(false);
  }
}

function resetLocalAccountSelection() {
  state.selectedAccountProvider = "gpt";
  state.settings = mergeSettings({
    ...state.settings,
    authMode: "api-key",
    accountProvider: {
      provider: "gpt",
      model: "",
      supportsVision: state.settings.accountProvider.supportsVision !== false
    }
  });
}

async function persistSelectedAccountProvider(provider, options = {}) {
  const selectedOption = Array.from(dom.accountModelInput.options)
    .find((option) => option.dataset.provider === provider);
  if (!selectedOption) throw new Error("账号已授权，但尚未获取到可用模型，请刷新账号模型列表。");
  if (selectedOption) dom.accountModelInput.value = selectedOption.value;
  state.selectedAccountProvider = provider;
  state.settings = buildDraftSettings();
  if (options.activate !== false) state.settings.authMode = "account";
  await storageSet({ [STORAGE.SETTINGS]: state.settings });
  renderModeState();
}

function getAccountProviderLabel(provider) {
  if (provider === "claude") return "Claude";
  if (provider === "gemini") return "Gemini";
  return "ChatGPT / Codex";
}

function handleChatClick(event) {
  const timeButton = event.target.closest(".timestamp-link, .time-button");
  if (timeButton?.dataset.seconds) {
    seekTo(Number(timeButton.dataset.seconds));
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;

  const message = actionButton.closest(".message");
  const recordId = message?.dataset.recordId;
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;

  if (actionButton.dataset.action === "copy") {
    navigator.clipboard.writeText(record.answer || "")
      .then(() => showToast("回答已复制"))
      .catch(() => showToast("复制失败"));
  }

  if (actionButton.dataset.action === "delete") {
    if (state.sending) {
      showToast("回答生成完成后再删除记录");
      return;
    }
    state.records = state.records.filter((item) => item.id !== recordId);
    state.memory = createEmptyVideoMemory();
    persistCurrentSession().then(() => {
      render();
      showToast("记录已删除");
    });
  }
}

async function seekTo(seconds) {
  try {
    await sendToActiveTab({ type: MESSAGE.SEEK_TO, time: seconds });
    showToast(`已跳转到 ${formatTimestamp(seconds)}`);
  } catch (error) {
    showToast(error.message || "跳转失败");
  }
}

function getCurrentSession() {
  if (!state.sessionKey) return { records: [] };
  if (!state.sessions[state.sessionKey]) {
    state.sessions[state.sessionKey] = {
      sessionId: state.sessionKey,
      videoTitle: state.videoInfo?.title || "",
      videoUrl: normalizeVideoUrl(state.videoInfo?.url || ""),
      platform: state.videoInfo?.platform || "video",
      startedAt: new Date().toISOString(),
      records: [],
      memory: createEmptyVideoMemory()
    };
  }
  return state.sessions[state.sessionKey];
}

function buildSessionKey(info) {
  return `${info.platform || "video"}:${normalizeVideoUrl(info.url || "")}`;
}

function normalizeVideoUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      const videoId = parsed.searchParams.get("v");
      if (videoId) return `${parsed.origin}/watch?v=${videoId}`;
    }
    if (parsed.hostname.includes("bilibili.com")) {
      const normalized = `${parsed.origin}${parsed.pathname}`;
      const page = parsed.searchParams.get("p");
      return page ? `${normalized}?p=${page}` : normalized;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getContextStatusText() {
  if (!state.videoInfo) return "打开支持的视频页面后开始提问";
  return "结合当前视频内容回答";
}

function mergeSettings(partial) {
  const { speechToText: retiredServiceSettings, ...source } = partial || {};
  const partialProvider = source.aiProvider || {};
  const partialAccountProvider = source.accountProvider || {};
  const mergedProvider = {
    ...DEFAULT_SETTINGS.aiProvider,
    ...partialProvider,
    apiKey: partialProvider.apiKey ?? DEFAULT_SETTINGS.aiProvider.apiKey,
    baseUrl: partialProvider.baseUrl ?? DEFAULT_SETTINGS.aiProvider.baseUrl,
    model: partialProvider.model ?? DEFAULT_SETTINGS.aiProvider.model
  };
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    contextAfterSeconds: 0,
    authMode: source.authMode || DEFAULT_SETTINGS.authMode,
    aiProvider: mergedProvider,
    accountProvider: {
      provider: partialAccountProvider.provider
        || DEFAULT_SETTINGS.accountProvider.provider,
      model: partialAccountProvider.model
        || DEFAULT_SETTINGS.accountProvider.model,
      supportsVision: partialAccountProvider.supportsVision
        ?? DEFAULT_SETTINGS.accountProvider.supportsVision
    }
  };
}

function getActiveProviderSettings(settings = state.settings) {
  if (settings?.authMode !== "account") return settings.aiProvider;
  const account = settings.accountProvider || DEFAULT_SETTINGS.accountProvider;
  return {
    provider: "openai",
    apiKey: "",
    baseUrl: "",
    model: account.model || DEFAULT_SETTINGS.aiProvider.model,
    supportsVision: account.supportsVision !== false
  };
}

function renderMarkdown(markdown) {
  const source = String(markdown || "");
  const parts = source.split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      const code = part.replace(/^[a-zA-Z0-9_-]+\n/, "");
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    return renderTextBlocks(part);
  }).join("");
}

function renderTextBlocks(text) {
  const blocks = String(text).trim().split(/\n{2,}/).filter(Boolean);
  if (!blocks.length) return "";

  return blocks.map((block) => {
    const lines = block.split("\n");
    const isList = lines.every((line) => /^\s*[-*]\s+/.test(line));
    const isOrdered = lines.every((line) => /^\s*\d+\.\s+/.test(line));

    if (isList) {
      return `<ul>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    if (isOrdered) {
      return `<ol>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
    }

    return `<p>${lines.map((line) => renderInline(line)).join("<br>")}</p>`;
  }).join("");
}

function renderInline(text) {
  const source = String(text);
  const plain = (part) => linkTimestamps(escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"));
  let html = "", offset = 0;
  for (const match of source.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|`([^`\n]+)`/g)) {
    html += plain(source.slice(offset, match.index));
    if (match[3] !== undefined) html += `<code>${escapeHtml(match[3])}</code>`;
    else {
      const url = getSafeWebURL(match[2]);
      html += url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>` : plain(match[0]);
    }
    offset = match.index + match[0].length;
  }
  return html + plain(source.slice(offset));
}

function getSafeWebURL(value) {
  try {
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function getWebSources(record) {
  const sources = Array.isArray(record.webSearch?.sources) ? record.webSearch.sources : [];
  const seen = new Set();
  return sources.map((source) => ({ title: String(source.title || "网页来源").slice(0, 200), url: getSafeWebURL(source.url) }))
    .filter((source) => source.url && !seen.has(source.url) && seen.add(source.url)).slice(0, 6);
}

function linkTimestamps(html) {
  return html.replace(/\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g, (match, hours, minutes, seconds) => {
    const value = hours
      ? Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
      : Number(minutes) * 60 + Number(seconds);
    return `<button type="button" class="timestamp-link" data-seconds="${value}">${match}</button>`;
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeFileName(name) {
  return String(name || "videolens-notes")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    dom.toast.classList.remove("show");
  }, 2200);
}

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error?.message || "扩展后台请求失败。");
        error.code = response?.error?.code;
        error.runTrace = response?.error?.trace;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

async function sendToActiveTab(message) {
  if (state.targetTabId) {
    try {
      return await sendToTab(state.targetTabId, message);
    } catch {
      state.targetTabId = null;
    }
  }

  await resolveTargetTab();
  if (state.targetTabId) {
    try {
      return await sendToTab(state.targetTabId, message);
    } catch {
      state.targetTabId = null;
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("未找到当前视频标签页。");
  }

  state.targetTabId = tab.id;
  return sendToTab(tab.id, message);
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error("当前标签页未加载 VideoLens AI content script。"));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error?.message || "视频页面请求失败。"));
        return;
      }
      resolve(response.data);
    });
  });
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve();
    });
  });
}

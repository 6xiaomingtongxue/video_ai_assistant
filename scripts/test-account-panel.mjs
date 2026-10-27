import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor() { this.children = []; this.value = ""; this.textContent = ""; this.dataset = {}; }
  appendChild(element) { this.children.push(element); }
  replaceChildren() { this.children = []; this.value = ""; }
  get options() { return this.children.flatMap((element) => element.children.length ? element.children : [element]); }
}

function loadPanel() {
  const timers = new Map();
  let timerId = 0;
  const panel = vm.createContext({
    URL, console, structuredClone,
    document: { addEventListener() {}, createElement: () => new Element() },
    window: { setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); } }
  });
  vm.runInContext(fs.readFileSync("extension/src/sidepanel/sidepanel.js", "utf8"), panel);
  panel.testDOM = {
    accountProviderRows: ["gpt", "claude", "gemini"].map((provider) => ({ dataset: { providerRow: provider }, button: new Element(), querySelector() { return this.button; } })),
    accountProviderStatuses: { gpt: new Element(), claude: new Element(), gemini: new Element() },
    accountModelInput: new Element(), logoutAccountButton: new Element(), accountStatus: new Element(),
    accountCallbackPanel: new Element(), accountCallbackInput: new Element()
  };
  panel.savedSelections = [];
  vm.runInContext(`
    Object.assign(dom, testDOM);
    setAccountControlsBusy = () => {};
    showToast = () => {};
    setSettingsAccessMode = mode => { state.settingsAccessMode = mode; };
    persistSelectedAccountProvider = async provider => {
      savedSelections.push({provider, model: dom.accountModelInput.value});
      state.settings.authMode = 'account';
    };
    state.settingsAccessMode = 'account';
  `, panel);
  return { panel, timers, evaluate: (code) => vm.runInContext(code, panel) };
}

const empty = { gatewayOnline: true, activeProvider: "", accounts: { gpt: { connected: false }, claude: {}, gemini: {} }, models: [] };
const connected = { gatewayOnline: true, activeProvider: "gpt", accounts: { gpt: { connected: true, label: "测试账号", count: 1 }, claude: {}, gemini: {} }, models: [{ id: "gpt-ready", provider: "gpt" }] };

// Callback received -> credentials loading -> model catalog loading -> connected.
{
  const { panel, evaluate } = loadPanel();
  panel.queue = [
    { status: "wait", phase: "credentials", overview: empty },
    { status: "wait", phase: "models", overview: { ...connected, models: [] } },
    { status: "ok", overview: connected }
  ];
  panel.requests = [];
  panel.mockSend = async (message) => {
    panel.requests.push(message.type);
    return message.type === "VIDEO_LENS_FINISH_ACCOUNT_AUTH" ? { acknowledged: true } : panel.queue.shift();
  };
  evaluate("sendRuntime = mockSend; state.pendingAccountAuth = {provider:'gpt',state:'pending',startedAt:Date.now(),phase:'authorizing'};");
  await panel.pollAccountAuthorization();
  assert.equal(panel.testDOM.accountProviderStatuses.gpt.textContent, "正在确认授权");
  assert.equal(panel.savedSelections.length, 0);
  assert.ok(evaluate("state.pendingAccountAuth"));
  await panel.pollAccountAuthorization();
  assert.match(panel.testDOM.accountStatus.textContent, /同步可用模型/);
  assert.equal(panel.testDOM.accountProviderStatuses.gpt.textContent, "测试账号");
  assert.equal(panel.savedSelections.length, 0);
  await panel.pollAccountAuthorization();
  assert.equal(evaluate("state.pendingAccountAuth"), null);
  assert.equal(panel.savedSelections[0].model, "gpt-ready");
  assert.match(panel.testDOM.accountStatus.textContent, /账号已连接/);
  assert.equal(panel.testDOM.accountProviderRows[0].button.textContent, "重新授权");
  assert.ok(!panel.requests.includes("VIDEO_LENS_GET_ACCOUNT_OVERVIEW"), "use the verified success snapshot rather than a second potentially stale refresh");
  assert.equal(panel.requests.at(-1), "VIDEO_LENS_FINISH_ACCOUNT_AUTH");
}

// An older refresh must not overwrite a newer connected account.
{
  const { panel, evaluate } = loadPanel();
  const deferred = [];
  panel.mockSend = () => new Promise((resolve, reject) => deferred.push({ resolve, reject }));
  evaluate("sendRuntime = mockSend");
  const oldRefresh = panel.refreshAccountOverview();
  const newRefresh = panel.refreshAccountOverview();
  deferred[1].resolve(connected);
  await newRefresh;
  deferred[0].resolve(empty);
  await oldRefresh;
  assert.equal(evaluate("state.accountOverview.accounts.gpt.connected"), true);
  assert.equal(panel.testDOM.accountProviderStatuses.gpt.textContent, "测试账号");
  panel.mockFail = async () => { throw new Error("temporary local gateway error"); };
  evaluate("sendRuntime = mockFail");
  await panel.refreshAccountOverview();
  assert.equal(evaluate("state.accountOverview.accounts.gpt.connected"), true, "one transport error must not be rendered as logout");
  assert.match(panel.testDOM.accountStatus.textContent, /temporary local gateway error/);
}

// Closing/reopening a panel restores the pending login; one transport failure retries.
{
  const { panel, evaluate } = loadPanel();
  const pending = { provider: "gpt", state: "restore-state", startedAt: Date.now(), phase: "credentials" };
  panel.mockSend = async (message) => message.type === "VIDEO_LENS_GET_PENDING_ACCOUNT_AUTH"
    ? pending : { status: "wait", phase: "credentials", overview: empty };
  evaluate("sendRuntime = mockSend");
  await panel.resumeAccountAuthorization();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluate("state.pendingAccountAuth.state"), pending.state);
  panel.stopAccountAuthPolling();
  await panel.resumeAccountAuthorization();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluate("state.pendingAccountAuth.state"), pending.state);
  panel.mockFail = async () => { throw new Error("transient error"); };
  evaluate("sendRuntime = mockFail");
  await panel.pollAccountAuthorization();
  assert.ok(evaluate("state.pendingAccountAuth"));
  assert.match(panel.testDOM.accountStatus.textContent, /正在重试/);
}

// A failed authorization stops the pending labels and shows the actual error.
{
  const { panel, evaluate } = loadPanel();
  panel.mockSend = async () => ({ status: "error", error: "Token exchange timed out", overview: empty });
  evaluate("sendRuntime = mockSend; state.pendingAccountAuth = {provider:'gpt',state:'failed',startedAt:Date.now()};");
  await panel.pollAccountAuthorization();
  assert.equal(evaluate("state.pendingAccountAuth"), null);
  assert.equal(panel.testDOM.accountProviderStatuses.gpt.textContent, "未连接");
  assert.equal(panel.testDOM.accountProviderRows[0].button.textContent, "授权");
  assert.equal(panel.testDOM.accountStatus.textContent, "Token exchange timed out");
}

// Manual refresh reaches upstream; an expired saved choice and fetch errors are visible.
{
  const { panel, evaluate } = loadPanel();
  panel.requests = [];
  panel.mockSend = async message => { panel.requests.push(message); return connected; };
  evaluate("sendRuntime = mockSend; state.settings.accountProvider.model = 'retired-choice';");
  await panel.refreshAccountOverview();
  assert.equal(panel.requests[0].refreshModels, true);
  assert.match(panel.testDOM.accountStatus.textContent, /原先选择的模型/);
  await panel.refreshAccountOverview({ quiet: true });
  assert.equal(panel.requests.at(-1).refreshModels, false);
  panel.mockSend = async () => ({ ...connected, models: [], modelError: "Current catalog unavailable" });
  evaluate("sendRuntime = mockSend");
  await panel.refreshAccountOverview();
  assert.equal(panel.testDOM.accountModelInput.options[0].textContent, "暂时无法获取模型，请刷新状态");
  assert.equal(panel.testDOM.accountStatus.textContent, "Current catalog unavailable");
}

console.log("Account panel synchronization tests passed.");

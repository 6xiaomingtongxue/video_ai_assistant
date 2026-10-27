import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { evaluateBackground } from "./helpers/background-vm.mjs";

const root = process.cwd();
const source = fs.readFileSync(
  path.join(root, "extension/src/background/service_worker.js"),
  "utf8"
);

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    }
  };
}

function createContext(fetchMock, options = {}) {
  const openedTabs = [];
  const nativeRequests = [];
  const storage = structuredClone(options.storage || {});
  const bridgeConfig = {
    version: "0.1.0",
    gatewayBaseUrl: "http://127.0.0.1:18317",
    managementKey: "management-secret",
    clientApiKey: "client-secret",
    ...(options.bridgeConfig || {})
  };
  const nativePorts = [];
  function newNativePort() {
    const nativeOnMessage = createEvent();
    const nativeOnDisconnect = createEvent();
    const nativePort = {
    onMessage: nativeOnMessage,
    onDisconnect: nativeOnDisconnect,
    disconnect() {},
    postMessage(message) {
      nativeRequests.push(message);
      queueMicrotask(() => {
        if (message.type === "bridge.config" || message.type === "bridge.ping") {
          nativeOnMessage.emit({ id: message.id, ok: true, data: bridgeConfig });
          return;
        }
        if (message.type === "credentials.clear") {
          if (options.credentialClearError) {
            nativeOnMessage.emit({ id: message.id, ok: false, error: options.credentialClearError });
            return;
          }
          nativeOnMessage.emit({ id: message.id, ok: true, data: { removed: 1 } });
          return;
        }
        if (message.type === "models.list") {
          if (options.catalogError) { nativeOnMessage.emit({ id: message.id, ok: false, error: options.catalogError }); return; }
          const models = typeof options.accountModels === "function" ? options.accountModels(message.data) : options.accountModels;
          nativeOnMessage.emit({ id: message.id, ok: true, data: {
            source: options.catalogSource || "account",
            models: models || [{ id: "gpt-test", displayName: "Current GPT", provider: "gpt", supportsVision: true }]
          } });
          return;
        }
        nativeOnMessage.emit({ id: message.id, ok: false, error: "unexpected native message" });
      });
    }
    };
    nativePorts.push(nativePort);
    return nativePort;
  }

  const context = vm.createContext({
    URL,
    AbortController,
    Response,
    Headers,
    Request,
    console,
    crypto: webcrypto,
    fetch: fetchMock,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        lastError: null,
        getURL: (value) => `chrome-extension://test/${value}`,
        connectNative(name) {
          assert.equal(name, "com.videolens.bridge");
          return newNativePort();
        },
        onInstalled: createEvent(),
        onMessage: createEvent()
      },
      action: { onClicked: createEvent() },
      commands: { onCommand: createEvent() },
      sidePanel: {},
      tabs: {
        create(tabOptions, callback) {
          openedTabs.push(tabOptions);
          callback({ id: 10, ...tabOptions });
        }
      },
      storage: {
        local: {
          get(key, callback) {
            callback({ [key]: storage[key] });
          },
          set(value, callback) {
            Object.assign(storage, structuredClone(value));
            callback();
          }
        }
      }
    }
  });
  evaluateBackground(context, source);
  return { context, openedTabs, nativeRequests, nativePorts, storage };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function testAuthorizationFlow() {
  const requests = [];
  const { context, openedTabs, nativeRequests, storage } = createContext(async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({
      url: parsed.toString(),
      authorization: new Headers(options.headers || {}).get("Authorization")
    });
    if (parsed.pathname.endsWith("/codex-auth-url")) {
      return jsonResponse({
        status: "ok",
        state: "oauth-state-1",
        url: "https://auth.openai.com/oauth/authorize?state=oauth-state-1"
      });
    }
    if (parsed.pathname.endsWith("/get-auth-status")) {
      return jsonResponse({ status: "ok" });
    }
    if (parsed.pathname.endsWith("/auth-files")) return jsonResponse({ files: [{ provider: "codex", status: "active" }] });
    if (parsed.pathname.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-test", owned_by: "openai" }] });
    throw new Error(`Unexpected URL: ${parsed}`);
  }, {
    storage: {
      "videolens:settings": {
        authMode: "account",
        accountProvider: { provider: "claude", model: "claude-sonnet-4-6", supportsVision: true }
      }
    }
  });

  const started = await context.startAccountAuthorization("gpt");
  assert.equal(started.state, "oauth-state-1");
  assert.equal(openedTabs.length, 1);
  assert.equal(new URL(openedTabs[0].url).hostname, "auth.openai.com");
  assert.equal(requests[0].authorization, "Bearer management-secret");
  assert.match(requests[0].url, /is_webui=true/);
  assert.deepEqual(
    nativeRequests.map((request) => request.type),
    ["bridge.config", "credentials.clear", "bridge.config"]
  );
  assert.equal(storage["videolens:settings"].authMode, "api-key");
  assert.equal(storage["videolens:settings"].accountProvider.model, "");

  const status = await context.getAccountAuthorizationStatus(started.state);
  assert.equal(status.status, "ok");
  assert.equal(requests[1].authorization, "Bearer management-secret");
  assert.equal(status.overview.accounts.gpt.connected, true);
  assert.equal(storage["videolens:pendingAccountAuth"].phase, "ready");
  await context.finishAccountAuthorization(started.state);
  assert.equal(storage["videolens:pendingAccountAuth"], null);
}

async function testAuthorizationWaitsForAccountAndModels() {
  let credentialsReady = false;
  let modelsReady = false;
  const pending = { provider: "gpt", state: "sync-state", startedAt: Date.now(), phase: "authorizing" };
  const mock = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/get-auth-status")) return jsonResponse({ status: "ok" });
    if (pathname.endsWith("/auth-files")) return jsonResponse({ files: credentialsReady ? [{ provider: "unknown-version-name", type: "codex", status: "active" }] : [] });
    if (pathname.endsWith("/models")) return jsonResponse({ data: modelsReady ? [{ id: "gpt-test", owned_by: "openai" }] : [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const first = createContext(mock, { storage: { "videolens:pendingAccountAuth": pending } });
  let status = await first.context.getAccountAuthorizationStatus(pending.state);
  assert.equal(status.status, "wait", "an OAuth callback must not be treated as a connected account");
  assert.equal(status.phase, "credentials");
  assert.equal(first.storage["videolens:pendingAccountAuth"].state, pending.state);

  // A fresh service worker must recover the same pending authorization.
  const restarted = createContext(mock, { storage: first.storage,
    accountModels: () => modelsReady ? [{ id: "gpt-test", provider: "gpt", supportsVision: true }] : [] });
  assert.equal((await restarted.context.getPendingAccountAuthorization()).state, pending.state);
  credentialsReady = true;
  status = await restarted.context.getAccountAuthorizationStatus(pending.state);
  assert.equal(status.status, "wait");
  assert.equal(status.phase, "models");
  assert.equal(status.overview.accounts.gpt.connected, true);
  modelsReady = true;
  status = await restarted.context.getAccountAuthorizationStatus(pending.state);
  assert.equal(status.status, "ok");
  assert.equal(status.overview.models[0].id, "gpt-test");
  assert.equal(restarted.storage["videolens:pendingAccountAuth"].phase, "ready", "retain success until the panel saves its selection");
  await restarted.context.finishAccountAuthorization("a-different-state");
  assert.ok(restarted.storage["videolens:pendingAccountAuth"]);
  await restarted.context.finishAccountAuthorization(pending.state);
  assert.equal(await restarted.context.getPendingAccountAuthorization(), null);
  assert.ok(!JSON.stringify(restarted.storage).includes("management-secret"));
  assert.ok(!JSON.stringify(restarted.storage).includes("client-secret"));
}

async function testAuthorizationNeverCreatesFalseConnection() {
  const pending = { provider: "gpt", state: "missing-credentials", startedAt: Date.now(), phase: "credentials", confirmationStartedAt: Date.now() - 46000 };
  const { context, storage } = createContext(async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/get-auth-status")) return jsonResponse({ status: "ok" });
    if (pathname.endsWith("/auth-files")) return jsonResponse({ files: [] });
    return jsonResponse({ data: [] });
  }, { storage: { "videolens:pendingAccountAuth": pending } });
  const status = await context.getAccountAuthorizationStatus(pending.state);
  assert.equal(status.status, "error");
  assert.match(status.error, /未保存可用的账号凭证/);
  assert.equal(storage["videolens:pendingAccountAuth"], null);
  assert.equal((await context.getAccountAuthorizationStatus("unknown-state")).status, "error");

  const failure = createContext(async () => jsonResponse({ status: "error", error: "Token exchange timed out" }), {
    storage: { "videolens:pendingAccountAuth": { ...pending, confirmationStartedAt: undefined } }
  });
  assert.equal((await failure.context.getAccountAuthorizationStatus(pending.state)).error, "Token exchange timed out");

  let blockedRequests = 0;
  const region = createContext(async () => {
    blockedRequests += 1;
    return jsonResponse({ status: "error", error: 'Failed to exchange authorization code for tokens: token exchange failed with status 403: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}' });
  }, { storage: { "videolens:pendingAccountAuth": pending } });
  const rejected = await region.context.getAccountAuthorizationStatus(pending.state);
  assert.equal(rejected.errorCode, "unsupported_country_region_territory");
  assert.match(rejected.error, /OpenAI.*请求地区/);
  assert.match(rejected.error, /授权未完成/);
  assert.ok(!rejected.error.includes('{"error"'), "show a readable explanation instead of overflowing JSON");
  assert.equal(region.storage["videolens:pendingAccountAuth"], null);
  await region.context.getAccountAuthorizationStatus(pending.state);
  assert.equal(blockedRequests, 1, "a regional rejection must stop polling instead of repeating the token flow");
}

async function testOldNativeDisconnectCannotClearNewConnection() {
  const { context, nativePorts } = createContext(async () => jsonResponse({}));
  await context.getBridgeGateway();
  const old = nativePorts[0];
  context.disconnectBridge();
  const reconnect = context.getBridgeGateway();
  old.onMessage.emit({ ok: false, error: "Old host stopped" });
  await reconnect;
  assert.equal(nativePorts.length, 2);
  old.onDisconnect.emit();
  const gateway = await context.getBridgeGateway();
  assert.equal(gateway.baseUrl, "http://127.0.0.1:18317");
  assert.equal(nativePorts.length, 2, "a late disconnect from an old host must not reconnect or lose the new host");
}

async function testManualCallback() {
  const requests = [];
  const { context } = createContext(async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/anthropic-auth-url")) return jsonResponse({ state: "claude-state", url: "https://claude.ai/oauth/authorize?state=claude-state" });
    if (pathname.endsWith("/oauth-callback")) {
      requests.push({ url, options });
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({ status: "wait" });
  });
  await context.startAccountAuthorization("claude");
  await assert.rejects(context.submitAccountCallback("claude", "claude-state", "https://example.com/?code=secret&state=claude-state"), /回调地址/);
  await assert.rejects(context.submitAccountCallback("claude", "claude-state", "http://localhost:54545/?code=secret&state=wrong-state"), /回调地址/);
  await assert.rejects(context.submitAccountCallback("gpt", "claude-state", "http://localhost:54545/?code=secret&state=claude-state"), /过期/);
  await context.submitAccountCallback("claude", "claude-state", "http://localhost:54545/?code=secret&state=claude-state");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(new Headers(requests[0].options.headers).get("Authorization"), "Bearer management-secret");
  assert.equal(JSON.parse(requests[0].options.body).provider, "anthropic");
  assert.equal(requests[0].options.redirect, "error");
}

async function testAPIConnectionAndModels() {
  const requests = [];
  const { context, nativeRequests } = createContext(async (url, options = {}) => {
    requests.push({ url, options });
    if (new URL(url).pathname.endsWith("/models")) return jsonResponse({ data: [{ id: "deepseek-flash" }, { id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    return jsonResponse({ model: "deepseek-flash", choices: [{ message: { content: "OK" } }] });
  });
  const settings = { authMode: "api-key", aiProvider: {
    baseUrl: "https://api.deepseek.com/chat/completions/", apiKey: "deepseek-key", model: "deepseek-flash", supportsVision: false
  } };
  const result = await context.testProvider(settings);
  assert.match(result.message, /调用成功/);
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(requests[0].options.method, "POST", "testing a model must not only query /models");
  assert.equal(new Headers(requests[0].options.headers).get("Authorization"), "Bearer deepseek-key");
  assert.equal(JSON.parse(requests[0].options.body).model, "deepseek-flash");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(nativeRequests.length, 0, "API access must not start the subscription bridge");
  const models = await context.listAPIModels({ aiProvider: { ...settings.aiProvider, model: "" } });
  assert.deepEqual(Array.from(models.models), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(requests[1].url, "https://api.deepseek.com/models");
  assert.equal(context.normalizeProviderBaseURL("https://relay.example/custom/v1/chat/completions"), "https://relay.example/custom/v1");
  assert.equal(context.normalizeProviderBaseURL("http://[::1]:8080/v1/"), "http://[::1]:8080/v1");
  for (const baseUrl of ["file:///secret", "https://key@relay.example/v1", "https://relay.example/v1?api_key=secret", "http://relay.example/v1"]) {
    assert.throws(() => context.normalizeProviderBaseURL(baseUrl), /Base URL|HTTPS/);
  }
}

async function testDirectAPIChatAndSummary() {
  const requests = [];
  const { context, nativeRequests } = createContext(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({ model: "relay-model", choices: [{ message: { content: "API response" } }] });
  });
  const settings = { authMode: "api-key", enableWebSearch: false, aiProvider: { baseUrl: "https://relay.example/api/v1", apiKey: "relay-key", model: "relay-model", supportsVision: false } };
  const reply = await context.askAI({ question: "Explain", context: { videoInfo: { title: "Lesson", currentTime: 0 }, textContext: { items: [{ start: 0, end: 1, text: "video text" }] } } }, settings);
  assert.equal(reply.answer, "API response");
  await context.summarizeMemory({ records: [{ question: "Question", answer: "Answer", timestamp: 0 }] }, settings);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.url === "https://relay.example/api/v1/chat/completions"));
  assert.ok(requests.every((item) => new Headers(item.options.headers).get("Authorization") === "Bearer relay-key"));
  assert.equal(nativeRequests.length, 0);
}

async function testSubscriptionRoutingAndEntitlement() {
  const requests = [];
  let connected = true;
  const { context } = createContext(async (url, options = {}) => {
    requests.push({ url, options });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/auth-files")) return jsonResponse({ files: connected ? [{ provider: "codex", status: "active" }] : [] });
    if (pathname.endsWith("/models")) return jsonResponse({ data: [{ id: "my-subscription-alias", owned_by: "openai" }] });
    return jsonResponse({ choices: [{ message: { content: "Subscription response" } }] });
  }, { accountModels: [{ id: "my-subscription-alias", provider: "gpt", supportsVision: false }] });
  const settings = {
    authMode: "account",
    aiProvider: { baseUrl: "https://relay.example/v1", apiKey: "api-key-must-stay-private", model: "api-model" },
    accountProvider: { provider: "gpt", model: "my-subscription-alias" }
  };
  await context.testProvider(settings);
  const chat = requests.find((request) => new URL(request.url).pathname.endsWith("/chat/completions"));
  assert.equal(chat.url, "http://127.0.0.1:18317/v1/chat/completions");
  assert.equal(new Headers(chat.options.headers).get("Authorization"), "Bearer client-secret");
  assert.equal(JSON.parse(chat.options.body).model, "my-subscription-alias");
  assert.ok(!JSON.stringify(requests).includes("api-key-must-stay-private"));
  assert.ok(!JSON.stringify(chat).includes("management-secret"));
  await assert.rejects(context.testProvider({ ...settings, accountProvider: { provider: "gpt", model: "not-available" } }), /可用列表/);
  connected = false;
  await assert.rejects(context.testProvider(settings), /订阅账号/);
}

async function testAccountCatalogSourceAndRefresh() {
  const fetchMock = async (url) => {
    if (new URL(url).pathname.endsWith("/auth-files")) return jsonResponse({ files: [{ provider: "codex", status: "active" }] });
    throw new Error("Codex models must not be loaded from the SDK's static /v1/models endpoint");
  };
  const accountModels = [
    { id: "current-z", provider: "gpt", displayName: "Current text", supportsVision: false },
    { id: "current-a", provider: "gpt", displayName: "Current vision", supportsVision: true }
  ];
  const { context, nativeRequests } = createContext(fetchMock, { accountModels });
  const overview = await context.getAccountOverview({ refreshModels: true });
  assert.deepEqual(Array.from(overview.models, model => model.id), ["current-z", "current-a"], "preserve upstream order");
  assert.equal(nativeRequests.find(message => message.type === "models.list").data.refresh, true);
  const settings = await context.resolveSettings({ authMode: "account", accountProvider: { provider: "gpt", model: "current-z", supportsVision: true } });
  assert.equal(settings.aiProvider.supportsVision, false, "catalog capabilities must prevent images being sent to a text-only model");
  const unavailable = createContext(fetchMock, { catalogError: "Unable to refresh current account models" });
  const failed = await unavailable.context.getAccountOverview();
  assert.equal(failed.accounts.gpt.connected, true);
  assert.equal(failed.models.length, 0);
  assert.match(failed.modelError, /Unable to refresh/);
  const old = createContext(fetchMock, { catalogSource: "static" });
  assert.match((await old.context.getAccountOverview()).modelError, /更新 VideoLens Bridge/);
}

async function testAccessModeErrors() {
  const { context } = createContext(async () => jsonResponse({ error: { message: "denied" } }, 401));
  const apiProvider = { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "local-api-key", model: "local-model", accessMode: "api-key" };
  await assert.rejects(context.requestModelJSON(apiProvider, "chat/completions", { model: "local-model" }), /API Key/);
  await assert.rejects(context.requestModelJSON({ ...apiProvider, accessMode: "account" }, "chat/completions", { model: "local-model" }), /订阅账号授权/);
  const limited = createContext(async () => jsonResponse({}, 429)).context;
  await assert.rejects(limited.requestModelJSON({ ...apiProvider, accessMode: "account" }, "chat/completions", {}), /订阅账号暂时达到/);
  const noCatalog = createContext(async () => jsonResponse({}, 404)).context;
  await assert.rejects(noCatalog.listAPIModels({ aiProvider: apiProvider }), /404/);
}

async function testOverviewAndModels() {
  const { context } = createContext(async (url, options = {}) => {
    const parsed = new URL(url);
    const authorization = new Headers(options.headers || {}).get("Authorization");
    if (parsed.pathname.endsWith("/auth-files")) {
      assert.equal(authorization, "Bearer management-secret");
      return jsonResponse({
        files: [
          { provider: "codex", email: "gpt@example.com", status: "active" },
          { provider: "codex", email: "disabled@example.com", disabled: true }
        ]
      });
    }
    if (parsed.pathname.endsWith("/v1/models")) {
      assert.equal(authorization, "Bearer client-secret");
      return jsonResponse({
        data: [
          { id: "gpt-5.5", owned_by: "openai" },
          { id: "claude-sonnet-4-6", owned_by: "anthropic" },
          { id: "gemini-2.5-pro", owned_by: "google" }
        ]
      });
    }
    throw new Error(`Unexpected URL: ${parsed}`);
  }, { accountModels: [{ id: "current-text-model", displayName: "Current Text Model", provider: "gpt", supportsVision: false }] });

  const overview = await context.getAccountOverview();
  assert.equal(overview.activeProvider, "gpt");
  assert.equal(overview.accounts.gpt.connected, true);
  assert.equal(overview.accounts.claude.connected, false);
  assert.equal(overview.accounts.gemini.connected, false);
  assert.deepEqual(
    Array.from(overview.models, (model) => `${model.provider}:${model.id}`),
    ["gpt:current-text-model"]
  );
  assert.equal(JSON.stringify(overview).includes("management-secret"), false);
  assert.equal(JSON.stringify(overview).includes("client-secret"), false);
}

async function testLogoutClearsStoredSelection() {
  const { context, nativeRequests, storage } = createContext(async () => jsonResponse({}), {
    storage: {
      "videolens:settings": {
        authMode: "account",
        accountProvider: { provider: "claude", model: "claude-sonnet-4-6", supportsVision: true }
      }
    }
  });
  const result = await context.logoutAccount();
  assert.equal(result.disconnected, true);
  assert.equal(result.removed, 1);
  assert.equal(nativeRequests.at(-1).type, "credentials.clear");
  assert.equal(storage["videolens:settings"].authMode, "api-key");
  assert.equal(storage["videolens:settings"].accountProvider.model, "");
  assert.equal(JSON.stringify(storage).includes("management-secret"), false);
}

async function testLogoutClearsStoredSelectionWhenBridgeFails() {
  const { context, storage } = createContext(async () => jsonResponse({}), {
    credentialClearError: "credential cleanup failed",
    storage: {
      "videolens:settings": {
        authMode: "account",
        accountProvider: { provider: "gemini", model: "gemini-2.5-pro", supportsVision: true }
      }
    }
  });
  const result = await context.logoutAccount();
  assert.equal(result.disconnected, true);
  assert.equal(result.removed, 0);
  assert.match(result.warning, /未能确认清理/);
  assert.equal(storage["videolens:settings"].authMode, "api-key");
  assert.equal(storage["videolens:settings"].accountProvider.model, "");
}

function testSecurityBoundaries() {
  const { context } = createContext(async () => jsonResponse({}));
  assert.throws(
    () => context.normalizeAccountGateway({
      gatewayBaseUrl: "https://example.com",
      managementKey: "secret"
    }),
    /VideoLens Bridge/
  );
  assert.throws(
    () => context.validateProviderAuthorizationURL("gpt", "https://example.com/oauth"),
    /非官方授权地址/
  );
  assert.throws(() => context.validateOAuthState("../../secret"), /无效的授权状态/);

  const provider = context.resolveActiveProviderSettings({
    authMode: "account",
    aiProvider: { baseUrl: "https://api.openai.com/v1", model: "api-model" },
    accountProvider: {
      provider: "claude",
      model: "claude-sonnet-4-6",
      supportsVision: true
    }
  }, {
    gatewayBaseUrl: "http://127.0.0.1:18317",
    clientApiKey: "client-secret",
    managementKey: "management-secret"
  });
  assert.equal(provider.baseUrl, "http://127.0.0.1:18317/v1");
  assert.equal(provider.apiKey, "client-secret");
  assert.equal(provider.model, "claude-sonnet-4-6");
}

await testAuthorizationFlow();
await testAuthorizationWaitsForAccountAndModels();
await testAuthorizationNeverCreatesFalseConnection();
await testOldNativeDisconnectCannotClearNewConnection();
await testManualCallback();
await testOverviewAndModels();
await testLogoutClearsStoredSelection();
await testLogoutClearsStoredSelectionWhenBridgeFails();
testSecurityBoundaries();
await testAPIConnectionAndModels();
await testDirectAPIChatAndSummary();
await testSubscriptionRoutingAndEntitlement();
await testAccountCatalogSourceAndRefresh();
await testAccessModeErrors();
console.log("Account authorization tests passed.");

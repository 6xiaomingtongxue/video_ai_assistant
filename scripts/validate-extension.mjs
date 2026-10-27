import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const extensionDir = path.join(root, "extension");
const manifestPath = path.join(extensionDir, "manifest.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(extensionDir, relativePath));
}

function checkScript(relativePath, module = false) {
  const fullPath = path.join(extensionDir, relativePath);
  const code = fs.readFileSync(fullPath, "utf8");
  try {
    if (module || relativePath.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: code, encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || "Module syntax check failed");
    } else new vm.Script(code, { filename: relativePath });
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
  }
}

function normalizeExtensionPath(fromPath, referencedPath) {
  if (!referencedPath || /^(?:https?:|data:|#)/i.test(referencedPath)) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath.replaceAll("\\", "/")), referencedPath));
}

function checkHtmlReferences(relativePath) {
  const fullPath = path.join(extensionDir, relativePath);
  const html = fs.readFileSync(fullPath, "utf8");
  const references = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi),
    ...html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)
  ];

  for (const match of references) {
    const referencedPath = normalizeExtensionPath(relativePath, match[1]);
    if (referencedPath) assert(exists(referencedPath), `missing ${referencedPath} referenced by ${relativePath}`);
  }

  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/gi)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert(duplicateIds.length === 0, `${relativePath} has duplicate ids: ${[...new Set(duplicateIds)].join(", ")}`);
}

assert(manifest.manifest_version === 3, "manifest_version must be 3");
assert(Boolean(manifest.background?.service_worker), "background service worker is required");
assert(Boolean(manifest.side_panel?.default_path), "side panel page is required");
assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0, "content script is required");
assert(manifest.permissions?.includes("nativeMessaging"), "nativeMessaging permission is required for VideoLens Bridge");

assert(exists(manifest.background.service_worker), `missing ${manifest.background.service_worker}`);
assert(exists(manifest.side_panel.default_path), `missing ${manifest.side_panel.default_path}`);

for (const entry of manifest.content_scripts || []) {
  for (const script of entry.js || []) assert(exists(script), `missing ${script}`);
  for (const style of entry.css || []) assert(exists(style), `missing ${style}`);
}

for (const entry of manifest.web_accessible_resources || []) {
  for (const resource of entry.resources || []) assert(exists(resource), `missing web accessible resource ${resource}`);
}

const exposedResources = (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []);
assert(
  !exposedResources.some((resource) => resource.includes("local_settings")),
  "local_settings must not be web accessible"
);

checkScript(manifest.background.service_worker, manifest.background.type === "module");
assert(exists("src/background/question_harness.mjs"), "question harness module is required");
checkScript("src/background/question_harness.mjs");
assert(exists("src/background/course_memory.mjs"), "course memory module is required");
checkScript("src/background/course_memory.mjs");
for (const entry of manifest.content_scripts || []) {
  for (const script of entry.js || []) checkScript(script);
}
checkScript("src/sidepanel/sidepanel.js");
checkHtmlReferences(manifest.side_panel.default_path);
assert(!manifest.permissions.includes("tabCapture"), "complete video text must not depend on playback capture permission");

const contentScript = fs.readFileSync(path.join(extensionDir, "src/content/content_script.js"), "utf8");
const backgroundScript = fs.readFileSync(path.join(extensionDir, manifest.background.service_worker), "utf8");
const sidepanelScript = fs.readFileSync(path.join(extensionDir, "src/sidepanel/sidepanel.js"), "utf8");
const sidepanelHtml = fs.readFileSync(path.join(extensionDir, manifest.side_panel.default_path), "utf8");
assert(!contentScript.includes("videolens-ai-inline"), "legacy inline assistant code is still present");
assert(
  contentScript.includes("VIDEO_LENS_REGISTER_TARGET_TAB") && backgroundScript.includes("VIDEO_LENS_REGISTER_TARGET_TAB"),
  "target tab registration message must exist in content and background scripts"
);
assert(
  sidepanelScript.includes("VIDEO_LENS_SUMMARIZE_MEMORY") && backgroundScript.includes("VIDEO_LENS_SUMMARIZE_MEMORY"),
  "video memory summary message must exist in sidepanel and background scripts"
);
assert(
  contentScript.includes("relatedTranscriptContext") && backgroundScript.includes("relatedTranscriptContext"),
  "related transcript retrieval must exist in content and background scripts"
);
assert(
  sidepanelScript.includes("recentTurns: 6") && backgroundScript.includes("conversation.slice(-6)"),
  "recent video conversation memory must keep six turns on both sides"
);
assert(
  !sidepanelScript.includes("state.records.slice(-4)") && !backgroundScript.includes("conversation.slice(-4)"),
  "legacy four-turn conversation limit is still present"
);
assert(
  sidepanelScript.includes("VIDEO_LENS_START_ACCOUNT_AUTH")
    && sidepanelScript.includes("VIDEO_LENS_GET_ACCOUNT_AUTH_STATUS")
    && sidepanelScript.includes("VIDEO_LENS_LOGOUT_ACCOUNT")
    && backgroundScript.includes("VIDEO_LENS_START_ACCOUNT_AUTH")
    && backgroundScript.includes("VIDEO_LENS_GET_ACCOUNT_AUTH_STATUS")
    && backgroundScript.includes("VIDEO_LENS_LOGOUT_ACCOUNT"),
  "account authorization messages must exist in sidepanel and background scripts"
);
for (const provider of ["gpt", "claude", "gemini"]) {
  assert(
    sidepanelHtml.includes(`data-account-provider="${provider}"`),
    `sidepanel is missing the ${provider} account authorization button`
  );
}
assert(
  backgroundScript.includes("normalizeAccountGateway")
    && backgroundScript.includes('new Set(["localhost", "127.0.0.1", "[::1]", "::1"])')
    && backgroundScript.includes('BRIDGE_NATIVE_HOST = "com.videolens.bridge"'),
  "account management requests must remain restricted to VideoLens Bridge"
);
assert(
  backgroundScript.includes('authHosts: new Set(["auth.openai.com"])')
    && backgroundScript.includes('authHosts: new Set(["claude.ai"])')
    && backgroundScript.includes('authHosts: new Set(["accounts.google.com"])'),
  "account authorization URLs must remain restricted to official provider hosts"
);
assert(
  backgroundScript.includes("settings: getContentContextSettings(settings)"),
  "content context requests must use sanitized settings"
);
assert(
  sidepanelScript.includes("VIDEO_LENS_GET_VIDEO_CONTEXT")
    && backgroundScript.includes("getVideoTextContext")
    && !sidepanelHtml.includes("audioCaptureButton")
    && !sidepanelHtml.includes('name="contextMode"'),
  "video text must use one automatic context interface without source controls"
);
assert(
  fs.existsSync(path.join(root, "bridge/main.go"))
    && fs.existsSync(path.join(root, "scripts/install-bridge.ps1")),
  "VideoLens Bridge sources or installer are missing"
);
assert(
  !sidepanelHtml.includes("speechBaseUrlInput") && !sidepanelHtml.includes("speechApiKeyInput")
    && backgroundScript.includes('requestBridge("text.config")'),
  "video text must use automatic Bridge configuration without manual service fields"
);
assert(
  !sidepanelHtml.includes("accountGatewayInput")
    && !sidepanelHtml.includes("accountManagementKeyInput")
    && sidepanelHtml.includes("logoutAccountButton"),
  "account settings must use automatic Bridge discovery and expose logout"
);
assert(
  sidepanelHtml.includes("API 接入") && sidepanelHtml.includes("订阅账号")
    && sidepanelHtml.includes("refreshAPIModelsButton")
    && backgroundScript.includes("VIDEO_LENS_LIST_API_MODELS")
    && backgroundScript.includes("VIDEO_LENS_SUBMIT_ACCOUNT_CALLBACK"),
  "model access must expose API configuration and subscription authorization as separate routes"
);

if (failures.length) {
  console.error("Extension validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Extension validation passed.");

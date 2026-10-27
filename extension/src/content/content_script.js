(() => {
  const MESSAGE = {
    REGISTER_TARGET_TAB: "VIDEO_LENS_REGISTER_TARGET_TAB",
    GET_BASIC_INFO: "VIDEO_LENS_GET_BASIC_INFO",
    GET_CONTEXT: "VIDEO_LENS_GET_CONTEXT",
    SEEK_TO: "VIDEO_LENS_SEEK_TO",
    CAPTURE_VISIBLE_TAB: "VIDEO_LENS_CAPTURE_VISIBLE_TAB"
  };

  const DEFAULT_CAPTURE = {
    maxWidth: 1280,
    mimeType: "image/jpeg",
    quality: 0.72
  };

  const transcriptCache = {
    key: "",
    items: null,
    error: null
  };

  const visibleCaptionState = {
    items: [],
    lastText: "",
    lastStart: 0,
    lastSeenAt: 0,
    observer: null,
    timer: null,
    maxItems: 500
  };

  let floatingRoot = null;
  let embeddedSidePanel = null;
  let fullscreenLayoutRoot = null;
  let lastUrl = location.href;
  let toastTimer = null;
  let ensureButtonScheduled = false;
  let captionSnapshotScheduled = false;

  init();

  function init() {
    ensureFloatingButton();
    startVisibleCaptionCapture();
    observeNavigation();
    window.addEventListener("keydown", handleShortcut, true);
    document.addEventListener("fullscreenchange", handleFullscreenChange, true);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange, true);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== "string") return false;

      if (message.type === MESSAGE.GET_BASIC_INFO) {
        respond(sendResponse, collectBasicInfo());
        return true;
      }

      if (message.type === MESSAGE.GET_CONTEXT) {
        respond(sendResponse, collectContext(message.payload || {}));
        return true;
      }

      if (message.type === MESSAGE.SEEK_TO) {
        respond(sendResponse, seekTo(message.time));
        return true;
      }

      return false;
    });
  }

  function respond(sendResponse, promise) {
    Promise.resolve(promise)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
  }

  function observeNavigation() {
    const observer = new MutationObserver(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        transcriptCache.key = "";
        transcriptCache.items = null;
        transcriptCache.error = null;
        resetVisibleCaptions();
      }
      scheduleEnsureFloatingButton();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(ensureFloatingButton, 1500);
  }

  function scheduleEnsureFloatingButton() {
    if (ensureButtonScheduled) return;
    ensureButtonScheduled = true;
    window.requestAnimationFrame(() => {
      ensureButtonScheduled = false;
      ensureFloatingButton();
    });
  }

  function ensureFloatingButton() {
    const video = findVideo();
    if (!video || sessionStorage.getItem("videolens:hidden") === "1") {
      if (floatingRoot) floatingRoot.hidden = true;
      return;
    }

    if (floatingRoot && !floatingRoot.isConnected) {
      mountOverlayElement(floatingRoot);
    }

    if (!floatingRoot) {
      floatingRoot = document.createElement("div");
      floatingRoot.id = "videolens-ai-floating";
      floatingRoot.innerHTML = [
        '<button class="vl-main" type="button" title="打开视频学习 AI 助手">',
        '<span class="vl-mark">AI</span>',
        "<span>Ask AI</span>",
        "</button>",
        '<button class="vl-close" type="button" aria-label="隐藏 VideoLens AI">×</button>'
      ].join("");
      mountOverlayElement(floatingRoot);
      bindFloatingButton(floatingRoot);
    }

    floatingRoot.hidden = false;
  }

  function bindFloatingButton(root) {
    const main = root.querySelector(".vl-main");
    const close = root.querySelector(".vl-close");
    let pointer = null;
    let openedAt = 0;

    const openFromButton = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - openedAt < 500) return;
      openedAt = now;
      openSidePanel();
    };

    main.addEventListener("pointerdown", openFromButton, true);
    main.addEventListener("mousedown", openFromButton, true);
    main.addEventListener("touchstart", openFromButton, true);
    main.addEventListener("click", openFromButton, true);
    main.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        openFromButton(event);
      }
    }, true);

    close.addEventListener("click", (event) => {
      event.stopPropagation();
      sessionStorage.setItem("videolens:hidden", "1");
      root.hidden = true;
    });

    root.addEventListener("click", (event) => {
      if (event.target.closest(".vl-main")) {
        openFromButton(event);
      }
    }, true);

    root.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".vl-main, .vl-close")) return;
      pointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: root.getBoundingClientRect().left,
        top: root.getBoundingClientRect().top
      };
      root.setPointerCapture(event.pointerId);
    });

    root.addEventListener("pointermove", (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.startX;
      const dy = event.clientY - pointer.startY;
      if (Math.abs(dx) + Math.abs(dy) < 6) return;
      const nextLeft = clamp(pointer.left + dx, 8, window.innerWidth - root.offsetWidth - 8);
      const nextTop = clamp(pointer.top + dy, 8, window.innerHeight - root.offsetHeight - 8);
      root.style.left = `${nextLeft}px`;
      root.style.top = `${nextTop}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });

    root.addEventListener("pointerup", (event) => {
      if (pointer && pointer.id === event.pointerId) {
        root.releasePointerCapture(event.pointerId);
      }
      pointer = null;
    });
  }

  function handleShortcut(event) {
    const modifierPressed = event.ctrlKey || event.metaKey;
    if (modifierPressed && event.shiftKey && !event.altKey && event.code === "KeyY") {
      event.preventDefault();
      openSidePanel();
    }
  }

  function openSidePanel() {
    showPageToast("正在连接当前视频...", "info");
    sendRuntimeMessage({ type: MESSAGE.REGISTER_TARGET_TAB })
      .catch((error) => {
        showPageToast(`未能记住当前视频标签页：${error.message || error}`);
      })
      .finally(() => {
        openEmbeddedSidePanel();
        showPageToast("已连接当前视频。", "info");
      });
  }

  function openEmbeddedSidePanel() {
    ensureEmbeddedSidePanel();
    mountOverlayElement(embeddedSidePanel);
    embeddedSidePanel.classList.add("open");
    embeddedSidePanel.classList.remove("compact");
    updateEmbeddedSidePanelFullscreenMode({ compactInFullscreen: false });
  }

  function closeEmbeddedSidePanel() {
    if (embeddedSidePanel) {
      embeddedSidePanel.classList.remove("open");
    }
    setFullscreenVideoLayout(false);
    sendRuntimeMessage({ type: "VIDEO_LENS_RELEASE_CONTEXT" }).catch(() => {});
  }

  function ensureEmbeddedSidePanel() {
    if (embeddedSidePanel) return embeddedSidePanel;

    embeddedSidePanel = document.createElement("aside");
    embeddedSidePanel.id = "videolens-ai-sidepanel-frame";
    embeddedSidePanel.innerHTML = [
      '<div class="vl-frame-toolbar">',
      '<span class="vl-frame-label">VideoLens AI</span>',
      '<div class="vl-frame-actions">',
      '<button class="vl-frame-minimize" type="button" aria-label="收起 VideoLens AI" title="收起">−</button>',
      '<button class="vl-frame-close" type="button" aria-label="关闭 VideoLens AI" title="关闭">×</button>',
      "</div>",
      "</div>",
      '<button class="vl-frame-launch" type="button" aria-label="展开 VideoLens AI">AI</button>',
      '<iframe title="VideoLens AI" allow="clipboard-read; clipboard-write"></iframe>'
    ].join("");
    embeddedSidePanel.querySelector("iframe").src = chrome.runtime.getURL("src/sidepanel/index.html?embedded=1");
    embeddedSidePanel.querySelector(".vl-frame-close").addEventListener("click", closeEmbeddedSidePanel);
    embeddedSidePanel.querySelector(".vl-frame-minimize").addEventListener("click", compactEmbeddedSidePanel);
    embeddedSidePanel.querySelector(".vl-frame-launch").addEventListener("click", expandEmbeddedSidePanel);
    mountOverlayElement(embeddedSidePanel);
    return embeddedSidePanel;
  }

  function compactEmbeddedSidePanel() {
    if (!embeddedSidePanel) return;
    embeddedSidePanel.classList.add("compact");
    setFullscreenVideoLayout(false);
  }

  function expandEmbeddedSidePanel() {
    if (!embeddedSidePanel) return;
    mountOverlayElement(embeddedSidePanel);
    embeddedSidePanel.classList.add("open");
    embeddedSidePanel.classList.remove("compact");
    updateEmbeddedSidePanelFullscreenMode({ compactInFullscreen: false });
  }

  function updateEmbeddedSidePanelFullscreenMode(options = {}) {
    if (!embeddedSidePanel) return;

    const fullscreen = isFullscreenActive();
    embeddedSidePanel.classList.toggle("fullscreen", fullscreen);

    if (!fullscreen) {
      embeddedSidePanel.classList.remove("compact");
      setFullscreenVideoLayout(false);
      return;
    }

    if (options.compactInFullscreen) {
      embeddedSidePanel.classList.add("compact");
      setFullscreenVideoLayout(false);
    } else {
      embeddedSidePanel.classList.remove("compact");
      setFullscreenVideoLayout(true);
    }
  }

  function showPageToast(message, tone = "error") {
    let toast = document.getElementById("videolens-ai-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "videolens-ai-toast";
      mountOverlayElement(toast);
    }

    mountOverlayElement(toast);

    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("show");
    }, 5200);
  }

  function handleFullscreenChange() {
    ensureFloatingButton();

    if (embeddedSidePanel?.classList.contains("open")) {
      mountOverlayElement(embeddedSidePanel);
      updateEmbeddedSidePanelFullscreenMode({
        compactInFullscreen: embeddedSidePanel.classList.contains("compact")
      });
    } else {
      setFullscreenVideoLayout(false);
    }

    const toast = document.getElementById("videolens-ai-toast");
    if (toast?.classList.contains("show")) {
      mountOverlayElement(toast);
    }
  }

  function mountOverlayElement(element) {
    const root = getOverlayRoot();
    if (element.parentElement !== root) {
      root.appendChild(element);
    }
  }

  function setFullscreenVideoLayout(enabled) {
    if (fullscreenLayoutRoot && fullscreenLayoutRoot !== getOverlayRoot()) {
      fullscreenLayoutRoot.classList.remove("videolens-ai-fullscreen-with-panel");
      fullscreenLayoutRoot = null;
    }

    const root = getOverlayRoot();
    if (!enabled || !isFullscreenActive()) {
      if (fullscreenLayoutRoot) {
        fullscreenLayoutRoot.classList.remove("videolens-ai-fullscreen-with-panel");
        fullscreenLayoutRoot = null;
      }
      return;
    }

    root.classList.add("videolens-ai-fullscreen-with-panel");
    fullscreenLayoutRoot = root;
  }

  function getOverlayRoot() {
    const fullscreenElement = getFullscreenElement();
    if (!fullscreenElement) return document.documentElement;

    if (fullscreenElement instanceof HTMLVideoElement) {
      return fullscreenElement.parentElement || document.documentElement;
    }

    return fullscreenElement;
  }

  function isFullscreenActive() {
    return Boolean(getFullscreenElement());
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  async function collectBasicInfo() {
    const video = requireVideo();
    return {
      videoInfo: getVideoInfo(video),
      hasVideo: true
    };
  }

  async function collectQuestionSnapshot(video, settings, requestedMode) {
    const videoInfo = getVideoInfo(video);
    const capturedAt = new Date().toISOString();
    const started = Date.now();
    const warnings = [];
    let frameSnapshot = null;
    if (requestedMode !== "transcript-only" && settings.enableFrameInput !== false) {
      try {
        frameSnapshot = await captureFrame(video, settings);
        const tolerance = Math.max(1.5, (Date.now() - started) / 1000 * (video.playbackRate || 1) + 0.5);
        if (video.seeking || Math.abs(video.currentTime - frameSnapshot.timestamp) > tolerance) {
          frameSnapshot = null;
          warnings.push("截取画面时播放位置发生变化，本次使用提问时刻的文字内容。");
        } else {
          videoInfo.currentTime = frameSnapshot.timestamp;
        }
      } catch {
        warnings.push("提问时的画面暂时无法截取，将使用可获取的视频内容。");
      }
    }
    if (getVideoKey() !== videoInfo.videoKey) throw new Error("视频已切换，请在当前视频重新提问。");
    // The snapshot request must not await subtitle or model/runtime preparation.
    return { snapshotOnly: true, videoInfo, frameSnapshot, warnings, capturedAt };
  }

  async function collectContext(payload) {
    const settings = payload.settings || {};
    const requestedMode = payload.contextMode || "transcript-and-frame";
    const video = requireVideo();
    if (payload.snapshotOnly) return collectQuestionSnapshot(video, settings, requestedMode);
    const warnings = [];
    const videoInfo = getVideoInfo(video);
    let contextMode = requestedMode;
    let transcriptContext = [];
    let relatedTranscriptContext = [];
    let frameSnapshot = null;
    let fullTextTrack = null;

    if (requestedMode !== "frame-only") {
      try {
        const transcript = await getTranscript(video);
        if (payload.includeFullText) fullTextTrack = { items: transcript, complete: true };
        transcriptContext = selectTranscriptWindow(
          transcript,
          video.currentTime,
          Number(settings.contextBeforeSeconds) || 60,
          0
        );
        relatedTranscriptContext = selectRelevantTranscriptChunks(
          transcript,
          payload.question,
          video.currentTime,
          transcriptContext
        );
        if (transcriptContext.length === 0) {
          const visibleItems = getVisibleCaptionWindow(video, settings);
          if (visibleItems.length > 0) {
            transcriptContext = visibleItems;
            if (relatedTranscriptContext.length === 0) {
              relatedTranscriptContext = selectRelevantTranscriptChunks(
                visibleCaptionState.items,
                payload.question,
                video.currentTime,
                transcriptContext
              );
            }
            warnings.push("字幕轨道当前时间点附近为空，已使用页面可见字幕缓存。");
          } else {
            warnings.push("当前时间点附近没有可用字幕。若字幕内嵌在视频画面中，请使用“画面”或“字幕 + 画面”模式。");
          }
        }
      } catch (error) {
        const visibleItems = getVisibleCaptionWindow(video, settings);
        if (visibleItems.length > 0) {
          transcriptContext = visibleItems;
          relatedTranscriptContext = selectRelevantTranscriptChunks(
            visibleCaptionState.items,
            payload.question,
            video.currentTime,
            transcriptContext
          );
          warnings.push(`字幕轨道获取失败，已使用页面可见字幕缓存：${error.message}`);
        } else {
          warnings.push(`字幕获取失败：${error.message}。若网站 AI 字幕已开启，请播放几秒让插件捕获可见字幕；若字幕内嵌在画面中，请使用画面模式。`);
        }
      }
    }

    if (requestedMode !== "transcript-only") {
      if (settings.enableFrameInput === false) {
        warnings.push("设置中已关闭画面输入。");
      } else {
        try {
          frameSnapshot = await captureFrame(video, settings);
        } catch (error) {
          warnings.push(`当前平台暂不支持画面输入，已退化为字幕问答：${error.message}`);
          if (requestedMode === "frame-only") {
            contextMode = "transcript-only";
            try {
              const transcript = await getTranscript(video);
              transcriptContext = selectTranscriptWindow(
                transcript,
                video.currentTime,
                Number(settings.contextBeforeSeconds) || 60,
                0
              );
              if (transcriptContext.length === 0) {
                transcriptContext = getVisibleCaptionWindow(video, settings);
              }
              relatedTranscriptContext = selectRelevantTranscriptChunks(
                transcript,
                payload.question,
                video.currentTime,
                transcriptContext
              );
            } catch (transcriptError) {
              transcriptContext = getVisibleCaptionWindow(video, settings);
              relatedTranscriptContext = selectRelevantTranscriptChunks(
                visibleCaptionState.items,
                payload.question,
                video.currentTime,
                transcriptContext
              );
              if (transcriptContext.length === 0) {
                warnings.push(`字幕兜底失败：${transcriptError.message}`);
              }
            }
          }
        }
      }
    }

    if (requestedMode === "transcript-and-frame" && !frameSnapshot) {
      contextMode = transcriptContext.length > 0 ? "transcript-only" : "transcript-and-frame";
    }

    return {
      videoInfo,
      transcriptContext,
      relatedTranscriptContext,
      frameSnapshot,
      contextMode,
      warnings,
      ...(fullTextTrack ? { fullTextTrack } : {})
    };
  }

  async function seekTo(time) {
    const video = requireVideo();
    const nextTime = Math.max(0, Math.min(Number(time) || 0, video.duration || Number.MAX_SAFE_INTEGER));
    video.currentTime = nextTime;
    video.scrollIntoView({ block: "center", behavior: "smooth" });
    try {
      await video.play();
    } catch {
      // Some browsers block autoplay from extension contexts. Seeking still succeeds.
    }
    return { currentTime: video.currentTime };
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((video) => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0)
      || videos.find((video) => video.readyState >= 1)
      || videos[0]
      || null;
  }

  function requireVideo() {
    const video = findVideo();
    if (!video) {
      throw new Error("当前页面没有找到可操作的视频元素。");
    }
    return video;
  }

  function getVideoInfo(video) {
    return {
      title: getTitle(),
      url: location.href,
      currentTime: video.currentTime || 0,
      paused: video.paused,
      seeking: video.seeking,
      playbackRate: video.playbackRate || 1,
      videoKey: getVideoKey(),
      duration: Number.isFinite(video.duration) ? video.duration : null,
      platform: getPlatformName()
    };
  }

  function getTitle() {
    const selectors = getPlatformName() === "bilibili"
      ? [
          ".video-info-title",
          ".video-title",
          ".media-title",
          ".bpx-player-video-info-title",
          "h1[title]",
          "h1",
          "meta[property='og:title']"
        ]
      : [
          "h1.ytd-watch-metadata yt-formatted-string",
          "h1.title yt-formatted-string",
          "h1",
          "meta[property='og:title']"
        ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element?.getAttribute?.("content") || element?.textContent;
      const title = cleanVideoTitle(value);
      if (title) return title;
    }

    return cleanVideoTitle(document.title) || "Untitled video";
  }

  function getPlatformName() {
    if (isYouTubeHost()) return "youtube";
    if (isBilibiliHost()) return "bilibili";
    return "html5";
  }

  function isYouTubeHost() {
    return /(^|\.)youtube\.com$/i.test(location.hostname) || /(^|\.)youtu\.be$/i.test(location.hostname);
  }

  function isBilibiliHost() {
    return /(^|\.)bilibili\.com$/i.test(location.hostname);
  }

  function cleanVideoTitle(value) {
    return String(value || "")
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .replace(/\s*[_-]\s*哔哩哔哩\s*[_-]?\s*bilibili\s*$/i, "")
      .replace(/\s*-\s*bilibili\s*$/i, "")
      .replace(/\s*-\s*哔哩哔哩\s*$/i, "")
      .trim();
  }

  async function getTranscript(video) {
    const key = `${getPlatformName()}:${getVideoKey()}`;
    if (transcriptCache.key === key && transcriptCache.items) return transcriptCache.items;
    if (transcriptCache.key === key && transcriptCache.error) throw transcriptCache.error;

    try {
      const platform = getPlatformName();
      const items = platform === "youtube"
        ? await getYouTubeTranscript()
        : platform === "bilibili"
          ? await getBilibiliTranscript()
          : getHtml5TextTrackTranscript(video);

      if (!items.length) {
        throw new Error("未发现可用字幕轨道。");
      }

      transcriptCache.key = key;
      transcriptCache.items = items;
      transcriptCache.error = null;
      return items;
    } catch (error) {
      const fallbackItems = getHtml5TextTrackTranscript(video);
      if (fallbackItems.length > 0) {
        transcriptCache.key = key;
        transcriptCache.items = fallbackItems;
        transcriptCache.error = null;
        return fallbackItems;
      }

      transcriptCache.key = key;
      transcriptCache.items = null;
      transcriptCache.error = error;
      throw error;
    }
  }

  async function getYouTubeTranscript() {
    const response = findYouTubePlayerResponse();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    if (!tracks.length) {
      throw new Error("该 YouTube 视频没有公开字幕轨道。");
    }

    const browserLanguage = (navigator.language || "en").split("-")[0];
    const track = tracks.find((item) => item.languageCode === navigator.language && item.kind !== "asr")
      || tracks.find((item) => item.languageCode?.startsWith(browserLanguage) && item.kind !== "asr")
      || tracks.find((item) => item.kind !== "asr")
      || tracks[0];

    const url = new URL(track.baseUrl);
    if (!url.searchParams.has("fmt")) {
      url.searchParams.set("fmt", "json3");
    }

    const transcriptResponse = await fetch(url.toString(), { credentials: "include" });
    if (!transcriptResponse.ok) {
      throw new Error(`字幕接口返回 ${transcriptResponse.status}`);
    }

    const text = await transcriptResponse.text();
    return parseTranscriptPayload(text);
  }

  function findYouTubePlayerResponse() {
    const scripts = Array.from(document.scripts)
      .map((script) => script.textContent || "")
      .filter((text) => text.includes("ytInitialPlayerResponse") || text.includes("captionTracks"));

    for (const text of scripts) {
      const parsed = extractJsonAfterMarker(text, "ytInitialPlayerResponse");
      if (parsed?.captions) return parsed;
    }

    const html = document.documentElement.innerHTML;
    const parsed = extractJsonAfterMarker(html, "ytInitialPlayerResponse");
    if (parsed?.captions) return parsed;

    return null;
  }

  async function getBilibiliTranscript() {
    const state = findBilibiliInitialState();
    const tracks = findBilibiliSubtitleTracks(state);

    if (!tracks.length) {
      throw new Error("该 B 站视频没有发现公开字幕轨道。");
    }

    const browserLanguage = (navigator.language || "zh-CN").toLowerCase();
    const track = chooseBilibiliSubtitleTrack(tracks, browserLanguage);
    const trackUrl = normalizeBilibiliSubtitleUrl(track);

    if (!trackUrl) {
      throw new Error("B 站字幕轨道缺少可读取的字幕地址。");
    }

    const response = await fetch(trackUrl, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`B 站字幕接口返回 ${response.status}`);
    }

    const payload = await response.json();
    const body = Array.isArray(payload?.body)
      ? payload.body
      : Array.isArray(payload?.data?.body)
        ? payload.data.body
        : [];

    const items = body
      .map((item) => {
        const start = normalizeSubtitleSeconds(item.from ?? item.start ?? item.start_time);
        const end = normalizeSubtitleSeconds(item.to ?? item.end ?? item.end_time);
        const text = normalizeCaptionText(item.content ?? item.text ?? item.value ?? "");
        return {
          start,
          end: end > start ? end : start + 3,
          text
        };
      })
      .filter((item) => item.text);

    if (!items.length) {
      throw new Error("B 站字幕接口没有返回可用文本。");
    }

    return items;
  }

  function findBilibiliInitialState() {
    const scripts = Array.from(document.scripts)
      .map((script) => script.textContent || "")
      .filter((text) => text.includes("__INITIAL_STATE__") || text.includes("subtitle_url"));

    for (const text of scripts) {
      const parsed = extractJsonAfterMarker(text, "__INITIAL_STATE__");
      if (parsed) return parsed;
    }

    const parsed = extractJsonAfterMarker(document.documentElement.innerHTML, "__INITIAL_STATE__");
    return parsed || null;
  }

  function findBilibiliSubtitleTracks(root) {
    const tracks = [];
    const seen = new WeakSet();

    const visit = (value, depth) => {
      if (!value || depth > 8 || tracks.length > 30) return;

      if (Array.isArray(value)) {
        for (const item of value) {
          if (isBilibiliSubtitleTrack(item)) tracks.push(item);
          visit(item, depth + 1);
        }
        return;
      }

      if (typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      if (isBilibiliSubtitleTrack(value)) {
        tracks.push(value);
        return;
      }

      for (const item of Object.values(value)) {
        visit(item, depth + 1);
      }
    };

    visit(root, 0);

    const unique = [];
    const urls = new Set();
    for (const track of tracks) {
      const url = normalizeBilibiliSubtitleUrl(track);
      if (!url || urls.has(url)) continue;
      urls.add(url);
      unique.push(track);
    }

    return unique;
  }

  function isBilibiliSubtitleTrack(value) {
    if (!value || typeof value !== "object") return false;
    const rawUrl = value.subtitle_url || value.subtitleUrl || value.url;
    if (!rawUrl || typeof rawUrl !== "string") return false;
    if (!/subtitle|aisubtitle|\.json/i.test(rawUrl)) return false;
    return Boolean(value.lan || value.lan_doc || value.lang || value.language || value.id);
  }

  function chooseBilibiliSubtitleTrack(tracks, browserLanguage) {
    const normalizedLanguage = browserLanguage.toLowerCase();
    return tracks.find((track) => getBilibiliTrackLanguage(track) === normalizedLanguage)
      || tracks.find((track) => getBilibiliTrackLanguage(track).startsWith(normalizedLanguage.split("-")[0]))
      || tracks.find((track) => /zh|中文|ai/i.test(`${track.lan || ""} ${track.lan_doc || ""}`))
      || tracks[0];
  }

  function getBilibiliTrackLanguage(track) {
    return String(track.lan || track.lang || track.language || track.lan_doc || "").toLowerCase();
  }

  function normalizeBilibiliSubtitleUrl(track) {
    const rawUrl = track?.subtitle_url || track?.subtitleUrl || track?.url || "";
    if (!rawUrl) return "";
    if (rawUrl.startsWith("//")) return `${location.protocol}${rawUrl}`;
    try {
      return new URL(rawUrl, location.origin).toString();
    } catch {
      return "";
    }
  }

  function normalizeSubtitleSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return number > 10000 ? number / 1000 : number;
  }

  function extractJsonAfterMarker(text, marker) {
    let index = text.indexOf(marker);
    while (index !== -1) {
      const equalsIndex = text.indexOf("=", index + marker.length);
      const braceIndex = text.indexOf("{", equalsIndex === -1 ? index + marker.length : equalsIndex);
      if (braceIndex === -1) return null;

      const end = findBalancedJsonEnd(text, braceIndex);
      if (end !== -1) {
        try {
          return JSON.parse(text.slice(braceIndex, end + 1));
        } catch {
          index = text.indexOf(marker, index + marker.length);
          continue;
        }
      }
      index = text.indexOf(marker, index + marker.length);
    }
    return null;
  }

  function findBalancedJsonEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  function parseTranscriptPayload(text) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json.events)) {
        return json.events
          .filter((event) => Array.isArray(event.segs) && event.segs.length > 0)
          .map((event, index, events) => {
            const start = (Number(event.tStartMs) || 0) / 1000;
            const duration = (Number(event.dDurationMs) || 0) / 1000;
            const nextStart = events[index + 1]?.tStartMs ? Number(events[index + 1].tStartMs) / 1000 : null;
            const textValue = event.segs.map((seg) => seg.utf8 || "").join("").replace(/\s+/g, " ").trim();
            return {
              start,
              end: duration > 0 ? start + duration : (nextStart || start + 4),
              text: textValue
            };
          })
          .filter((item) => item.text);
      }
    } catch {
      // Fall through to XML parsing.
    }

    const doc = new DOMParser().parseFromString(text, "text/xml");
    return Array.from(doc.querySelectorAll("text"))
      .map((node) => {
        const start = Number(node.getAttribute("start")) || 0;
        const duration = Number(node.getAttribute("dur")) || 0;
        return {
          start,
          end: duration > 0 ? start + duration : start + 4,
          text: (node.textContent || "").replace(/\s+/g, " ").trim()
        };
      })
      .filter((item) => item.text);
  }

  function getHtml5TextTrackTranscript(video) {
    const tracks = Array.from(video.textTracks || []);
    for (const track of tracks) {
      try {
        track.mode = "hidden";
        const cues = Array.from(track.cues || []);
        const items = cues
          .map((cue) => ({
            start: cue.startTime,
            end: cue.endTime,
            text: (cue.text || "").replace(/\s+/g, " ").trim()
          }))
          .filter((item) => item.text);
        if (items.length) return items;
      } catch {
        // Continue to the next track.
      }
    }
    return [];
  }

  function startVisibleCaptionCapture() {
    if (visibleCaptionState.observer) return;

    visibleCaptionState.observer = new MutationObserver(scheduleVisibleCaptionSnapshot);
    visibleCaptionState.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    visibleCaptionState.timer = window.setInterval(recordVisibleCaptionSnapshot, 500);
  }

  function scheduleVisibleCaptionSnapshot() {
    if (captionSnapshotScheduled) return;
    captionSnapshotScheduled = true;
    window.setTimeout(() => {
      captionSnapshotScheduled = false;
      recordVisibleCaptionSnapshot();
    }, 160);
  }

  function resetVisibleCaptions() {
    visibleCaptionState.items = [];
    visibleCaptionState.lastText = "";
    visibleCaptionState.lastStart = 0;
    visibleCaptionState.lastSeenAt = 0;
  }

  function recordVisibleCaptionSnapshot() {
    const video = findVideo();
    if (!video) return;

    const text = getVisibleCaptionText();
    const currentTime = video.currentTime || 0;

    if (!text) {
      finishVisibleCaption(currentTime);
      return;
    }

    if (text !== visibleCaptionState.lastText) {
      finishVisibleCaption(currentTime);
      visibleCaptionState.lastText = text;
      visibleCaptionState.lastStart = currentTime;
    }

    visibleCaptionState.lastSeenAt = currentTime;
  }

  function finishVisibleCaption(endTime) {
    const text = visibleCaptionState.lastText;
    if (!text) return;

    pushVisibleCaption({
      start: visibleCaptionState.lastStart,
      end: Math.max(endTime || 0, visibleCaptionState.lastSeenAt || 0, visibleCaptionState.lastStart + 1.5),
      text,
      source: "visible-caption"
    });

    visibleCaptionState.lastText = "";
    visibleCaptionState.lastStart = 0;
    visibleCaptionState.lastSeenAt = 0;
  }

  function pushVisibleCaption(item) {
    const start = Math.max(0, Number(item.start) || 0);
    const end = Math.max(start + 0.5, Number(item.end) || start + 1.5);
    const text = normalizeCaptionText(item.text);
    if (!text) return;

    const previous = visibleCaptionState.items[visibleCaptionState.items.length - 1];
    if (previous && previous.text === text && Math.abs(previous.end - start) < 2) {
      previous.end = Math.max(previous.end, end);
      return;
    }

    visibleCaptionState.items.push({ start, end, text, source: item.source });
    if (visibleCaptionState.items.length > visibleCaptionState.maxItems) {
      visibleCaptionState.items.splice(0, visibleCaptionState.items.length - visibleCaptionState.maxItems);
    }
  }

  function getVisibleCaptionWindow(video, settings) {
    recordVisibleCaptionSnapshot();

    const currentTime = video.currentTime || 0;
    const items = visibleCaptionState.items.slice();
    if (visibleCaptionState.lastText) {
      items.push({
        start: visibleCaptionState.lastStart,
        end: Math.max(currentTime, visibleCaptionState.lastSeenAt, visibleCaptionState.lastStart + 1.5),
        text: visibleCaptionState.lastText,
        source: "visible-caption"
      });
    }

    return selectTranscriptWindow(
      items,
      currentTime,
      Number(settings.contextBeforeSeconds) || 60,
      0
    );
  }

  function getVisibleCaptionText() {
    const containers = Array.from(document.querySelectorAll([
      ".ytp-caption-window-container",
      ".html5-video-player .caption-window",
      ".html5-video-player [class*='caption-window']",
      ".bpx-player-subtitle-panel",
      ".bpx-player-subtitle-wrap",
      ".bpx-player-subtitle",
      ".bilibili-player-video-subtitle",
      ".bilibili-player-video-subtitle-text",
      ".squirtle-subtitle-wrap",
      ".squirtle-subtitle-item"
    ].join(",")));

    const visibleContainers = containers.filter((container) => {
      const rect = container.getBoundingClientRect();
      const style = window.getComputedStyle(container);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    });

    for (const container of visibleContainers) {
      const segmentText = collectCaptionSegmentText(container);
      if (segmentText) return segmentText;

      const fallback = normalizeCaptionText(container.textContent || "");
      if (fallback) return fallback;
    }

    return "";
  }

  function collectCaptionSegmentText(container) {
    const lineNodes = Array.from(container.querySelectorAll([
      ".caption-visual-line",
      ".bpx-player-subtitle-panel-text",
      ".bpx-player-subtitle-item",
      ".bpx-player-subtitle-current",
      ".bilibili-player-video-subtitle-text",
      ".squirtle-subtitle-item"
    ].join(",")));
    if (lineNodes.length > 0) {
      return normalizeCaptionText(
        lineNodes
          .map((line) => normalizeCaptionText(line.textContent || ""))
          .filter(Boolean)
          .join("\n")
      );
    }

    const segmentNodes = Array.from(container.querySelectorAll(".ytp-caption-segment"));
    if (segmentNodes.length > 0) {
      return normalizeCaptionText(
        segmentNodes
          .map((segment) => normalizeCaptionText(segment.textContent || ""))
          .filter(Boolean)
          .join(" ")
      );
    }

    return "";
  }

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/[\u200b-\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function selectTranscriptWindow(items, currentTime, beforeSeconds, afterSeconds) {
    const start = Math.max(0, currentTime - beforeSeconds);
    const end = currentTime + afterSeconds;
    return items.filter((item) => item.end >= start && item.start <= end);
  }

  function selectRelevantTranscriptChunks(items, question, currentTime, currentWindow = []) {
    const chunks = buildTranscriptChunks(items);
    if (!chunks.length) return [];

    const currentStart = currentWindow.length
      ? Math.min(...currentWindow.map((item) => Number(item.start) || 0))
      : Math.max(0, (Number(currentTime) || 0) - 60);
    const currentEnd = currentWindow.length
      ? Math.max(...currentWindow.map((item) => Number(item.end) || 0))
      : (Number(currentTime) || 0) + 30;
    const outsideCurrentWindow = chunks.filter((chunk) => {
      return chunk.end < currentStart || chunk.start > currentEnd;
    });

    if (isTranscriptOverviewQuestion(question)) {
      return sampleTranscriptChunks(outsideCurrentWindow.length ? outsideCurrentWindow : chunks, 8);
    }

    const searchTokens = buildSearchTokens(question);
    if (!searchTokens.length) return [];

    return outsideCurrentWindow
      .map((chunk) => ({
        chunk,
        score: scoreSearchText(chunk.text, searchTokens, chunk.start, currentTime)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.start - right.chunk.start)
      .slice(0, 5)
      .map((item) => item.chunk)
      .sort((left, right) => left.start - right.start);
  }

  function buildTranscriptChunks(items) {
    const normalizedItems = (Array.isArray(items) ? items : [])
      .map((item) => ({
        start: Math.max(0, Number(item?.start) || 0),
        end: Math.max(Number(item?.end) || 0, Number(item?.start) || 0),
        text: normalizeCaptionText(item?.text)
      }))
      .filter((item) => item.text)
      .sort((left, right) => left.start - right.start);
    const chunks = [];
    let current = null;

    for (const item of normalizedItems) {
      const nextLength = current ? current.text.length + item.text.length + 1 : item.text.length;
      const nextDuration = current ? item.end - current.start : item.end - item.start;
      if (current && (nextLength > 420 || nextDuration > 75)) {
        chunks.push(current);
        current = null;
      }

      if (!current) {
        current = {
          start: item.start,
          end: Math.max(item.end, item.start + 1),
          text: item.text,
          source: "transcript-search"
        };
        continue;
      }

      current.end = Math.max(current.end, item.end);
      if (!current.text.endsWith(item.text)) {
        current.text = `${current.text} ${item.text}`;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  function sampleTranscriptChunks(chunks, limit) {
    if (chunks.length <= limit) return chunks;
    const selected = [];
    const seen = new Set();
    for (let index = 0; index < limit; index += 1) {
      const chunkIndex = Math.round(index * (chunks.length - 1) / Math.max(1, limit - 1));
      if (seen.has(chunkIndex)) continue;
      seen.add(chunkIndex);
      selected.push(chunks[chunkIndex]);
    }
    return selected;
  }

  function isTranscriptOverviewQuestion(question) {
    return /总结|概括|梳理|整个视频|全视频|整体内容|主要内容|summary|summarize|overview|whole\s+video/i
      .test(String(question || ""));
  }

  function buildSearchTokens(value) {
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

  function scoreSearchText(text, tokens, start, currentTime) {
    const haystack = String(text || "").normalize("NFKC").toLowerCase();
    let score = 0;
    let matched = false;

    for (const token of tokens) {
      let index = haystack.indexOf(token);
      let occurrences = 0;
      while (index !== -1 && occurrences < 3) {
        occurrences += 1;
        index = haystack.indexOf(token, index + token.length);
      }
      if (!occurrences) continue;
      matched = true;
      score += occurrences * (token.length >= 4 ? 4 : 2);
    }

    if (!matched) return 0;
    const distance = Math.abs((Number(start) || 0) - (Number(currentTime) || 0));
    return score + 1 / (1 + distance / 300);
  }

  async function captureFrame(video, settings) {
    try {
      return drawVideoFrame(video, settings);
    } catch (error) {
      try {
        return await captureVisibleVideoRect(video, settings);
      } catch (fallbackError) {
        throw new Error(`${error.message}; 可见区域截图也失败：${fallbackError.message}`);
      }
    }
  }

  function drawVideoFrame(video, settings) {
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("视频画面尚未准备好。");
    }

    const maxWidth = Number(settings.frameMaxWidth) || DEFAULT_CAPTURE.maxWidth;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("浏览器无法创建截图画布。");
    }

    const timestamp = video.currentTime || 0;
    context.drawImage(video, 0, 0, width, height);
    const quality = clamp(Number(settings.frameImageQuality) || DEFAULT_CAPTURE.quality, 0.35, 0.92);
    const imageDataUrl = canvas.toDataURL(DEFAULT_CAPTURE.mimeType, quality);

    return {
      timestamp,
      imageDataUrl,
      width,
      height,
      mimeType: DEFAULT_CAPTURE.mimeType,
      capturedAt: new Date().toISOString()
    };
  }

  async function captureVisibleVideoRect(video, settings) {
    const rect = video.getBoundingClientRect();
    const left = clamp(rect.left, 0, window.innerWidth);
    const top = clamp(rect.top, 0, window.innerHeight);
    const right = clamp(rect.right, 0, window.innerWidth);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);

    if (right - left < 2 || bottom - top < 2) {
      throw new Error("视频不在当前可见区域内。");
    }

    const quality = clamp(Number(settings.frameImageQuality) || DEFAULT_CAPTURE.quality, 0.35, 0.92);
    const timestamp = video.currentTime || 0;
    const screenshot = await sendRuntimeMessage({
      type: MESSAGE.CAPTURE_VISIBLE_TAB,
      options: { quality }
    });

    const image = await loadImage(screenshot.imageDataUrl);
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const sourceX = Math.round(left * scaleX);
    const sourceY = Math.round(top * scaleY);
    const sourceWidth = Math.round((right - left) * scaleX);
    const sourceHeight = Math.round((bottom - top) * scaleY);
    const maxWidth = Number(settings.frameMaxWidth) || DEFAULT_CAPTURE.maxWidth;
    const outputScale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * outputScale));
    const height = Math.max(1, Math.round(sourceHeight * outputScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("浏览器无法创建截图画布。");
    }

    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);

    return {
      timestamp,
      imageDataUrl: canvas.toDataURL(DEFAULT_CAPTURE.mimeType, quality),
      width,
      height,
      mimeType: DEFAULT_CAPTURE.mimeType,
      capturedAt: screenshot.capturedAt || new Date().toISOString()
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取可见区域截图。"));
      image.src = src;
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error?.message || "扩展后台请求失败。"));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function getVideoKey() {
    try {
      const url = new URL(location.href);
      const videoId = url.searchParams.get("v");
      if (videoId) return videoId;
      if (isBilibiliHost()) {
        const videoMatch = url.pathname.match(/\/video\/([^/?#]+)/i);
        if (videoMatch) return `${videoMatch[1]}:${url.searchParams.get("p") || "1"}`;
        const bangumiMatch = url.pathname.match(/\/bangumi\/play\/([^/?#]+)/i);
        if (bangumiMatch) return bangumiMatch[1];
      }
      return `${url.origin}${url.pathname}`;
    } catch {
      return location.href;
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeError(error) {
    return {
      message: error?.message || String(error || "未知错误")
    };
  }
})();

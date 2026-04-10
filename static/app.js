const characterVideo = document.getElementById("characterVideo");
const characterVideoBuffer = document.getElementById("characterVideoBuffer");
const characterRig = document.getElementById("characterRig");

const liveStartButton = document.getElementById("liveStartButton");
const liveStopButton = document.getElementById("liveStopButton");
const liveVoiceSelect = document.getElementById("liveVoiceSelect");
const voiceStatus = document.getElementById("voiceStatus");
const fullscreenButton = document.getElementById("fullscreenButton");
let pseudoFullscreen = false;

let liveSocket = null;
let liveActive = false;
let liveStarting = false;
let audioContext = null;
let micStream = null;
let micSource = null;
let processor = null;
let silentGain = null;
let playbackAnalyser = null;
let playbackGain = null;
let micStarted = false;
let nextPlayAt = 0;

let speechVideoTimer = null;
let speechVideoEndAt = 0;
let speakFallbackTimer = null;
let currentVoiceVideoMode = "idle";
let currentCharacterVideoSrc = "";
let videoSwitchToken = 0;
let lastPcmPlaybackAt = 0;
let ttsFallbackTimer = null;
let minSpeakHoldUntil = 0;
let idleSwitchTimer = null;
let activeVideo = characterVideo;
let standbyVideo = characterVideoBuffer;
let wakeRecognition = null;
let wakeListening = false;
let wakeRestartTimer = null;
let wakeGestureArmed = false;
let wakeUnsupportedNotified = false;
let wakeStopping = false;
let wakeStarting = false;
let wakeStartLastAt = 0;
let wakeRetryDelayMs = 1200;
let wakeRetryCount = 0;
let wakeMatchLock = false;
let wakeDetectedAt = 0;
let autoGreetPending = false;
let farewellPending = false;
let farewellWord = "";
let farewellHardStopTimer = null;
let farewellCandidateWord = "";
let farewellCandidateAt = 0;
let liveSessionStartedAt = 0;
let lastLiveErrorDetail = "";
let localStopReason = "";
let entryStartInFlight = false;
let audioUnlockHintShown = false;
let pendingStartAfterUnlock = false;
let liveConfigCache = null;
let liveConfigFetchedAt = 0;
let liveConfigFetchPromise = null;
let preparedLiveSocket = null;
let preparedLiveReady = false;
let preparedLiveModel = "";
let preparedLiveVoice = "";
let preparedLivePriming = false;

const idleVideoSrc = characterVideo?.dataset.idleSrc || "/voice_idle.mp4";
const speakVideoSrc = characterVideo?.dataset.speakSrc || "/voice_speaking.mp4";
const FALLBACK_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";
const WAKE_WORD_PATTERNS = ["もも", "モモ", "momo", "MOMO", "桃"];
const FAREWELL_RULES = [
  { patterns: ["ばいばい", "バイバイ", "bye"], reply: "バイバイ" },
  { patterns: ["おやすみ", "おやすみなさい"], reply: "おやすみ" },
  { patterns: ["じゃあね", "じゃーね", "またね"], reply: "じゃあね" },
];
const FAREWELL_STOP_AFTER_ECHO_MS = 3000;
const FAREWELL_HARD_TIMEOUT_MS = 12000;
const MEMORY_STORAGE_KEY = "momo_growth_memory_v1";
const MEMORY_MAX_FACTS = 120;
const MEMORY_PROMPT_FACTS = 18;
const MEMORY_HINTS = [
  "名前",
  "呼び",
  "誕生日",
  "兄弟",
  "家族",
  "好き",
  "嫌い",
  "趣味",
  "目標",
  "仕事",
  "学校",
  "住",
  "予定",
  "約束",
  "体調",
  "推し",
  "記念日",
];

function buildDefaultMemory() {
  return {
    version: 1,
    character: {
      name: "もも",
      relation: "兄弟",
      firstPerson: "ぼく、拙者",
      userCall: "リロー",
      endingStyle: "語尾はたまに「ござる」。基本は自然な普通口調。",
    },
    facts: [],
  };
}

function loadGrowthMemory() {
  const fallback = buildDefaultMemory();
  try {
    const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const merged = {
      version: 1,
      character: {
        ...fallback.character,
        ...(parsed.character || {}),
      },
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    };
    return merged;
  } catch (_) {
    return fallback;
  }
}

function saveGrowthMemory() {
  try {
    localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(growthMemory));
  } catch (_) {
    // noop
  }
}

function normalizeMemoryText(text) {
  return normalizeSpeechText(text || "");
}

function shouldRememberUtterance(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (t.length < 3 || t.length > 90) return false;
  if (includesWakeWord(t)) return false;
  if (detectFarewellWord(t)) return false;
  return MEMORY_HINTS.some((h) => t.includes(h));
}

function rememberUserFact(text) {
  const content = (text || "").trim();
  if (!shouldRememberUtterance(content)) return;
  const key = normalizeMemoryText(content);
  const exists = growthMemory.facts.some((f) => normalizeMemoryText(f.text || "") === key);
  if (exists) return;
  growthMemory.facts.push({
    text: content,
    at: Date.now(),
  });
  if (growthMemory.facts.length > MEMORY_MAX_FACTS) {
    growthMemory.facts = growthMemory.facts.slice(-MEMORY_MAX_FACTS);
  }
  saveGrowthMemory();
  // 次セッション開始時に必ず最新メモリを反映
  clearPreparedLiveSession(true);
}

function buildCharacterSystemPrompt() {
  const c = growthMemory.character || buildDefaultMemory().character;
  const recentFacts = (growthMemory.facts || []).slice(-MEMORY_PROMPT_FACTS).map((f) => f.text).filter(Boolean);
  const factsBlock = recentFacts.length > 0 ? `\n覚えている大事な情報:\n- ${recentFacts.join("\n- ")}` : "";
  return [
    `あなたはオリジナル2Dキャラクター「${c.name}」です。`,
    `ユーザーとの関係は${c.relation}です。`,
    `一人称は「${c.firstPerson}」。`,
    `ユーザーの呼び方は必ず「${c.userCall}」。`,
    `${c.endingStyle}`,
    "親しみやすく自然に話し、長文を避けて短めに返答してください。",
    "覚えている情報は会話の中で自然に活用してください。",
    factsBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

let growthMemory = loadGrowthMemory();

function syncIosViewportHeight() {
  const isIosPage =
    document.documentElement.classList.contains("ios-site") || document.body.classList.contains("ios-site");
  if (!isIosPage) return;
  const vv = window.visualViewport;
  const height = Math.ceil(vv?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  if (height > 0) {
    document.documentElement.style.setProperty("--app-height", `${height + 1}px`);
  }
}

function setVoiceStatus(text) {
  if (voiceStatus) voiceStatus.textContent = text || "";
}

function normalizeSpeechText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[。、！!？?\-ー~〜\.,]/g, "");
}

function includesWakeWord(text) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return false;
  return WAKE_WORD_PATTERNS.some((w) => normalized.includes(normalizeSpeechText(w)));
}

function detectFarewellWord(text) {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return "";
  // 誤検知防止: ある程度短い発話のみ対象
  if (normalized.length > 24) return "";
  for (const rule of FAREWELL_RULES) {
    if (rule.patterns.some((p) => normalized.includes(normalizeSpeechText(p)))) {
      return rule.reply;
    }
  }
  return "";
}

function buildFarewellReply(word) {
  if (word === "おやすみ") return "おやすみ、ゆっくり休んでね";
  if (word === "じゃあね") return "じゃあね、また話そうね";
  return "バイバイ、ゆっくり休んでね";
}

function clearFarewellTimer() {
  if (farewellHardStopTimer) {
    clearTimeout(farewellHardStopTimer);
    farewellHardStopTimer = null;
  }
}

function sendOneShotInstruction(text) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
  try {
    liveSocket.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [{ text }],
            },
          ],
          turnComplete: true,
        },
      }),
    );
  } catch (_) {
    // noop
  }
}

function requestAutoGreeting() {
  // 仕様変更: 自動挨拶は行わず、起動後は即会話受付する
}

function requestFarewellThenStop(word) {
  if (!word || farewellPending) return;
  farewellPending = true;
  farewellWord = word;
  // 終了返答はキャラ音声（Live応答）で行う
  sendOneShotInstruction(
    `会話を終了します。次の一言だけ返答してください: 「${buildFarewellReply(word)}」`,
  );
  clearFarewellTimer();
  farewellHardStopTimer = setTimeout(() => {
    if (!liveActive) return;
    localStopReason = "farewell_timeout";
    stopLiveMode(true);
    setVoiceStatus("また話しかけてね");
  }, FAREWELL_HARD_TIMEOUT_MS);
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function shouldWakeListen() {
  return !liveActive && !liveStarting && document.visibilityState === "visible";
}

function stopWakeWordListener() {
  // 監視中でないときは停止フラグを残さない（再開が永久にブロックされるのを防ぐ）
  if (!wakeRecognition) {
    wakeStopping = false;
    wakeStarting = false;
    if (wakeRestartTimer) {
      clearTimeout(wakeRestartTimer);
      wakeRestartTimer = null;
    }
    return;
  }
  if (!wakeListening && !wakeStarting && !wakeStopping) {
    if (wakeRestartTimer) {
      clearTimeout(wakeRestartTimer);
      wakeRestartTimer = null;
    }
    return;
  }
  wakeStopping = true;
  wakeStarting = false;
  wakeMatchLock = false;
  wakeDetectedAt = 0;
  if (wakeRestartTimer) {
    clearTimeout(wakeRestartTimer);
    wakeRestartTimer = null;
  }
  wakeListening = false;
  try {
    wakeRecognition.stop();
  } catch (_) {
    // noop
  }
}

function hardResetWakeWordListener() {
  if (wakeRestartTimer) {
    clearTimeout(wakeRestartTimer);
    wakeRestartTimer = null;
  }
  const rec = wakeRecognition;
  wakeRecognition = null;
  wakeListening = false;
  wakeStarting = false;
  wakeStopping = false;
  wakeMatchLock = false;
  wakeDetectedAt = 0;
  if (!rec) return;
  try {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
  } catch (_) {
    // noop
  }
  try {
    if (typeof rec.abort === "function") rec.abort();
    else rec.stop();
  } catch (_) {
    // noop
  }
}

async function waitForWakeListenerStopped(maxMs = 1500) {
  const startedAt = Date.now();
  while (wakeListening || wakeStarting || wakeStopping) {
    if (Date.now() - startedAt >= maxMs) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function scheduleWakeWordListener(delayMs = 420) {
  if (wakeStopping) return;
  if (!shouldWakeListen()) return;
  if (wakeStarting || wakeListening) return;
  if (wakeRestartTimer) clearTimeout(wakeRestartTimer);
  wakeRestartTimer = setTimeout(() => {
    wakeRestartTimer = null;
    startWakeWordListener();
  }, delayMs);
}

function startWakeWordListener() {
  if (!shouldWakeListen()) return;
  if (wakeStarting) return;
  if (wakeListening) return;
  wakeStopping = false;

  const now = Date.now();
  const minGap = 900;
  if (now - wakeStartLastAt < minGap) {
    scheduleWakeWordListener(minGap - (now - wakeStartLastAt) + 120);
    return;
  }

  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  if (!SpeechRecognitionCtor) {
    if (!wakeUnsupportedNotified) {
      wakeUnsupportedNotified = true;
      setVoiceStatus("待機ワード起動はこのブラウザ未対応です。会話モード開始を押してください。");
    }
    return;
  }

  if (!wakeRecognition) {
    wakeRecognition = new SpeechRecognitionCtor();
    wakeRecognition.lang = "ja-JP";
    wakeRecognition.continuous = true;
    // final待ちを避けて起動遅延を抑える
    wakeRecognition.interimResults = true;
    wakeRecognition.maxAlternatives = 1;

    wakeRecognition.onresult = async (event) => {
      if (!shouldWakeListen()) return;
      if (wakeMatchLock) return;
      let heard = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        heard += event.results[i][0]?.transcript || "";
      }
      if (!includesWakeWord(heard)) return;
      if (liveActive || liveStarting) return;
      wakeMatchLock = true;
      wakeDetectedAt = Date.now();
      // onend待ちをやめて即開始へ合流（起動遅延を抑える）
      await triggerLiveStart("wake");
    };

    wakeRecognition.onerror = (event) => {
      wakeStarting = false;
      wakeListening = false;
      const code = event?.error || "";
      if (code === "not-allowed" || code === "service-not-allowed") {
        setVoiceStatus("マイク許可が必要です。1回だけ画面をタップして許可してください。");
        wakeGestureArmed = true;
        wakeRetryCount = 0;
        wakeRetryDelayMs = 1200;
        return;
      }
      if (code === "aborted" && wakeStopping) return;
      wakeRetryCount = Math.min(6, wakeRetryCount + 1);
      wakeRetryDelayMs = Math.min(6000, 900 + wakeRetryCount * 450);
      if (code === "network") {
        scheduleWakeWordListener(wakeRetryDelayMs);
        return;
      }
      scheduleWakeWordListener(wakeRetryDelayMs);
    };

    wakeRecognition.onend = () => {
      wakeStarting = false;
      wakeListening = false;
      wakeMatchLock = false;
      if (wakeStopping) {
        wakeStopping = false;
        return;
      }
      if (shouldWakeListen()) scheduleWakeWordListener(Math.max(1000, wakeRetryDelayMs));
    };
  }

  try {
    wakeStarting = true;
    wakeStartLastAt = Date.now();
    wakeMatchLock = false;
    wakeDetectedAt = 0;
    wakeRecognition.start();
    wakeListening = true;
    wakeGestureArmed = false;
    wakeRetryCount = 0;
    wakeRetryDelayMs = 1200;
    if (!voiceStatus?.textContent || voiceStatus.textContent.includes("準備完了")) {
      setVoiceStatus("待機中: 「もも」で会話モード開始できます。");
    }
  } catch (_) {
    wakeStarting = false;
    wakeListening = false;
    wakeRetryCount = Math.min(6, wakeRetryCount + 1);
    wakeRetryDelayMs = Math.min(6000, 900 + wakeRetryCount * 450);
    scheduleWakeWordListener(wakeRetryDelayMs);
  }
}

async function toggleFullscreen() {
  const target = document.querySelector(".display-shell") || document.documentElement;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fsEl) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      pseudoFullscreen = false;
      document.body.classList.remove("pseudo-fullscreen");
      return;
    }
    if (target.requestFullscreen) {
      await target.requestFullscreen();
      pseudoFullscreen = false;
      document.body.classList.remove("pseudo-fullscreen");
      return;
    }
    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      pseudoFullscreen = false;
      document.body.classList.remove("pseudo-fullscreen");
      return;
    }
  } catch (_) {
    // noop
  }
  // iPhone等でFullscreen APIが使えない場合のフォールバック
  pseudoFullscreen = !pseudoFullscreen;
  document.body.classList.toggle("pseudo-fullscreen", pseudoFullscreen);
}

function normalizeLiveModelName(name) {
  const raw = (name || "").trim();
  if (!raw) return FALLBACK_LIVE_MODEL;

  const noPrefix = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
  const aliases = new Map([
    ["gemini-2.5-flash-live-preview", "gemini-3.1-flash-live-preview"],
    ["gemini-live-2.5-flash-preview", "gemini-3.1-flash-live-preview"],
    ["gemini-2.0-flash-live-001", "gemini-3.1-flash-live-preview"],
  ]);

  const normalized = aliases.get(noPrefix) || noPrefix;
  return `models/${normalized}`;
}

function buildLiveSetupMessage(modelName, voiceName) {
  return {
    setup: {
      model: modelName,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName || "Kore",
            },
          },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: buildCharacterSystemPrompt(),
          },
        ],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

function clearPreparedLiveSession(closeSocket = true) {
  const s = preparedLiveSocket;
  preparedLiveSocket = null;
  preparedLiveReady = false;
  preparedLiveModel = "";
  preparedLiveVoice = "";
  if (!closeSocket || !s) return;
  try {
    s.onopen = null;
    s.onmessage = null;
    s.onerror = null;
    s.onclose = null;
  } catch (_) {
    // noop
  }
  try {
    s.close();
  } catch (_) {
    // noop
  }
}

async function primePreparedLiveSession() {
  if (preparedLivePriming || liveActive || liveStarting || document.visibilityState !== "visible") return;
  preparedLivePriming = true;
  try {
    const cfg = await getLiveConfig();
    if (!cfg.apiKey) return;
    const modelName = normalizeLiveModelName(cfg.liveModel);
    const voiceName = liveVoiceSelect?.value || "Kore";

    if (
      preparedLiveSocket &&
      preparedLiveReady &&
      preparedLiveSocket.readyState === WebSocket.OPEN &&
      preparedLiveModel === modelName &&
      preparedLiveVoice === voiceName
    ) {
      return;
    }

    clearPreparedLiveSession(true);

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    preparedLiveSocket = socket;
    preparedLiveReady = false;
    preparedLiveModel = modelName;
    preparedLiveVoice = voiceName;

    let openTimeout = setTimeout(() => {
      if (preparedLiveSocket !== socket || preparedLiveReady) return;
      clearPreparedLiveSession(true);
    }, 4500);

    socket.onopen = () => {
      if (preparedLiveSocket !== socket) return;
      try {
        socket.send(JSON.stringify(buildLiveSetupMessage(modelName, voiceName)));
      } catch (_) {
        clearPreparedLiveSession(true);
      }
    };

    socket.onmessage = async (event) => {
      if (preparedLiveSocket !== socket) return;
      try {
        let msg = null;
        if (typeof event.data === "string") msg = JSON.parse(event.data);
        else if (event.data instanceof Blob) msg = JSON.parse(await event.data.text());
        else if (event.data instanceof ArrayBuffer) msg = JSON.parse(new TextDecoder().decode(event.data));
        if (!msg) return;
        if (msg.error) {
          clearPreparedLiveSession(true);
          return;
        }
        if (msg.setupComplete || msg.sessionResumptionUpdate) {
          preparedLiveReady = true;
          if (openTimeout) {
            clearTimeout(openTimeout);
            openTimeout = null;
          }
        }
      } catch (_) {
        // noop
      }
    };

    socket.onerror = () => {
      if (openTimeout) {
        clearTimeout(openTimeout);
        openTimeout = null;
      }
      if (preparedLiveSocket === socket) clearPreparedLiveSession(false);
    };

    socket.onclose = () => {
      if (openTimeout) {
        clearTimeout(openTimeout);
        openTimeout = null;
      }
      if (preparedLiveSocket === socket) clearPreparedLiveSession(false);
    };
  } finally {
    preparedLivePriming = false;
  }
}

function speakWithBrowserTTS(text) {
  const t = (text || "").trim();
  if (!t || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  try {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(t);
    utt.lang = "ja-JP";
    utt.rate = 1.03;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    setVoiceVideoMode("speak");
    const estimateSec = Math.min(8, Math.max(1.2, t.length * 0.11));
    bumpSpeakFallback(Math.floor(estimateSec * 1000));
    window.speechSynthesis.speak(utt);
  } catch (_) {
    // noop
  }
}

function configureVideoElement(video) {
  if (!video) return;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.loop = true;
  video.autoplay = true;
  video.preload = "auto";
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
}

function ensureVideoReady(video, src) {
  if (!video || !src) return Promise.resolve(false);
  configureVideoElement(video);

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      resolve(ok);
    };

    const onCanPlay = () => finish(true);
    const onError = () => finish(false);
    video.addEventListener("canplay", onCanPlay, { once: true });
    video.addEventListener("error", onError, { once: true });
    setTimeout(() => finish(false), 4000);
    video.src = src;
    video.load();
  });
}

async function swapCharacterVideoSource(src) {
  if (!activeVideo || !standbyVideo) return;
  configureVideoElement(activeVideo);
  configureVideoElement(standbyVideo);

  if (currentCharacterVideoSrc === src && activeVideo.currentSrc) {
    activeVideo.play().catch(() => {});
    return;
  }

  const token = ++videoSwitchToken;
  const nextVideo = standbyVideo;
  const prevVideo = activeVideo;
  nextVideo.classList.add("switching");

  const ready = await ensureVideoReady(nextVideo, src);
  if (token !== videoSwitchToken || !nextVideo || !prevVideo) return;
  if (!ready) {
    nextVideo.classList.remove("switching");
    return;
  }

  nextVideo.classList.remove("is-hidden");
  prevVideo.classList.add("is-hidden");
  nextVideo.classList.remove("switching");
  nextVideo.currentTime = 0;
  nextVideo.play().catch(() => {});

  activeVideo = nextVideo;
  standbyVideo = prevVideo;
  currentCharacterVideoSrc = src;

  setTimeout(() => {
    standbyVideo.pause();
    standbyVideo.currentTime = 0;
  }, 120);
}

function setVoiceVideoMode(nextMode) {
  if (!characterRig || !activeVideo || !standbyVideo) return;
  const showSpeak = nextMode === "speak";
  const targetSrc = showSpeak ? speakVideoSrc : idleVideoSrc;

  if (nextMode === "idle") {
    const nowMs = Date.now();
    if (nowMs < minSpeakHoldUntil) {
      if (idleSwitchTimer) clearTimeout(idleSwitchTimer);
      idleSwitchTimer = setTimeout(() => {
        idleSwitchTimer = null;
        setVoiceVideoMode("idle");
      }, Math.max(30, minSpeakHoldUntil - nowMs));
      return;
    }
  } else if (idleSwitchTimer) {
    clearTimeout(idleSwitchTimer);
    idleSwitchTimer = null;
  }

  // モードだけ一致していても、実動画srcが一致しない場合は再同期する
  if (currentVoiceVideoMode === nextMode && currentCharacterVideoSrc === targetSrc) return;
  currentVoiceVideoMode = nextMode;
  characterRig.classList.add("video-active");
  swapCharacterVideoSource(targetSrc);
}

function ensureIdleVideoPlayback() {
  if (!activeVideo) return;
  if (currentVoiceVideoMode !== "idle") return;
  setVoiceVideoMode("idle");
}

function scheduleSpeakVideo(startAt, durationSec) {
  if (!audioContext) return;
  minSpeakHoldUntil = Math.max(minSpeakHoldUntil, Date.now() + Math.ceil((durationSec + 0.18) * 1000));
  speechVideoEndAt = Math.max(speechVideoEndAt, startAt + durationSec + 0.03);
  setVoiceVideoMode("speak");

  if (speechVideoTimer) clearTimeout(speechVideoTimer);
  const remainMs = Math.max(50, Math.floor((speechVideoEndAt - audioContext.currentTime) * 1000));
  speechVideoTimer = setTimeout(() => {
    if (!audioContext || !liveActive) {
      setVoiceVideoMode("idle");
      return;
    }
    if (audioContext.currentTime < speechVideoEndAt - 0.01) {
      scheduleSpeakVideo(audioContext.currentTime, speechVideoEndAt - audioContext.currentTime);
      return;
    }
    setVoiceVideoMode("idle");
  }, remainMs);
}

function bumpSpeakFallback(holdMs = 900) {
  if (!liveActive) return;
  minSpeakHoldUntil = Math.max(minSpeakHoldUntil, Date.now() + Math.max(350, holdMs));
  setVoiceVideoMode("speak");
  if (speakFallbackTimer) clearTimeout(speakFallbackTimer);
  speakFallbackTimer = setTimeout(() => {
    if (!liveActive) return;
    if (audioContext && audioContext.currentTime < speechVideoEndAt - 0.01) return;
    setVoiceVideoMode("idle");
  }, Math.max(300, holdMs));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downsampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  let offsetOutput = 0;
  let offsetInput = 0;

  while (offsetOutput < output.length) {
    const nextOffsetInput = Math.round((offsetOutput + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    output[offsetOutput] = count > 0 ? accum / count : 0;
    offsetOutput += 1;
    offsetInput = nextOffsetInput;
  }
  return output;
}

function floatTo16BitPCM(float32) {
  const output = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function parsePcmRate(mimeType) {
  if (!mimeType) return 24000;
  const m = /rate=(\d+)/i.exec(mimeType);
  if (!m) return 24000;
  const rate = Number(m[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : 24000;
}

async function playPcmBase64(base64, sampleRate = 24000) {
  if (!audioContext) return;
  const bytes = base64ToBytes(base64);
  const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  await playPcmInt16(pcm16, sampleRate);
}

async function playPcmInt16(pcm16, sampleRate = 24000) {
  if (!audioContext) return;
  if (audioContext.state !== "running") {
    try {
      await audioContext.resume();
    } catch (_) {
      // noop
    }
  }
  if (!playbackAnalyser) {
    playbackAnalyser = audioContext.createAnalyser();
    playbackAnalyser.fftSize = 1024;
    playbackGain = audioContext.createGain();
    playbackGain.gain.value = 1.0;
    playbackAnalyser.connect(playbackGain);
    playbackGain.connect(audioContext.destination);
  }

  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) float32[i] = pcm16[i] / 32768;

  const buffer = audioContext.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackAnalyser);

  const now = audioContext.currentTime;
  const prerollSec = 0.12;
  if (!nextPlayAt || nextPlayAt < now - 0.25) {
    nextPlayAt = now + prerollSec;
  }
  const startAt = Math.max(now + prerollSec, nextPlayAt);
  source.start(startAt);
  scheduleSpeakVideo(startAt, buffer.duration);
  nextPlayAt = startAt + buffer.duration;
  lastPcmPlaybackAt = Date.now();
}

async function getLiveConfig(forceRefresh = false) {
  const now = Date.now();
  const cacheTtlMs = 10 * 60 * 1000;
  if (!forceRefresh && liveConfigCache && now - liveConfigFetchedAt < cacheTtlMs) return liveConfigCache;
  if (!forceRefresh && liveConfigFetchPromise) return liveConfigFetchPromise;

  liveConfigFetchPromise = (async () => {
    const res = await fetch("/api/live-config");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Live設定の取得に失敗しました");
    liveConfigCache = data;
    liveConfigFetchedAt = Date.now();
    return data;
  })();

  try {
    return await liveConfigFetchPromise;
  } finally {
    liveConfigFetchPromise = null;
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}がタイムアウトしました`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function handleLiveMessage(message) {
  if (!message.serverContent) return;
  const sc = message.serverContent;
  const inputText = (sc.inputTranscription?.text || "").trim();
  const outputText = (sc.outputTranscription?.text || "").trim();

  if (inputText && !farewellPending) {
    rememberUserFact(inputText);
    const w = detectFarewellWord(inputText);
    if (w) {
      requestFarewellThenStop(w);
    }
  }

  if (outputText) {
    // 文字起こしは表示せず、口パク動画切替のトリガーとしてのみ利用
    bumpSpeakFallback(1200);
    if (farewellPending) {
      clearFarewellTimer();
      setTimeout(() => {
        if (!liveActive) return;
        localStopReason = "farewell_echo";
        stopLiveMode(true);
        setVoiceStatus("また話しかけてね");
      }, FAREWELL_STOP_AFTER_ECHO_MS);
    }
  }

  let hasAudioChunk = false;
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("audio/pcm")) {
      hasAudioChunk = true;
      const rate = parsePcmRate(part.inlineData.mimeType);
      playPcmBase64(part.inlineData.data, rate).catch((e) => {
        setVoiceStatus(`音声再生エラー: ${e.message}`);
      });
    }
  }

  // 受け渡し先環境でPCMが来ない/再生されない場合の保険
  if (outputText && !hasAudioChunk) {
    if (ttsFallbackTimer) clearTimeout(ttsFallbackTimer);
    const snapshot = Date.now();
    ttsFallbackTimer = setTimeout(() => {
      if (!liveActive) return;
      if (lastPcmPlaybackAt > snapshot) return;
      speakWithBrowserTTS(outputText);
    }, 280);
  }
}

async function startMicStreaming() {
  if (micStarted) return;

  if (!micStream || !micStream.active) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  micSource = audioContext.createMediaStreamSource(micStream);

  processor = audioContext.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => {
    if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext.sampleRate);
    const pcm16 = floatTo16BitPCM(downsampled);
    const base64 = bytesToBase64(new Uint8Array(pcm16.buffer));

    try {
      liveSocket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: base64,
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }),
      );
    } catch (_) {
      // noop
    }
  };

  micSource.connect(processor);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  micStarted = true;
}

async function startMicStreamingWithRetry(maxMs = 3200, intervalMs = 160) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt <= maxMs) {
    try {
      await startMicStreaming();
      return;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (lastError) throw lastError;
  throw new Error("マイク開始に失敗しました");
}

async function warmupMicStream() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  if (micStream && micStream.active) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (_) {
    // noop
  }
}

function stopMicStreaming(options = {}) {
  const { releaseStream = false } = options;
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (releaseStream && micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  micStarted = false;
}

async function startLiveMode(options = {}) {
  if (liveActive || liveStarting) return;
  liveStarting = true;
  localStopReason = "";
  lastLiveErrorDetail = "";
  autoGreetPending = !!options.autoGreeting;
  pendingStartAfterUnlock = false;
  farewellPending = false;
  farewellWord = "";
  farewellCandidateWord = "";
  farewellCandidateAt = 0;
  liveSessionStartedAt = 0;
  clearFarewellTimer();

  setVoiceStatus("会話モードを開始中...");
  if (liveStartButton) liveStartButton.disabled = true;
  let startupWatchdog = null;
  const clearStartupWatchdog = () => {
    if (startupWatchdog) {
      clearTimeout(startupWatchdog);
      startupWatchdog = null;
    }
  };

  try {
    const cfg = await withTimeout(getLiveConfig(), 2500, "設定取得");
    if (!cfg.apiKey) throw new Error("GEMINI_API_KEY が未設定です");

    audioContext = audioContext || new AudioContext();
    if (audioContext.state !== "running") {
      // 一部ブラウザでは resume() が解決されず無限待ちになるため、短い上限時間をつける
      await withTimeout(
        audioContext.resume().catch(() => {}),
        900,
        "音声初期化",
      ).catch(() => {});
    }
    if (audioContext.state !== "running") {
      clearStartupWatchdog();
      liveStarting = false;
      if (liveStartButton) liveStartButton.disabled = false;
      pendingStartAfterUnlock = true;
      if (!audioUnlockHintShown) {
        audioUnlockHintShown = true;
        setVoiceStatus("音声準備中です。画面を1回タップすると自動で会話を開始します。");
      } else {
        setVoiceStatus("画面を1回タップすると自動で会話を開始します。");
      }
      return;
    }
    nextPlayAt = 0;

    const modelName = normalizeLiveModelName(cfg.liveModel);
    const voiceName = liveVoiceSelect?.value || "Kore";
    const canAdoptPrepared =
      preparedLiveSocket &&
      preparedLiveReady &&
      preparedLiveSocket.readyState === WebSocket.OPEN &&
      preparedLiveModel === modelName &&
      preparedLiveVoice === voiceName;
    const socket = canAdoptPrepared ? preparedLiveSocket : new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cfg.apiKey)}`,
    );
    if (!canAdoptPrepared) socket.binaryType = "arraybuffer";
    liveSocket = socket;
    if (canAdoptPrepared) clearPreparedLiveSession(false);

    const connectTimeoutMs = 4500;
    let connectTimer = null;
    if (!canAdoptPrepared) {
      connectTimer = setTimeout(() => {
        if (liveSocket !== socket || liveActive) return;
        liveStarting = false;
        try {
          socket.close();
        } catch (_) {
          // noop
        }
        if (liveStartButton) liveStartButton.disabled = false;
        setVoiceStatus("会話モード接続タイムアウト: 回線状態を確認して再試行してください");
        scheduleWakeWordListener(300);
      }, connectTimeoutMs);
    }

    let setupCompleted = false;
    let micStartedAfterSetup = false;
    let setupAckTimer = null;

    const beginMicAfterSetup = () => {
      if (micStartedAfterSetup) return;
      micStartedAfterSetup = true;
      clearStartupWatchdog();
      liveStarting = false;
      const elapsed = wakeDetectedAt > 0 ? Date.now() - wakeDetectedAt : 0;
      setVoiceStatus(
        elapsed > 0
          ? `会話モード開始。話しかけてください（起動 ${elapsed}ms）`
          : "会話モード開始。話しかけてください",
      );
      wakeDetectedAt = 0;
      if (autoGreetPending) {
        autoGreetPending = false;
        setTimeout(() => requestAutoGreeting(), 280);
      }
      startMicStreamingWithRetry()
        .catch((e) => {
          lastLiveErrorDetail = `マイク開始失敗: ${e.message}`;
          localStopReason = "mic_start_failed";
          setVoiceStatus(lastLiveErrorDetail);
          stopLiveMode(true);
        });
    };

    socket.onopen = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (liveSocket !== socket) {
        try {
          socket.close();
        } catch (_) {
          // noop
        }
        return;
      }
      socket.send(JSON.stringify(buildLiveSetupMessage(modelName, voiceName)));
      liveActive = true;
      liveSessionStartedAt = Date.now();
      liveStartButton?.classList.add("live-on");
      if (liveStopButton) liveStopButton.disabled = false;
      setVoiceVideoMode("idle");
      setVoiceStatus("会話モード接続中... セットアップ中");
      setupAckTimer = setTimeout(() => {
        if (!liveActive || liveSocket !== socket || setupCompleted) return;
        // setupComplete が来ない環境でも sessionResumptionUpdate が来るケースがあるため、
        // ここでは強制切断せず会話開始へ進める
        beginMicAfterSetup();
      }, 1800);
    };

    if (canAdoptPrepared) {
      liveActive = true;
      liveSessionStartedAt = Date.now();
      liveStartButton?.classList.add("live-on");
      if (liveStopButton) liveStopButton.disabled = false;
      setVoiceVideoMode("idle");
      setupCompleted = true;
      beginMicAfterSetup();
    }

    socket.onmessage = async (event) => {
      if (liveSocket !== socket) return;
      try {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.error) {
            const em = msg.error.message || JSON.stringify(msg.error);
            lastLiveErrorDetail = em;
            localStopReason = "server_message_error";
            setVoiceStatus(`会話モードエラー: ${lastLiveErrorDetail}`);
            stopLiveMode(true);
            return;
          }
          if (msg.setupComplete || msg.sessionResumptionUpdate) {
            setupCompleted = true;
            if (setupAckTimer) {
              clearTimeout(setupAckTimer);
              setupAckTimer = null;
            }
            beginMicAfterSetup();
            return;
          }
          handleLiveMessage(msg);
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(event.data);
          if (text.trim().startsWith("{")) handleLiveMessage(JSON.parse(text));
          return;
        }

        if (event.data instanceof Blob) {
          const text = await event.data.text();
          if (text.trim().startsWith("{")) handleLiveMessage(JSON.parse(text));
          return;
        }
      } catch (e) {
        setVoiceStatus(`受信解析エラー: ${e.message}`);
      }
    };

    socket.onerror = (event) => {
      if (liveSocket !== socket) return;
      clearStartupWatchdog();
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (setupAckTimer) {
        clearTimeout(setupAckTimer);
        setupAckTimer = null;
      }
      liveStarting = false;
      if (liveStartButton) liveStartButton.disabled = false;
      const reason = event?.message || "不明なエラー";
      setVoiceStatus(`会話モード接続エラー: ${reason}`);
      scheduleWakeWordListener(350);
    };

    socket.onclose = (event) => {
      if (liveSocket !== socket) return;
      clearStartupWatchdog();
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (setupAckTimer) {
        clearTimeout(setupAckTimer);
        setupAckTimer = null;
      }
      liveStarting = false;
      stopLiveMode(false);
      const baseDetail =
        localStopReason ||
        lastLiveErrorDetail ||
        (event?.reason ? event.reason : `code:${event?.code || "unknown"}${setupCompleted ? "" : ",setup_incomplete"}`);
      if (baseDetail) console.debug("live onclose detail:", baseDetail);
      setVoiceStatus("また話しかけてね");
    };
  } catch (e) {
    clearStartupWatchdog();
    liveStarting = false;
    if (liveStartButton) liveStartButton.disabled = false;
    setVoiceStatus(`開始失敗: ${e.message}`);
    scheduleWakeWordListener(350);
  }
}

async function triggerLiveStart(source = "button") {
  if (entryStartInFlight || liveActive || liveStarting) return;
  entryStartInFlight = true;
  try {
    // 起動入口の差分をなくし、ボタン開始と同一の前処理に統一する
    hardResetWakeWordListener();
    if (source === "wake") setVoiceStatus("「もも」を検知。会話モードを開始します...");
    await startLiveMode({ entrySource: source });
  } finally {
    entryStartInFlight = false;
  }
}

function stopLiveMode(sendEnd = true) {
  liveStarting = false;
  autoGreetPending = false;
  farewellPending = false;
  farewellWord = "";
  farewellCandidateWord = "";
  farewellCandidateAt = 0;
  liveSessionStartedAt = 0;
  clearFarewellTimer();

  if (sendEnd && liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    try {
      liveSocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch (_) {
      // noop
    }
  }

  // 再起動高速化のため、マイクストリームは保持してノードのみ解除
  stopMicStreaming({ releaseStream: false });

  if (liveSocket) {
    try {
      liveSocket.close();
    } catch (_) {
      // noop
    }
    liveSocket = null;
  }

  liveActive = false;
  if (liveStartButton) {
    liveStartButton.disabled = false;
    liveStartButton.classList.remove("live-on");
  }
  if (liveStopButton) liveStopButton.disabled = true;

  setVoiceVideoMode("idle");
  speechVideoEndAt = 0;
  if (speechVideoTimer) {
    clearTimeout(speechVideoTimer);
    speechVideoTimer = null;
  }
  if (speakFallbackTimer) {
    clearTimeout(speakFallbackTimer);
    speakFallbackTimer = null;
  }
  if (ttsFallbackTimer) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
  }
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {
      // noop
    }
  }

  scheduleWakeWordListener(300);
  setTimeout(() => {
    primePreparedLiveSession().catch(() => {});
  }, 220);
}

liveStartButton?.addEventListener("click", () => {
  triggerLiveStart("button");
});
liveStopButton?.addEventListener("click", () => {
  localStopReason = "manual_button";
  stopLiveMode(true);
  setVoiceStatus("また話しかけてね");
});
fullscreenButton?.addEventListener("click", () => {
  toggleFullscreen();
});

for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(ev, () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl && !pseudoFullscreen) {
      document.body.classList.remove("pseudo-fullscreen");
    }
  });
}

for (const ev of ["pause", "ended", "stalled"]) {
  for (const v of [characterVideo, characterVideoBuffer]) {
    v?.addEventListener(ev, () => {
      if (v !== activeVideo) return;
      if (currentVoiceVideoMode === "speak") {
        activeVideo?.play().catch(() => {});
        return;
      }
      ensureIdleVideoPlayback();
    });
  }
}

for (const v of [characterVideo, characterVideoBuffer]) {
  v?.addEventListener("error", () => {
    if (v !== activeVideo) return;
    // アクティブ側で失敗したときは待機動画へ強制復帰
    currentCharacterVideoSrc = "";
    currentVoiceVideoMode = "idle";
    swapCharacterVideoSource(idleVideoSrc).catch(() => {});
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    getLiveConfig().catch(() => {});
    primePreparedLiveSession().catch(() => {});
    scheduleWakeWordListener(250);
    if (currentVoiceVideoMode === "speak") setVoiceVideoMode("speak");
    else ensureIdleVideoPlayback();
  } else {
    stopWakeWordListener();
  }
});

for (const evt of ["click", "touchstart", "keydown"]) {
  window.addEventListener(
    evt,
    async () => {
      if (audioContext && audioContext.state !== "running") {
        await withTimeout(audioContext.resume().catch(() => {}), 900, "音声初期化").catch(() => {});
      }
      if (pendingStartAfterUnlock && audioContext && audioContext.state === "running" && !liveActive && !liveStarting) {
        pendingStartAfterUnlock = false;
        triggerLiveStart("resume");
      }
      warmupMicStream();
      primePreparedLiveSession().catch(() => {});
      if (!liveActive && wakeGestureArmed) startWakeWordListener();
      if (currentVoiceVideoMode === "speak") setVoiceVideoMode("speak");
      else ensureIdleVideoPlayback();
    },
    { passive: true },
  );
}

configureVideoElement(characterVideo);
configureVideoElement(characterVideoBuffer);
characterVideo?.classList.remove("is-hidden");
characterVideoBuffer?.classList.add("is-hidden");
currentCharacterVideoSrc = idleVideoSrc;
activeVideo = characterVideo;
standbyVideo = characterVideoBuffer;
characterVideo?.play().catch(() => {});

const isStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
if (isStandalone) {
  pseudoFullscreen = true;
  document.body.classList.add("pseudo-fullscreen");
}

syncIosViewportHeight();
window.addEventListener("resize", syncIosViewportHeight);
window.addEventListener("orientationchange", syncIosViewportHeight);
window.addEventListener("pageshow", syncIosViewportHeight);
window.visualViewport?.addEventListener("resize", syncIosViewportHeight);
window.visualViewport?.addEventListener("scroll", syncIosViewportHeight);
window.addEventListener("beforeunload", () => {
  stopMicStreaming({ releaseStream: true });
});

setVoiceStatus("準備完了。待機中は「もも」で会話モード開始できます。");
getLiveConfig().catch(() => {});
primePreparedLiveSession().catch(() => {});
startWakeWordListener();

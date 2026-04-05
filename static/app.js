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
let autoGreetPending = false;
let farewellPending = false;
let farewellWord = "";
let farewellHardStopTimer = null;

const idleVideoSrc = characterVideo?.dataset.idleSrc || "/voice_idle.mp4";
const speakVideoSrc = characterVideo?.dataset.speakSrc || "/voice_speaking.mp4";
const FALLBACK_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";
const WAKE_WORD_PATTERNS = ["もも", "モモ", "momo", "MOMO", "桃"];
const FAREWELL_RULES = [
  { patterns: ["ばいばい", "バイバイ", "ばい", "bye", "バイ"], reply: "バイバイ" },
  { patterns: ["おやすみ", "おやすみなさい"], reply: "おやすみ" },
];

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
  for (const rule of FAREWELL_RULES) {
    if (rule.patterns.some((p) => normalized.includes(normalizeSpeechText(p)))) {
      return rule.reply;
    }
  }
  return "";
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
  sendOneShotInstruction("起動直後の返答として「どうした？」の一言だけを自然に返してください。");
}

function requestFarewellThenStop(word) {
  if (!word || farewellPending) return;
  farewellPending = true;
  farewellWord = word;
  sendOneShotInstruction(`会話を終了します。「${word}」の一言だけ返答してください。`);
  clearFarewellTimer();
  farewellHardStopTimer = setTimeout(() => {
    if (!liveActive) return;
    stopLiveMode(true);
    setVoiceStatus("会話モードを停止しました");
  }, 6500);
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function shouldWakeListen() {
  return !liveActive && document.visibilityState === "visible";
}

function stopWakeWordListener() {
  wakeStopping = true;
  wakeStarting = false;
  if (wakeRestartTimer) {
    clearTimeout(wakeRestartTimer);
    wakeRestartTimer = null;
  }
  if (!wakeRecognition || !wakeListening) return;
  wakeListening = false;
  try {
    wakeRecognition.stop();
  } catch (_) {
    // noop
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
    wakeRecognition.interimResults = false;
    wakeRecognition.maxAlternatives = 1;

    wakeRecognition.onresult = (event) => {
      if (!shouldWakeListen()) return;
      let heard = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        heard += event.results[i][0]?.transcript || "";
      }
      if (!includesWakeWord(heard)) return;
      stopWakeWordListener();
      setVoiceStatus("「もも」を検知。会話モードを開始します...");
      startLiveMode({ autoGreeting: true });
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

async function getLiveConfig() {
  const res = await fetch("/api/live-config");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Live設定の取得に失敗しました");
  return data;
}

function handleLiveMessage(message) {
  if (!message.serverContent) return;
  const sc = message.serverContent;
  const inputText = (sc.inputTranscription?.text || "").trim();
  const outputText = (sc.outputTranscription?.text || "").trim();

  if (inputText && !farewellPending) {
    const w = detectFarewellWord(inputText);
    if (w) requestFarewellThenStop(w);
  }

  if (outputText) {
    // 文字起こしは表示せず、口パク動画切替のトリガーとしてのみ利用
    bumpSpeakFallback(1200);
    if (farewellPending) {
      const echoed = detectFarewellWord(outputText);
      if (echoed && echoed === farewellWord) {
        clearFarewellTimer();
        setTimeout(() => {
          if (!liveActive) return;
          stopLiveMode(true);
          setVoiceStatus("会話モードを停止しました");
        }, 850);
      }
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

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

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

function stopMicStreaming() {
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
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  micStarted = false;
}

async function startLiveMode(options = {}) {
  if (liveActive) return;
  autoGreetPending = !!options.autoGreeting;
  farewellPending = false;
  farewellWord = "";
  clearFarewellTimer();
  stopWakeWordListener();

  setVoiceStatus("会話モードを開始中...");
  if (liveStartButton) liveStartButton.disabled = true;

  try {
    const cfg = await getLiveConfig();
    if (!cfg.apiKey) throw new Error("GEMINI_API_KEY が未設定です");

    audioContext = audioContext || new AudioContext();
    await audioContext.resume();
    nextPlayAt = 0;

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    liveSocket = new WebSocket(wsUrl);
    liveSocket.binaryType = "arraybuffer";

    const modelName = normalizeLiveModelName(cfg.liveModel);

    liveSocket.onopen = () => {
      const setupMessage = {
        setup: {
          model: modelName,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: liveVoiceSelect?.value || "Kore",
                },
              },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: "あなたはオリジナル2Dキャラクター『焔丸(ほむらまる)』です。明るく勇気づける少年剣士口調で、相手を主(あるじ)と呼び、短く自然に話してください。",
              },
            ],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };

      liveSocket.send(JSON.stringify(setupMessage));
      liveActive = true;
      liveStartButton?.classList.add("live-on");
      if (liveStopButton) liveStopButton.disabled = false;
      setVoiceVideoMode("idle");
      setVoiceStatus("会話モード接続中... マイク初期化");

      startMicStreaming()
        .then(() => {
          setVoiceStatus("会話モード開始。話しかけてください");
          if (autoGreetPending) {
            autoGreetPending = false;
            setTimeout(() => requestAutoGreeting(), 280);
          }
        })
        .catch((e) => {
          setVoiceStatus(`マイク開始失敗: ${e.message}`);
          stopLiveMode(true);
        });
    };

    liveSocket.onmessage = async (event) => {
      try {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.error) {
            setVoiceStatus(`会話モードエラー: ${msg.error.message || JSON.stringify(msg.error)}`);
            stopLiveMode(true);
            return;
          }
          if (msg.setupComplete) {
            setVoiceStatus("会話モード開始。話しかけてください");
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

    liveSocket.onerror = (event) => {
      const reason = event?.message || "不明なエラー";
      setVoiceStatus(`会話モード接続エラー: ${reason}`);
    };

    liveSocket.onclose = (event) => {
      stopLiveMode(false);
      const detail = event?.reason ? ` (${event.reason})` : "";
      setVoiceStatus(`会話モードが切断されました${detail}`);
    };
  } catch (e) {
    if (liveStartButton) liveStartButton.disabled = false;
    setVoiceStatus(`開始失敗: ${e.message}`);
  }
}

function stopLiveMode(sendEnd = true) {
  autoGreetPending = false;
  farewellPending = false;
  farewellWord = "";
  clearFarewellTimer();

  if (sendEnd && liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    try {
      liveSocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch (_) {
      // noop
    }
  }

  stopMicStreaming();

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
}

liveStartButton?.addEventListener("click", () => startLiveMode());
liveStopButton?.addEventListener("click", () => {
  stopLiveMode(true);
  setVoiceStatus("会話モードを停止しました");
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
    () => {
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

setVoiceStatus("準備完了。待機中は「もも」で会話モード開始できます。");
startWakeWordListener();

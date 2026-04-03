const characterVideo = document.getElementById("characterVideo");
const characterRig = document.getElementById("characterRig");

const liveStartButton = document.getElementById("liveStartButton");
const liveStopButton = document.getElementById("liveStopButton");
const liveVoiceSelect = document.getElementById("liveVoiceSelect");
const voiceStatus = document.getElementById("voiceStatus");

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

const idleVideoSrc = characterVideo?.dataset.idleSrc || "/voice_idle.mp4";
const speakVideoSrc = characterVideo?.dataset.speakSrc || "/voice_speaking.mp4";
const FALLBACK_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

function setVoiceStatus(text) {
  if (voiceStatus) voiceStatus.textContent = text || "";
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

function configureCharacterVideoElement() {
  if (!characterVideo) return;
  characterVideo.muted = true;
  characterVideo.defaultMuted = true;
  characterVideo.playsInline = true;
  characterVideo.loop = true;
  characterVideo.autoplay = true;
  characterVideo.preload = "auto";
  characterVideo.setAttribute("muted", "");
  characterVideo.setAttribute("playsinline", "");
  characterVideo.setAttribute("webkit-playsinline", "");
}

function swapCharacterVideoSource(src) {
  if (!characterVideo) return;
  configureCharacterVideoElement();

  if (currentCharacterVideoSrc === src && characterVideo.currentSrc) {
    characterVideo.play().catch(() => {});
    return;
  }

  const token = ++videoSwitchToken;
  characterVideo.classList.add("switching");

  const finish = () => {
    if (token !== videoSwitchToken || !characterVideo) return;
    characterVideo.play().catch(() => {});
    requestAnimationFrame(() => {
      if (token !== videoSwitchToken || !characterVideo) return;
      characterVideo.classList.remove("switching");
    });
  };

  characterVideo.addEventListener("canplay", finish, { once: true });
  characterVideo.src = src;
  characterVideo.play().catch(() => {});
  currentCharacterVideoSrc = src;

  setTimeout(finish, 140);
}

function setVoiceVideoMode(nextMode) {
  if (!characterRig || !characterVideo) return;
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
  if (!characterVideo) return;
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
  const outputText = (sc.outputTranscription?.text || "").trim();

  if (outputText) {
    // 文字起こしは表示せず、口パク動画切替のトリガーとしてのみ利用
    bumpSpeakFallback(1200);
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

async function startLiveMode() {
  if (liveActive) return;

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
}

liveStartButton?.addEventListener("click", () => startLiveMode());
liveStopButton?.addEventListener("click", () => {
  stopLiveMode(true);
  setVoiceStatus("会話モードを停止しました");
});

for (const ev of ["pause", "ended", "stalled"]) {
  characterVideo?.addEventListener(ev, () => {
    if (currentVoiceVideoMode === "speak") {
      characterVideo.play().catch(() => {});
      return;
    }
    ensureIdleVideoPlayback();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (currentVoiceVideoMode === "speak") setVoiceVideoMode("speak");
    else ensureIdleVideoPlayback();
  }
});

for (const evt of ["click", "touchstart", "keydown"]) {
  window.addEventListener(
    evt,
    () => {
      if (currentVoiceVideoMode === "speak") setVoiceVideoMode("speak");
      else ensureIdleVideoPlayback();
    },
    { passive: true },
  );
}

configureCharacterVideoElement();
setVoiceVideoMode("idle");
setVoiceStatus("準備完了。会話モード開始を押してマイク許可してください。");

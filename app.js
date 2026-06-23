// ÇeviriCanlı - derlemesiz (build'siz) sürüm.
// @google/genai kütüphanesi doğrudan CDN'den (esm.sh) yükleniyor; bu sayede
// hiçbir derleme adımı gerekmez, dosyalar olduğu gibi GitHub Pages'e yüklenir.
import { GoogleGenAI, Modality } from 'https://esm.sh/@google/genai@2.9.0';

// ---- Ses yardımcıları --------------------------------------------------
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToFloat32(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const samples = len >> 1;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

function rmsFromInt16(buf) {
  const view = new Int16Array(buf);
  if (view.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < view.length; i++) {
    const s = view[i] / 0x8000;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / view.length) * 3);
}

// inRate -> outRate doğrusal yeniden örnekleme (çıkış sesi için).
function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const t = pos - i0;
    const a = input[i0];
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a * (1 - t) + b * t;
  }
  return out;
}

// ---- Mikrofon (16 kHz PCM16) -------------------------------------------
class Recorder {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.stream = null;
  }
  async start(onChunk) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Hızı zorlamıyoruz; iOS donanım hızını verir, worklet 16 kHz'e indirir.
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('./capture-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      processorOptions: { targetRate: 16000 },
    });
    this.node.port.onmessage = (e) => {
      const buf = e.data;
      onChunk(abToBase64(buf), rmsFromInt16(buf));
    };
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
  }
  async stop() {
    try {
      this.node?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch {}
    this.node = this.stream = this.ctx = null;
  }
}

// ---- Çeviri sesi çalma (24 kHz) ----------------------------------------
class Player {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.outRate = 24000;
  }
  async start() {
    // Hızı zorlamıyoruz (iOS reddedebilir); gelen 24 kHz sesi gerçek
    // bağlam hızına yeniden örnekliyoruz.
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.outRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule('./playback-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'playback-processor', {
      processorOptions: { prebufferSec: 0.25 },
    });
    this.node.connect(this.ctx.destination);
  }
  enqueue(b64) {
    if (!this.node) return;
    let f32 = base64ToFloat32(b64); // 24 kHz
    if (this.outRate !== 24000) f32 = resampleLinear(f32, 24000, this.outRate);
    this.node.port.postMessage(f32, [f32.buffer]);
  }
  clear() {
    this.node?.port.postMessage('clear');
  }
  async stop() {
    try {
      this.node?.disconnect();
      await this.ctx?.close();
    } catch {}
    this.node = this.ctx = null;
  }
}

// ---- Gemini Live Translate oturumu -------------------------------------
class LiveTranslator {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
  }
  async connect(targetLanguageCode, cb) {
    const config = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: { targetLanguageCode, echoTargetLanguage: false },
    };
    this.session = await this.ai.live.connect({
      model: 'gemini-3.5-live-translate-preview',
      callbacks: {
        onopen: () => cb.onOpen(),
        onmessage: (message) => {
          const c = message?.serverContent;
          if (!c) return;
          if (c.inputTranscription?.text) cb.onInputTranscript(c.inputTranscription.text);
          if (c.outputTranscription?.text) cb.onOutputTranscript(c.outputTranscription.text);
          const parts = c.modelTurn?.parts ?? [];
          for (const p of parts) {
            const data = p?.inlineData?.data;
            if (data) cb.onAudio(data);
          }
          if (c.turnComplete) cb.onTurnComplete();
        },
        onerror: (e) => cb.onError(e?.message ?? 'Bilinmeyen hata'),
        onclose: (e) => cb.onClose(e?.reason ?? ''),
      },
      config,
    });
  }
  sendAudio(b64) {
    this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
  }
  close() {
    try { this.session?.close(); } catch {}
    this.session = null;
  }
}

// ---- Diller ------------------------------------------------------------
const TR = { code: 'tr', name: 'Türkçe', flag: '🇹🇷' };
const ZH = { code: 'zh-Hans', name: '中文', flag: '🇨🇳' };
let from = TR;
let to = ZH;

// ---- DOM ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const statusDot = $('statusDot');
const statusText = $('statusText');
const settingsPanel = $('settingsPanel');
const apiKeyInput = $('apiKey');
const srcLabel = $('srcLabel');
const dstLabel = $('dstLabel');
const srcBubbles = $('srcBubbles');
const dstBubbles = $('dstBubbles');
const meterFill = $('meterFill');
const micBtn = $('micBtn');
const micIcon = $('micIcon');
const micLabel = $('micLabel');

// ---- Durum -------------------------------------------------------------
const KEY_STORE = 'gemini_api_key';
let running = false;
let connecting = false;
const recorder = new Recorder();
const player = new Player();
let translator = null;
let srcPartial = null;
let dstPartial = null;

function setStatus(state, text) {
  statusDot.className = 'dot' + (state === 'idle' ? '' : ' ' + state);
  statusText.textContent = text;
}

function renderLangs() {
  $('langFrom').querySelector('.flag').textContent = from.flag;
  $('langFrom').querySelector('.name').textContent = from.name;
  $('langTo').querySelector('.flag').textContent = to.flag;
  $('langTo').querySelector('.name').textContent = to.name;
  srcLabel.textContent = `Duyulan (${from.name})`;
  dstLabel.textContent = `Çeviri (${to.name})`;
}

function appendOrUpdate(container, el, text) {
  if (!el) {
    el = document.createElement('div');
    el.className = 'bubble partial';
    container.appendChild(el);
  }
  el.textContent += text;
  container.scrollTop = container.scrollHeight;
  return el;
}

function finalizeTurn() {
  srcPartial?.classList.remove('partial');
  dstPartial?.classList.remove('partial');
  srcPartial = dstPartial = null;
}

const getKey = () => localStorage.getItem(KEY_STORE) ?? '';

async function connectTranslator() {
  translator = new LiveTranslator(getKey());
  await translator.connect(to.code, {
    onOpen: () => { connecting = false; setStatus('live', 'Dinleniyor…'); },
    onInputTranscript: (t) => { srcPartial = appendOrUpdate(srcBubbles, srcPartial, t); },
    onOutputTranscript: (t) => { dstPartial = appendOrUpdate(dstBubbles, dstPartial, t); },
    onAudio: (b64) => player.enqueue(b64),
    onTurnComplete: finalizeTurn,
    onError: (msg) => setStatus('error', 'Hata: ' + msg),
    onClose: (reason) => { if (running) setStatus('error', 'Bağlantı kapandı' + (reason ? ': ' + reason : '')); },
  });
}

async function start() {
  if (!getKey()) {
    settingsPanel.hidden = false;
    apiKeyInput.focus();
    setStatus('error', 'Önce API anahtarı girin');
    return;
  }
  try {
    connecting = true;
    setStatus('connecting', 'Bağlanıyor…');
    micBtn.disabled = true;
    // iOS: ses bağlamları ağ bağlantısından ÖNCE kurulmalı (dokunma hareketi
    // kaybolmadan resume edilsin). Mikrofon hazır olunca WS'e bağlanıyoruz.
    await player.start();
    await recorder.start((b64, rms) => {
      translator?.sendAudio(b64);
      meterFill.style.width = Math.round(rms * 100) + '%';
    });
    await connectTranslator();
    running = true;
    micBtn.disabled = false;
    micBtn.classList.add('live');
    micIcon.textContent = '⏹';
    micLabel.textContent = 'Durdur';
  } catch (err) {
    connecting = false;
    micBtn.disabled = false;
    setStatus('error', 'Başlatılamadı: ' + (err?.message ?? err));
    await stop();
  }
}

async function stop() {
  running = false;
  await recorder.stop();
  translator?.close();
  translator = null;
  await player.stop();
  meterFill.style.width = '0%';
  micBtn.classList.remove('live');
  micIcon.textContent = '⏺';
  micLabel.textContent = 'Başlat';
  if (!connecting) setStatus('idle', 'Hazır');
}

async function swap() {
  [from, to] = [to, from];
  renderLangs();
  if (running) {
    setStatus('connecting', 'Yön değiştiriliyor…');
    translator?.close();
    player.clear();
    finalizeTurn();
    await connectTranslator();
  }
}

// ---- Olaylar -----------------------------------------------------------
$('settingsBtn').addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden; });
$('saveKey').addEventListener('click', () => {
  const v = apiKeyInput.value.trim();
  if (v) {
    localStorage.setItem(KEY_STORE, v);
    settingsPanel.hidden = true;
    setStatus('idle', 'Anahtar kaydedildi · Hazır');
  }
});
$('swapBtn').addEventListener('click', swap);
micBtn.addEventListener('click', () => (running ? stop() : start()));

// ---- İlk yükleme -------------------------------------------------------
renderLangs();
const existing = getKey();
if (existing) {
  apiKeyInput.value = existing;
  setStatus('idle', 'Hazır');
} else {
  settingsPanel.hidden = false;
  setStatus('idle', 'API anahtarı bekleniyor');
}

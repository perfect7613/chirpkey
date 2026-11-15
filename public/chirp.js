// Shared ggwave helpers for the console and phone pages.
// Requires /vendor/ggwave.js loaded first (defines window.ggwave_factory).

export const PROTOCOLS = {
  GGWAVE_PROTOCOL_ULTRASOUND_FASTEST: "Ultrasonic (near-silent, best for the live call)",
  GGWAVE_PROTOCOL_DT_FASTEST: "Dual-tone (audible, most robust)",
  GGWAVE_PROTOCOL_AUDIBLE_FAST: "Audible (fast)",
};

let ggPromise = null;
const loadGG = () => (ggPromise ??= window.ggwave_factory());

export class Chirp {
  constructor() {
    this.ctx = null;
    this.gg = null;
    this.instance = null;
    this.listening = false;
    this._nodes = null;
  }

  // Must be called from a user gesture (click) so audio is allowed.
  async init() {
    if (this.instance) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    // ggwave's decoder fails when input/output rates differ from its 48 kHz operating rate
    // (tested: 44.1 kHz never decodes), so run audio at 48 kHz and let the browser resample.
    try { this.ctx = new AudioContext({ sampleRate: 48000 }); } catch { this.ctx = new AudioContext(); }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.gg = await loadGG();
    const p = this.gg.getDefaultParameters();
    p.sampleRateInp = this.ctx.sampleRate;
    p.sampleRateOut = this.ctx.sampleRate;
    p.sampleRate = 48000;
    p.sampleFormatInp = this.gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    p.sampleFormatOut = this.gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
    this.instance = this.gg.init(p);
  }

  // Plays text as a chirp. Resolves when playback ends.
  async send(text, protocolName, { volume = 30, repeat = 1, gapMs = 700 } = {}) {
    await this.init();
    const proto = this.gg.ProtocolId[protocolName] ?? this.gg.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST;
    const raw = this.gg.encode(this.instance, text, proto, volume);
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buf.copyToChannel(samples, 0);
    for (let i = 0; i < repeat; i++) {
      await new Promise((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        src.onended = resolve;
        src.start();
      });
      if (i < repeat - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  // Opens a raw microphone stream (no echo cancellation / noise suppression, which
  // would strip the tones) and calls onText for every decoded payload.
  async listen(onText, onLevel) {
    await this.init();
    if (this.listening) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const source = this.ctx.createMediaStreamSource(stream);
    const proc = this.ctx.createScriptProcessor(1024, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      if (onLevel) {
        let peak = 0;
        for (let i = 0; i < input.length; i += 8) peak = Math.max(peak, Math.abs(input[i]));
        onLevel(peak);
      }
      const copy = new Float32Array(input);
      const res = this.gg.decode(this.instance, new Int8Array(copy.buffer));
      if (res && res.length > 0) {
        const text = new TextDecoder("utf-8").decode(res);
        try { onText(text); } catch (err) { console.error(err); }
      }
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(this.ctx.destination);
    this._nodes = { stream, source, proc, mute };
    this.listening = true;
  }

  stopListening() {
    if (!this._nodes) return;
    const { stream, source, proc, mute } = this._nodes;
    proc.onaudioprocess = null;
    source.disconnect(); proc.disconnect(); mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    this._nodes = null;
    this.listening = false;
  }
}

export async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export const STATUS_LABEL = {
  awaiting_approval: "Waiting for phone",
  approved: "Approved",
  dispatched: "Running",
  done: "Done",
  denied: "Denied",
  expired: "Expired",
  failed: "Failed",
};

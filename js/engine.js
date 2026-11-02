import { SoundTouchNode } from "../vendor/SoundTouchNode.js";

const PROCESSOR_URL = new URL("../vendor/soundtouch-processor.js", import.meta.url).href;

function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (maybePromise && maybePromise.catch) maybePromise.catch(reject);
  });
}

/**
 * Local-file player with independent pitch (semitones) and speed.
 * The source node runs at `speed` (which also raises pitch by that factor); SoundTouch
 * is told the same rate via `playbackRate` and divides it back out, so the net result is
 * speed change with pitch fixed, plus whatever semitone shift was requested.
 */
export class PracticeEngine {
  constructor() {
    this.ctx = null;
    this.stNode = null;
    this.buffer = null;
    this.src = null;
    this.playing = false;
    this.pos = 0;
    this.basePos = 0;
    this.baseTime = 0;
    this.speed = 1;
    this.pitch = 0;
    this.loop = { enabled: false, a: 0, b: 0 };
    this.onEnded = null;
    this.graphPromise = null;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /**
   * Must run synchronously inside a real tap/click handler: iOS Safari only lets an
   * AudioContext make sound if it was created/resumed and fed a (silent) buffer during a
   * user gesture, and that permission is lost across awaits.
   */
  unlock() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();
    }
    if (this.ctx.state !== "running") {
      this.ctx.resume().catch(() => {});
      const s = this.ctx.createBufferSource();
      s.buffer = this.ctx.createBuffer(1, 1, 22050);
      s.connect(this.ctx.destination);
      s.start(0);
    }
  }

  async ensureContext() {
    if (!this.ctx) this.unlock();
    if (!this.graphPromise) {
      this.graphPromise = (async () => {
        await SoundTouchNode.register(this.ctx, PROCESSOR_URL);
        this.stNode = new SoundTouchNode({ context: this.ctx });
        this.gain = this.ctx.createGain();
        this.stNode.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        this._applyParams();
      })();
      this.graphPromise.catch(() => {
        this.graphPromise = null;
      });
    }
    await this.graphPromise;
    return this.ctx;
  }

  async load(arrayBuffer) {
    await this.ensureContext();
    this._stopSource();
    this.playing = false;
    this.pos = 0;
    this.buffer = await decode(this.ctx, arrayBuffer);
    this.loop = { enabled: false, a: 0, b: 0 };
    return this.buffer.duration;
  }

  _applyParams() {
    if (!this.stNode) return;
    this.stNode.pitch.value = 1;
    this.stNode.pitchSemitones.value = this.pitch;
    this.stNode.playbackRate.value = this.speed;
    if (this.src) this.src.playbackRate.value = this.speed;
  }

  _loopActive() {
    return this.loop.enabled && this.loop.b > this.loop.a;
  }

  _stopSource() {
    if (!this.src) return;
    const s = this.src;
    this.src = null;
    s.onended = null;
    try {
      s.stop();
    } catch (e) {
      /* already stopped */
    }
    try {
      s.disconnect();
    } catch (e) {
      /* already disconnected */
    }
  }

  _startSource(offset) {
    this._stopSource();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this.speed;
    if (this._loopActive()) {
      s.loop = true;
      s.loopStart = this.loop.a;
      s.loopEnd = Math.min(this.loop.b, this.buffer.duration);
    }
    s.connect(this.stNode);
    s.onended = () => {
      if (this.src !== s) return;
      this.src = null;
      this.playing = false;
      this.pos = 0;
      if (this.onEnded) this.onEnded();
    };
    s.start(0, offset);
    this.src = s;
    this.basePos = offset;
    this.baseTime = this.ctx.currentTime;
  }

  getPosition() {
    if (!this.playing || !this.ctx) return this.pos;
    let p = this.basePos + (this.ctx.currentTime - this.baseTime) * this.speed;
    if (this._loopActive() && p >= this.loop.b) {
      const len = this.loop.b - this.loop.a;
      p = this.loop.a + ((p - this.loop.a) % len);
      this.basePos = p;
      this.baseTime = this.ctx.currentTime;
    }
    return Math.min(p, this.duration);
  }

  async play() {
    if (!this.buffer) return;
    await this.ensureContext();
    await this.ctx.resume();
    if (this.playing) return;
    let start = this.pos;
    if (start >= this.duration - 0.05) start = 0;
    if (this._loopActive() && start >= this.loop.b) start = this.loop.a;
    this._startSource(start);
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.pos = this.getPosition();
    this._stopSource();
    this.playing = false;
  }

  seek(seconds) {
    if (!this.buffer) return;
    let t = Math.max(0, Math.min(seconds, this.duration));
    if (this._loopActive() && t >= this.loop.b) t = this.loop.a;
    this.pos = t;
    if (this.playing) this._startSource(t);
  }

  setPitch(semitones) {
    this.pitch = semitones;
    this._applyParams();
  }

  setSpeed(multiplier) {
    if (this.playing) {
      const p = this.getPosition();
      this.basePos = p;
      this.baseTime = this.ctx.currentTime;
    }
    this.speed = multiplier;
    this._applyParams();
  }

  setLoop(enabled, a, b) {
    const wasActive = this._loopActive();
    this.loop = { enabled, a, b };
    const nowActive = this._loopActive();
    const current = this.getPosition();
    const outside = nowActive && (current < a || current >= b);
    if (this.playing && this.src) {
      if (nowActive && outside) {
        this.seek(a);
        return;
      }
      this.src.loop = nowActive;
      if (nowActive) {
        this.src.loopStart = a;
        this.src.loopEnd = Math.min(b, this.duration);
      }
      if (nowActive && !wasActive) {
        this.basePos = current;
        this.baseTime = this.ctx.currentTime;
      }
    } else if (nowActive && outside) {
      this.pos = a;
    }
  }
}

// TTS 오디오 재생 큐.
// 문장 단위 오디오를 순차 재생하고, 재생 구간 동안 마이크 입력을 차단(음성 간섭 방지)합니다.
import { getContext, getVoiceBus, setMicBlocked } from './audioBus.js';

export class TTSAudioPlayer {
  constructor({ onPlayStateChange }) {
    this.context = getContext();
    this.queue = [];
    this.playing = false;
    this.onPlayStateChange = onPlayStateChange || (() => {});
  }

  // 서버에서 tts_meta + 바이너리 오디오를 수신할 때 호출
  enqueue(meta, arrayBuffer) {
    this.queue.push({ meta, buffer: arrayBuffer });
    if (!this.playing) void this._drain();
  }

  async _drain() {
    this.playing = true;
    this.setSpeaking(true);
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        const audioBuffer = await this._decode(item.buffer);
        if (!audioBuffer) continue;
        await this._playBuffer(audioBuffer);
      }
    } finally {
      this.playing = false;
      this.setSpeaking(false);
    }
  }

  async _decode(arrayBuffer) {
    try {
      return await this.context.decodeAudioData(this._toArrayBuffer(arrayBuffer));
    } catch (err) {
      console.warn('오디오 디코딩 실패:', err);
      return null;
    }
  }

  _toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) return input;
    if (ArrayBuffer.isView(input)) {
      const ab = new ArrayBuffer(input.byteLength);
      new Uint8Array(ab).set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      return ab;
    }
    return input;
  }

  _playBuffer(audioBuffer) {
    return new Promise((resolve) => {
      const src = this.context.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(getVoiceBus());
      src.onended = () => resolve();
      src.start();
    });
  }

  setSpeaking(on) {
    setMicBlocked(on); // 재생 중 마이크 차단
    this.onPlayStateChange(on);
  }

  stop() {
    this.queue = [];
  }
}
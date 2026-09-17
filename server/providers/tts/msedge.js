import { TTSProvider } from './index.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const DEFAULT_VOICE = 'ko-KR-SunHiNeural';
const SAMPLE_RATE = 24000;

export class Provider extends TTSProvider {
  constructor({
    voice = process.env.TTS_VOICE || DEFAULT_VOICE,
    pitch = process.env.TTS_PITCH || '+15Hz',
    rate = process.env.TTS_RATE || '+5%',
    volume = process.env.TTS_VOLUME || '+0%',
  } = {}) {
    super();
    this.voice = voice;
    this.pitch = pitch;
    this.rate = rate;
    this.volume = volume;
    this.tts = new MsEdgeTTS();
  }

  async init() {
    await this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    console.log(`[tts] msedge 연결 성공 – 음성: ${this.voice} | pitch: ${this.pitch} | rate: ${this.rate} | volume: ${this.volume}`);
  }

  async *speak(text) {
    if (!text?.trim()) return;

    const { audioStream } = this.tts.toStream(text, {
      pitch: this.pitch,
      rate: this.rate,
      volume: this.volume,
    });
    const chunks = [];

    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const durationMs = Math.round((buffer.length / (48000 / 8)) * 1000);

    yield {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      sampleRate: SAMPLE_RATE,
      channels: 1,
      durationMs,
      format: 'mp3',
    };
  }
}

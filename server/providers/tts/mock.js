// Mock TTS: 실제 음성 대신 WAV 오디오 버퍼를 생성합니다.
// 볼륨이 실시간으로 변하는 노이즈를 만들어 립싱크(입 움직임)를 검증할 수 있게 합니다.
import { TTSProvider } from './index.js';

const SAMPLE_RATE = 16000;

// 16-bit PCM WAV 헤더 생성
function wavHeader(dataLength, sampleRate) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

export class MockTTSProvider extends TTSProvider {
  async init() {}

  async *speak(text) {
    // 글자 수 기반으로 대략적인 발화 시간 추정 (1분당 약 960자)
    const durationMs = Math.min(10_000, Math.max(600, Math.round(text.length * 90)));
    const frames = Math.floor((durationMs / 1000) * SAMPLE_RATE);
    const data = Buffer.alloc(frames * 2);

    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < frames; i++) {
      const t = i / SAMPLE_RATE;
      // 발화 음절에 맞춰 진폭이 요동치는 노이즈 (립싱크용)
      const syllable = 9 + 3 * Math.abs(Math.sin(2 * Math.PI * t * (3 + Math.sin(t * 7) * 2)));
      const envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * t * syllable));
      const sample = (rand() * 2 - 1) * envelope * 0.35;
      data.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(sample * 32000))), i * 2);
    }

    const header = wavHeader(data.length, SAMPLE_RATE);
    const buffer = Buffer.concat([header, data]); // keep as Buffer (serializes to Uint8Array over WS)

    await new Promise((r) => setTimeout(r, 20));
    yield {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      sampleRate: SAMPLE_RATE,
      channels: 1,
      durationMs,
      format: 'wav',
    };
  }
}
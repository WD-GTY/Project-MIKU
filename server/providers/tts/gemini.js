// Gemini 3.8 Flash TTS provider (Interactions API).
// 요청: POST /v1beta/interactions, 응답: steps[].content[] 의 마지막 audio.data (base64 WAV).
import { TTSProvider } from './index.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
const DEFAULT_VOICE = 'Leda';
const DEFAULT_STYLE = 'bright, youthful, friendly and natural conversational tone';

function extractAudio(data) {
  let audio = null;
  for (const step of data?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const part of step.content || []) {
      if (part.type === 'audio' && part.data) audio = part.data;
    }
  }
  return audio;
}

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16 && offset + 24 <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataSize = Math.min(size, buffer.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataSize === null) return null;
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const durationMs = bytesPerFrame > 0
    ? Math.round((dataSize / (sampleRate * bytesPerFrame)) * 1000)
    : 0;
  return { sampleRate, channels, durationMs };
}

export class Provider extends TTSProvider {
  constructor({
    apiKey = process.env.GEMINI_API_KEY || '',
    model = process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL,
    voice = process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE,
    style = process.env.GEMINI_TTS_STYLE ?? DEFAULT_STYLE,
  } = {}) {
    super();
    this.apiKey = apiKey.trim();
    this.model = model;
    this.voice = voice;
    this.style = style.trim();
  }

  async init() {
    if (!this.apiKey) {
      await this._fallbackToEdge('API 키 없음');
      return;
    }
    console.log(`[tts] Gemini TTS 연결 – 모델: ${this.model} | voice: ${this.voice} | style: ${this.style}`);
  }

  async _fallbackToEdge(reason) {
    if (this.fallback) return;
    console.warn(`[tts] Gemini ${reason} – Edge TTS로 폴백합니다.`);
    const { Provider: EdgeProvider } = await import('./msedge.js');
    this.fallback = new EdgeProvider();
    await this.fallback.init();
  }

  async *speak(text) {
    if (!text?.trim()) return;
    if (this.fallback) {
      yield* this.fallback.speak(text);
      return;
    }

    const content = { type: 'text', text };
    if (this.style) {
      content.annotations = [{ type: 'speech_metadata', style: this.style }];
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: [{ type: 'user_input', content: [content] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: this.voice }] },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if ([401, 403, 429].includes(res.status)) {
        await this._fallbackToEdge(`HTTP ${res.status}`);
        yield* this.fallback.speak(text);
        return;
      }
      throw new Error(`Gemini TTS HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    const audio = extractAudio(data);
    if (!audio) {
      throw new Error(`Gemini TTS 응답에 오디오가 없습니다: ${JSON.stringify(data).slice(0, 300)}`);
    }

    const buffer = Buffer.from(audio, 'base64');
    const info = parseWav(buffer) ?? {
      sampleRate: 24000,
      channels: 1,
      durationMs: Math.round((buffer.length / (24000 * 2)) * 1000),
    };

    yield {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      sampleRate: info.sampleRate,
      channels: info.channels,
      durationMs: info.durationMs,
      format: 'wav',
    };
  }
}

import { TTSProvider } from './index.js';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';
const STORE_VOICES_DIR = path.resolve(process.cwd(), 'server', 'store', 'voices');

/**
 * WAV 바이너리 버퍼에서 샘플레이트, 채널 수, 재생 시간(ms)을 파싱합니다.
 */
function parseWavMeta(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
      return { sampleRate: 32000, channels: 1, durationMs: 2500 };
    }
    const channels = buf.readUInt16LE(22) || 1;
    const sampleRate = buf.readUInt32LE(24) || 32000;
    const bitsPerSample = buf.readUInt16LE(34) || 16;
    const bytesPerSample = (bitsPerSample / 8) * channels;

    // 'data' 서브청크 탐색
    let dataOffset = 36;
    let dataSize = buf.length - 44;
    while (dataOffset < buf.length - 8) {
      const chunkId = buf.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = buf.readUInt32LE(dataOffset + 4);
      if (chunkId === 'data') {
        dataSize = chunkSize;
        break;
      }
      dataOffset += 8 + chunkSize;
    }

    const durationMs = bytesPerSample > 0
      ? Math.round((dataSize / (sampleRate * bytesPerSample)) * 1000)
      : Math.round((dataSize / (sampleRate * 2)) * 1000);

    return { sampleRate, channels, durationMs: Math.max(durationMs, 500) };
  } catch {
    return { sampleRate: 32000, channels: 1, durationMs: 2500 };
  }
}

export class Provider extends TTSProvider {
  constructor({
    baseUrl = process.env.GPTSOVITS_API_URL || DEFAULT_BASE_URL,
    defaultRefAudio = process.env.GPTSOVITS_DEFAULT_REF_AUDIO || '',
    defaultPromptText = process.env.GPTSOVITS_DEFAULT_PROMPT_TEXT || '',
    defaultLang = process.env.GPTSOVITS_DEFAULT_LANG || 'ko',
    speed = parseFloat(process.env.GPTSOVITS_SPEED || '1.0'),
  } = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultRefAudio = defaultRefAudio;
    this.defaultPromptText = defaultPromptText;
    this.defaultLang = defaultLang;
    this.speed = speed;
    this.voicesDir = STORE_VOICES_DIR;
    this._initialized = false;
    this.backupTts = null;
    this._warnedOffline = false;
  }

  async init() {
    if (this._initialized) return;

    // GPT-SoVITS API 서버 생존 확인
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (res && (res.ok || res.status === 404)) {
        console.log(`[tts:gptsovits] GPT-SoVITS API 서버 연결 확인 완료: ${this.baseUrl}`);
      } else {
        console.log(`[tts:gptsovits] GPT-SoVITS API 서버(${this.baseUrl}) 미응답 – api_v2.py 실행 대기 중`);
      }
    } catch {
      console.log(`[tts:gptsovits] GPT-SoVITS API 서버(${this.baseUrl}) 연결 대기 중`);
    }

    this._initialized = true;
  }

  /**
   * 아바타별 참조 음성 경로를 확인하여 반환합니다.
   */
  _resolveRefAudio(voiceOpts) {
    const candidate = voiceOpts?.gptsovits?.refAudio || this.defaultRefAudio;
    if (candidate) {
      if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
      const inVoices = path.join(this.voicesDir, candidate);
      if (fs.existsSync(inVoices)) return inVoices;
    }

    // 기본 voices 디렉터리의 default.wav 또는 첫 번째 wav 검색
    const defaultWav = path.join(this.voicesDir, 'default.wav');
    if (fs.existsSync(defaultWav)) return defaultWav;

    try {
      const files = fs.readdirSync(this.voicesDir).filter((f) => f.endsWith('.wav'));
      if (files.length > 0) return path.join(this.voicesDir, files[0]);
    } catch {}

    return '';
  }

  async *speak(text, voiceOpts = {}) {
    const cleanText = (text || '').trim();
    if (!cleanText) return;

    const refAudioPath = this._resolveRefAudio(voiceOpts);
    const promptText = voiceOpts?.gptsovits?.promptText || this.defaultPromptText || '';
    const promptLang = voiceOpts?.gptsovits?.promptLang || this.defaultLang || 'ko';
    const textLang = voiceOpts?.gptsovits?.textLang || this.defaultLang || 'ko';

    // 1. GPT-SoVITS API v2 호출 시도
    let wavBuffer = null;
    try {
      const payload = {
        text: cleanText,
        text_lang: textLang,
        ref_audio_path: refAudioPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        top_k: 5,
        top_p: 1.0,
        temperature: 1.0,
        text_split_method: 'cut5',
        batch_size: 16,
        batch_threshold: 0.75,
        split_bucket: true,
        parallel_infer: true,
        use_cuda_graph: true,
        speed_factor: this.speed,
        fragment_interval: 0.3,
        return_fragment: false,
      };

      const res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000), // 15초 응답 대기
      });

      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        if (arrayBuf.byteLength > 100) {
          wavBuffer = Buffer.from(arrayBuf);
          if (this._warnedOffline) {
            console.log('[tts:gptsovits] GPT-SoVITS API 서버 재연결 성공 – 고품질 음성 정상 출력');
            this._warnedOffline = false;
          }
        }
      }
    } catch (err) {
      if (!this._warnedOffline) {
        console.warn(`[tts:gptsovits] GPT-SoVITS API 서버 미응답 (${err.message}) – 9880 포트 확인 필요`);
        this._warnedOffline = true;
      }
    }

    // 2. GPT-SoVITS 성공 시 청크 방출, 실패 시 백업 TTS 자동 폴백
    if (wavBuffer) {
      const meta = parseWavMeta(wavBuffer);
      yield {
        buffer: wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength),
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        durationMs: meta.durationMs,
        format: 'wav',
      };
    } else if (this.backupTts && typeof this.backupTts.speak === 'function') {
      console.log('[tts:gptsovits] GPT-SoVITS 대기 중 또는 응답 없음 - 백업 TTS로 자동 폴백 출력');
      yield* this.backupTts.speak(text, voiceOpts);
    }
  }

  destroy() {}
}

export default Provider;

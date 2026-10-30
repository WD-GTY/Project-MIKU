import { TTSProvider } from './index.js';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'supertonic_worker.py');

export class Provider extends TTSProvider {
  constructor({
    voice = process.env.SUPERTONIC_VOICE || 'F1',
    lang = process.env.SUPERTONIC_LANG || 'ko',
    speed = parseFloat(process.env.SUPERTONIC_SPEED || '1.05'),
    steps = parseInt(process.env.SUPERTONIC_STEPS || '8', 10),
  } = {}) {
    super();
    this.voice = voice;
    this.lang = lang;
    this.speed = speed;
    this.steps = steps;
    this.sampleRate = 44100;
    this.process = null;
    this.rl = null;
    this.seq = 0;
    this.pending = new Map();
    this._readyPromise = null;
    this._ready = false;
  }

  async init() {
    if (this._ready) return;
    if (this._readyPromise) return this._readyPromise;
    // 초기화 실패는 다음 요청에서 다시 시도할 수 있게 Promise를 비운다.
    this._readyPromise = this._startWorker().catch((err) => {
      this._readyPromise = null;
      this._disposeWorker();
      throw err;
    });
    return this._readyPromise;
  }

  _startWorker() {
    return new Promise((resolve, reject) => {
      // 1순위: py -3.11, 2순위: python
      const pythonCmd = process.env.PYTHON_BIN || 'py';
      const pythonArgs = pythonCmd === 'py' ? ['-3.11', WORKER_SCRIPT] : [WORKER_SCRIPT];
      let settled = false;
      let timer = null;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (err) reject(err);
        else resolve();
      };

      try {
        this.process = spawn(pythonCmd, pythonArgs, {
          stdio: ['pipe', 'pipe', 'inherit'],
          windowsHide: true,
        });
      } catch (err) {
        return finish(new Error(`Supertonic Python 워커 시작 실패: ${err.message}`));
      }

      // 준비 메시지가 오지 않은 채 프로세스가 끝나면 초기화가 영원히 대기하지 않도록 실패로 끝낸다.
      timer = setTimeout(() => {
        finish(new Error('Supertonic 워커 초기화 시간 초과 (60초)'));
      }, 60000);
      timer.unref?.();

      this.process.on('error', (err) => {
        finish(new Error(`Supertonic 워커 프로세스 오류: ${err.message}`));
      });

      this.process.on('exit', (code, signal) => {
        const msg = `Supertonic 워커 종료됨 (코드: ${code}, 시그널: ${signal})`;
        this._ready = false;
        finish(new Error(msg));
        for (const { reject: pReject } of this.pending.values()) {
          pReject(new Error(msg));
        }
        this.pending.clear();
      });

      this.rl = readline.createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);

          if (!this._ready) {
            if (msg.status === 'ready') {
              this._ready = true;
              this.sampleRate = msg.sampleRate || 44100;
              console.log(`[tts] Supertonic-3 로드 완료 [디바이스: ${msg.device || 'CPU'}] – 기본 음성: ${this.voice} | 언어: ${this.lang} | 샘플레이트: ${this.sampleRate}Hz`);
              return finish();
            } else if (msg.status === 'error') {
              return finish(new Error(msg.message || 'Supertonic 초기화 실패'));
            }
          }

          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve: pResolve, reject: pReject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
              pReject(new Error(msg.error));
            } else {
              pResolve(msg);
            }
          }
        } catch (e) {
          console.warn('[tts:supertonic] 응답 파싱 실패:', e.message, line);
        }
      });
    });
  }

  _disposeWorker() {
    this._ready = false;
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    for (const { reject } of this.pending.values()) {
      try { reject(new Error('Supertonic 워커가 정리되었습니다.')); } catch {}
    }
    this.pending.clear();
  }

  async *speak(text, voiceOpts = {}) {
    if (!text?.trim()) return;
    if (!this._ready || !this.process || this.process.killed) {
      throw new Error('Supertonic 워커가 준비되지 않았습니다.');
    }

    const selectedVoice = voiceOpts?.supertonic?.voice || this.voice;
    const selectedSpeed = Number(voiceOpts?.supertonic?.speed) || this.speed;

    const reqId = ++this.seq;
    const req = {
      id: reqId,
      text: text.trim(),
      voice: selectedVoice,
      lang: this.lang,
      speed: selectedSpeed,
      steps: this.steps,
    };

    const signal = voiceOpts?.signal;
    if (signal?.aborted) return;

    const resultPromise = new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
    });
    const onAbort = () => {
      const entry = this.pending.get(reqId);
      if (!entry) return;
      this.pending.delete(reqId);
      const err = new Error('음성 요청이 취소되었습니다.');
      err.name = 'AbortError';
      entry.reject(err);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    this.process.stdin.write(JSON.stringify(req) + '\n');
    let res;
    try {
      res = await resultPromise;
    } catch (err) {
      signal?.removeEventListener?.('abort', onAbort);
      throw err;
    }
    signal?.removeEventListener?.('abort', onAbort);
    if (signal?.aborted) return;

    const buffer = Buffer.from(res.audioBase64, 'base64');
    yield {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      sampleRate: res.sampleRate || this.sampleRate,
      channels: 1,
      durationMs: res.durationMs,
      format: 'wav',
    };
  }

  destroy() {
    this._readyPromise = null;
    this._disposeWorker();
  }
}

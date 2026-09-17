// WebSocket 허브: 클라이언트-서버 메시지 라우팅 (다중 세션 지원).
import { WebSocketServer } from 'ws';
import { ShortTermMemory } from '../memory/shortTerm.js';
import { Pipeline } from '../core/pipeline.js';
import { config } from '../config.js';
import { normalizeSessionId, getSessionMemory } from '../core/sessions.js';

// --- 서버 STT(Whisper) 스트리밍 설정 ---
// 클라이언트 전송 형식: Int16LE PCM, mono, 16kHz (client/js/audio/micManager.js 와 계약 일치)
const STT_SAMPLE_RATE = 16000;
const STT_SPEECH_THRESHOLD = 0.008; // 발화 시작 판정 RMS
const STT_SILENCE_FLUSH_MS = 800;   // 이 침묵이 지속되면 발화 종료로 판정
const STT_MIN_UTTERANCE_MS = 400;   // 이보다 짧은 구간은 노이즈로 폐기
const STT_MAX_UTTERANCE_MS = 20000; // 무한 버퍼링 방지용 강제 플러시

export function createHub({ server, deps }) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // 1. 세션 식별 (URL 쿼리 활용: /ws?sessionId=xxx) — 화이트리스트 외 값은 default 처리
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));

    // 2. 세션 전용 의존성(Memory, Pipeline) 초기화 (세션별 장기 기억은 캐시 재사용)
    const shortTerm = new ShortTermMemory({ maxTurns: config.memory.shortTermTurns });
    const longTerm = await getSessionMemory(config.memory.dbPath, sessionId);

    const send = (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    };

    const pipeline = new Pipeline({
      providers: deps.providers,
      memory: { shortTerm, longTerm },
      send,
    });

    // 3. 서버 STT: 세션별 발화 버퍼 (Int16 → Float32 누적, 에너지 기반 발화 종료 감지)
    const stt = { buffer: new Float32Array(0), speechSeen: false, silenceMs: 0, busy: false };

    function appendSttChunk(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const float = new Float32Array(Math.floor(bytes.byteLength / 2));
      for (let i = 0; i < float.length; i++) float[i] = view.getInt16(i * 2, true) / 32768;
      if (!float.length) return;

      let sumSq = 0;
      for (let i = 0; i < float.length; i++) sumSq += float[i] * float[i];
      const rms = Math.sqrt(sumSq / float.length);
      const durationMs = (float.length / STT_SAMPLE_RATE) * 1000;

      if (rms >= STT_SPEECH_THRESHOLD) {
        stt.speechSeen = true;
        stt.silenceMs = 0;
      } else if (stt.speechSeen) {
        stt.silenceMs += durationMs;
      } else {
        return; // 발화 시작 전 무음 구간은 버퍼링하지 않음
      }

      const merged = new Float32Array(stt.buffer.length + float.length);
      merged.set(stt.buffer);
      merged.set(float, stt.buffer.length);
      stt.buffer = merged;

      if (stt.silenceMs >= STT_SILENCE_FLUSH_MS || (stt.buffer.length / STT_SAMPLE_RATE) * 1000 >= STT_MAX_UTTERANCE_MS) {
        void flushStt();
      }
    }

    async function flushStt() {
      if (stt.busy) return; // 인식 처리 중이면 이후 청크에서 재시도
      const audio = stt.buffer;
      const durationMs = (audio.length / STT_SAMPLE_RATE) * 1000;
      stt.buffer = new Float32Array(0);
      stt.speechSeen = false;
      stt.silenceMs = 0;

      const sttProvider = deps.providers.stt;
      if (durationMs < STT_MIN_UTTERANCE_MS || typeof sttProvider?.transcribe !== 'function') return;

      stt.busy = true;
      try {
        const text = await sttProvider.transcribe(audio, { sampleRate: STT_SAMPLE_RATE, language: 'korean' });
        if (text) {
          send(JSON.stringify({ type: 'user_text', text, source: 'stt' })); // 클라이언트 표시용
          await pipeline.handleUserText(text); // 응답 생성
        }
      } catch (err) {
        console.error('서버 STT 인식 실패:', err.message);
        send(JSON.stringify({ type: 'notice', text: '음성 인식에 실패했습니다. 다시 말해 주세요.' }));
      } finally {
        stt.busy = false;
        if (stt.speechSeen && stt.silenceMs >= STT_SILENCE_FLUSH_MS) void flushStt();
      }
    }

    // 4. 메시지 라우팅
    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        appendSttChunk(data); // 마이크 PCM (서버 STT)
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'user_text':
          await pipeline.handleUserText(String(msg.text || ''));
          break;
        case 'stt_reset':
          // TTS 재생 등으로 입력이 끊길 때 버퍼를 비워 에코/혼합 오디오 방지
          stt.buffer = new Float32Array(0);
          stt.speechSeen = false;
          stt.silenceMs = 0;
          break;
        case 'set_goal':
          await pipeline.setGoal(String(msg.text || ''));
          break;
        case 'recall':
          await pipeline.recallDemo(String(msg.query || ''));
          break;
        case 'rag_search':
          await pipeline.ragDemo(String(msg.query || ''));
          break;
        case 'test_emotion':
          await pipeline.testEmotion(String(msg.tag || ''));
          break;
        case 'test_tts':
          await pipeline.testTTS(String(msg.text || ''));
          break;
        case 'test_stream':
          await pipeline.testStream(String(msg.text || ''));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
          break;
        default:
          break;
      }
    });

    ws.send(JSON.stringify({ type: 'welcome', message: `AI 컴페니언 연결 완료 (Session: ${sessionId})` }));
  });

  return { wss };
}
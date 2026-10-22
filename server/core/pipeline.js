// 스트리밍 파이프라인 오케스트레이터.
// LLM 토큰 스트림 → 구두점 기준 청크 → TTS 큐 → 클라이언트 오디오 전송.
// 감정 태그는 스트림 시작부에서 파싱되어 아바타 모션에 연동됩니다.
import { SentenceChunker } from './sentenceChunker.js';
import { buildSystemPrompt, buildMessages } from '../memory/contextBuilder.js';
import { search } from '../rag/retrieve.js';
import { config } from '../config.js';

const EMOTION_TAG = /^\s*\[([a-zA-Z_]+)\]/;
const TAG_PREFIX = /^\s*\[?[a-zA-Z_]*$/;

// ---- 도구 호출 시스템 ----
const VALID_TOOLS = new Set(['open_explanation','close_explanation','set_emotion','set_tone','search_rag','set_goal']);
const TONE_MAP = { casual:'친근한 구어체로', formal:'조금 격식있는 말투로', concise:'짧고 간결하게', detailed:'자세하고 풍부하게' };
const TOOL_TAG_RE = /\[TOOL:(\w+)\]/g;

/**
 * 텍스트에서 완성된 [TOOL:name]{json} 호출을 파싱합니다.
 * 문자열 내부의 {, }는 깊이 계산에서 제외됩니다.
 */
function parseToolCalls(text) {
  const calls = [];
  TOOL_TAG_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_TAG_RE.exec(text)) !== null) {
    const name = match[1];
    if (!VALID_TOOLS.has(name)) continue;
    const afterTag = text.slice(match.index + match[0].length);
    if (afterTag[0] !== '{') continue;
    // 중괄호 깊이 추적 (문자열 내부 제외)
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = 0; i < afterTag.length; i++) {
      const ch = afterTag[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    }
    if (end === -1) continue; // 미완성
    try {
      const args = JSON.parse(afterTag.slice(0, end));
      calls.push({ name, args, start: match.index, end: match.index + match[0].length + end });
    } catch { /* JSON 파싱 실패 시 스 */ }
  }
  return calls;
}

/**
 * 처리된 도구 호출의 [start, end) 범위를 제외한 텍스트를 조립합니다.
 */
function buildCleanText(fullText, processedStarts) {
  if (!processedStarts.size) return fullText;
  const ranges = [];
  for (const start of processedStarts) {
    // start는 TOOL 태그의 시작 위치, end는 parseToolCalls에서 계산
    // 하지만 Set에는 start만 저장되므로, 다시 파싱하여 end를 찾음
    TOOL_TAG_RE.lastIndex = 0;
    let m;
    while ((m = TOOL_TAG_RE.exec(fullText)) !== null) {
      if (m.index === start) {
        const afterTag = fullText.slice(m.index + m[0].length);
        if (afterTag[0] !== '{') continue;
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let i = 0; i < afterTag.length; i++) {
          const ch = afterTag[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (ch === '{') depth++;
            if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
          }
        }
        if (end !== -1) {
          ranges.push({ start: m.index, end: m.index + m[0].length + end });
        }
        break;
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let result = '', lastEnd = 0;
  for (const r of ranges) {
    result += fullText.slice(lastEnd, r.start);
    lastEnd = r.end;
  }
  result += fullText.slice(lastEnd);
  return result;
}

export class Pipeline {
  /**
   * @param {object} deps
   * @param {import('../providers/index.js')} deps.providers
   * @param {object} deps.memory { shortTerm, longTerm }
   * @param {(payloadOrBuffer: any) => void} deps.send  JSON 문자열 또는 ArrayBuffer
   */
  constructor({ providers, memory, send }) {
    this.providers = providers;
    this.memory = memory;
    this.send = send;
    this.busy = false;
    this.chunker = null;
    this.ttsQueue = [];
    this.ttsBusy = false;
    this.ttsId = 0;
  }

  _json(payload) {
    this.send(JSON.stringify(payload));
  }

  _status(state) {
    this._json({ type: 'status', state });
  }

  async handleUserText(text) {
    if (this.busy) {
      this._json({ type: 'notice', text: '잠깐, 지금 말하고 있어! 조금만 기다려 줘.' });
      return;
    }
    this.busy = true;
    try {
      this._status('thinking');

      const reply = await this._generateReply(text);

      this.memory.shortTerm.addUser(text);
      this.memory.shortTerm.addAssistant(reply);
      this._rememberFacts(text, reply);
      this._status('idle');
    } finally {
      this.busy = false;
    }
  }

  async _generateReply(userText) {
    // RAG / 장기기억 검색을 병렬 수행하되, 일정 시간 내 완료되지 않으면 스트림 시작을 막지 않음
    const retrieve = Promise.race([
      (async () => {
        try {
          const [ragHits, memHits] = await Promise.all([
            search(userText, { topK: 4 }),
            this.memory.longTerm.recall(userText, { topK: 4 }),
          ]);
          return { ragHits, memHits };
        } catch {
          return { ragHits: [], memHits: [] };
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve({ ragHits: [], memHits: [] }), 1200)),
    ]);

    const systemPrompt = buildSystemPrompt({
      longTerm: this.memory.longTerm,
      ragContext: (await retrieve).ragHits,
    });
    const messages = buildMessages({
      systemPrompt,
      history: this.memory.shortTerm.getHistory(),
      userText,
    });

    // LLM 스트리밍 시작
    const stream = this.providers.llm.streamChat({ messages });

    const { text: fullText, emotion } = await this._consumeStream(stream);
    this.chunker?.end();
    this._json({ type: 'assistant_text_end' });
    await this._ttsIdle();
    return fullText;
  }

  async _consumeStream(stream) {
    const chunker = new SentenceChunker({
      flushTimeoutMs: config.chunker.flushTimeoutMs,
      maxChunkChars: config.chunker.maxChunkChars,
      onChunk: (sentence) => this._enqueueTTS(sentence),
    });
    this.chunker = chunker;

    let fullText = '';
    let emotion = null;
    let stage = 'head'; // head: 태그 파싱 중 / body: 본문
    let head = '';
    const processedTools = new Set(); // 매 호출 초기화
    let lastCleanLen = 0;

    for await (const { token } of stream) {
      fullText += token;

      if (stage === 'head') {
        const combined = head + token;
        const m = combined.match(EMOTION_TAG);
        if (m) {
          stage = 'body';
          emotion = m[1];
          this._json({ type: 'emotion', tag: emotion });
          // fullText에서 감정 태그 제거 → body 단계에서 정제 텍스트가 태그를 포함하지 않음
          fullText = fullText.slice(m[0].length);
          const leftover = combined.slice(m[0].length);
          if (leftover) {
            this._showText(leftover);
            chunker.push(leftover);
            lastCleanLen = leftover.length;
          } else {
            lastCleanLen = 0;
          }
        } else if (TAG_PREFIX.test(combined) && combined.length < 32) {
          head = combined; // 태그로 시작될 가능성이 있어 대기
        } else {
          stage = 'body';
          emotion = 'neutral';
          this._showText(combined);
          chunker.push(combined);
          lastCleanLen = combined.length;
        }
        continue;
      }

      // body 단계: 도구 호출 스캔 + 정제 텍스트 전송
      const calls = parseToolCalls(fullText);
      for (const call of calls) {
        if (!processedTools.has(call.start)) {
          processedTools.add(call.start);
          this._handleToolCall(call.name, call.args);
        }
      }

      // 정제 텍스트 빌드: 처리된 도구 호출 제거
      const cleanText = buildCleanText(fullText, processedTools);
      const newPart = cleanText.slice(lastCleanLen);
      if (newPart) {
        this._showText(newPart);
        chunker.push(newPart);
        lastCleanLen = cleanText.length;
      }
    }

    // 스트림이 태그 도중에 끝난 경우 남은 head를 표시
    if (stage === 'head' && head) {
      this._showText(head);
      chunker.push(head);
    }

    // 스트림 종료 시 미완료 도구 호출 재처리
    const finalCalls = parseToolCalls(fullText);
    for (const call of finalCalls) {
      if (!processedTools.has(call.start)) {
        this._handleToolCall(call.name, call.args);
      }
    }

    return { text: fullText, emotion };
  }

  _handleToolCall(name, args) {
    if (name === 'set_tone') {
      // 서버 내부 처리: 톤 오버라이드 저장 (클라이언트 미전송)
      this.toneOverride = TONE_MAP[args?.style] || null;
      return;
    }
    if (!VALID_TOOLS.has(name)) {
      // 미등록 도구: 경고
      this._json({ type: 'notice', text: '알 수 없는 도구: ' + name });
      return;
    }
    // 나머지 도구는 클라이언트로 방출
    this._json({ type: 'tool_call', name, args });
  }

  _showText(text) {
    if (!text) return;
    this._json({ type: 'assistant_text_partial', text });
  }

  _enqueueTTS(sentence) {
    this.ttsQueue.push(sentence);
    if (!this.ttsBusy) void this._processTTS();
  }

  async _processTTS() {
    this.ttsBusy = true;
    try {
      while (this.ttsQueue.length) {
        const sentence = this.ttsQueue.shift();
        try {
          await this._speakSentence(sentence);
        } catch (err) {
          console.error('TTS 재생 오류:', err);
        }
      }
    } finally {
      this.ttsBusy = false;
    }
  }

  async _speakSentence(sentence) {
    this._status('speaking');
    const id = ++this.ttsId;
    for await (const chunk of this.providers.tts.speak(sentence)) {
      this._json({
        type: 'tts_meta',
        id,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        durationMs: chunk.durationMs,
        format: chunk.format,
      });
      this.send(chunk.buffer.slice(0));
    }
  }

  async _ttsIdle() {
    // 대기 중인 TTS 문장이 모두 소진될 때까지 대기
    while (this.ttsBusy || this.ttsQueue.length) {
      await new Promise((r) => setTimeout(r, 40));
    }
    this._json({ type: 'tts_end' });
  }

  async setGoal(text) {
    const goal = await this.memory.longTerm.setGoal(text);
    this._json({ type: 'memory_update', memory: goal });
    return goal;
  }

  async recallDemo(query) {
    const hits = await this.memory.longTerm.recall(query, { topK: 5 });
    this._json({ type: 'recall_result', query, hits });
    return hits;
  }

  async testEmotion(tag) {
    const valid = [
      'smile', 'think', 'cheer', 'sad', 'wink', 'love', 'neutral',
      'focus', 'proud', 'fighting', 'shy', 'panic', 'curious',
      'dozeoff', 'relieved', 'pout', 'whisper', 'sparkle', 'spaceout',
      'nod', 'shake', 'wave', 'clap', 'dance', 'explain', 'surprise', 'joy', 'angry', 'sleepy', 'wakeup', 'greet'
    ];
    const t = valid.includes(tag) ? tag : 'smile';
    this._json({ type: 'emotion', tag: t });
    this._json({ type: 'notice', text: `감정/상황 태그 테스트: [${t}]` });
  }

  async testTTS(text = '이것은 TTS 테스트 문장입니다. 잘 들리나요?') {
    this._enqueueTTS(text);
    await this._ttsIdle();
  }

  async testStream(text = '이것은 스트리밍 텍스트 테스트입니다. 감정 태그와 토큰 흐름을 확인해 보세요. 잘 작동하고 있어요!') {
    this._json({ type: 'emotion', tag: 'cheer' });
    let i = 0;
    while (i < text.length) {
      const step = 1 + Math.floor(Math.random() * 4);
      this._json({ type: 'assistant_text_partial', text: text.slice(i, i + step) });
      i += step;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 45));
    }
    this._json({ type: 'assistant_text_end' });
  }

  async ragDemo(query) {
    const hits = await search(query, { topK: 5 });
    this._json({ type: 'rag_result', query, hits });
    return hits;
  }

  _rememberFacts(userText, reply) {
    // 규칙 기반 사실 추출 (추후 LLM 기반으로 확장 가능)
    const longTerm = this.memory.longTerm;
    if (/헷갈|어렵|모르|이해가 안/i.test(userText)) {
      const content = userText.replace(/헷갈.*/, '').slice(0, 60) || userText.slice(0, 60);
      longTerm.add({ type: 'weak_concept', content: `헷갈리는 개념: ${content.trim()}`, tags: ['취약개념'], importance: 3.5 });
    }
    if (/틀렸|오답|실수/i.test(userText)) {
      longTerm.add({ type: 'mistake', content: userText.slice(0, 60), tags: ['오답'], importance: 4 });
    }
    if (/완전히 이해|이제 알겠|마스터|정복/i.test(userText)) {
      const recent = longTerm.all().find((i) => i.type === 'weak_concept' && !i.mastered);
      if (recent) longTerm.setMastered(recent.id, true);
    }
  }
}
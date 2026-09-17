// 스트리밍 파이프라인 오케스트레이터.
// LLM 토큰 스트림 → 구두점 기준 청크 → TTS 큐 → 클라이언트 오디오 전송.
// 감정 태그는 스트림 시작부에서 파싱되어 아바타 모션에 연동됩니다.
import { SentenceChunker } from './sentenceChunker.js';
import { buildSystemPrompt, buildMessages } from '../memory/contextBuilder.js';
import { search } from '../rag/retrieve.js';
import { config } from '../config.js';

const EMOTION_TAG = /^\s*\[([a-zA-Z_]+)\]/;
const TAG_PREFIX = /^\s*\[?[a-zA-Z_]*$/;

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

    for await (const { token } of stream) {
      fullText += token;

      if (stage === 'head') {
        const combined = head + token;
        const m = combined.match(EMOTION_TAG);
        if (m) {
          stage = 'body';
          emotion = m[1];
          this._json({ type: 'emotion', tag: emotion });
          const leftover = combined.slice(m[0].length);
          if (leftover) {
            this._showText(leftover);
            chunker.push(leftover);
          }
        } else if (TAG_PREFIX.test(combined) && combined.length < 32) {
          head = combined; // 태그로 시작될 가능성이 있어 대기
        } else {
          stage = 'body';
          emotion = 'neutral';
          this._showText(combined);
          chunker.push(combined);
        }
        continue;
      }

      this._showText(token);
      chunker.push(token);
    }

    // 스트림이 태그 도중에 끝난 경우 남은 head를 표시
    if (stage === 'head' && head) {
      this._showText(head);
      chunker.push(head);
    }

    return { text: fullText, emotion };
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
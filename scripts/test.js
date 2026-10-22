// 통합/유닛 테스트: API 키 없이 mock으로 전체 파이프라인을 검증합니다.
// 테스트는 항상 mock 프로바이더를 사용하도록 환경을 강제합니다.
// ES 모듈에서 static import 전에 env를 설정하려면 dynamic import가 필요합니다.
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.STT_PROVIDER = 'mock';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  getRuntime,
  ShortTermMemory,
  LongTermMemory,
  Pipeline,
  SentenceChunker,
  chunkText,
} = await (async () => {
  const providers = await import('../server/providers/index.js');
  const shortTerm = await import('../server/memory/shortTerm.js');
  const longTerm = await import('../server/memory/longTerm.js');
  const pipeline = await import('../server/core/pipeline.js');
  const chunker = await import('../server/core/sentenceChunker.js');
  const rag = await import('../server/rag/ingest.js');
  return { ...providers, ...shortTerm, ...longTerm, ...pipeline, ...chunker, ...rag };
})();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-miku-test-'));

const results = [];
const record = (name, pass, extra = '') =>
  results.push(`${pass ? '✅' : '❌'} ${name}${extra ? ` - ${extra}` : ''}`);

async function testChunker() {
  const sentences = [];
  const chunker = new SentenceChunker({ flushTimeoutMs: 800, onChunk: (s) => sentences.push(s) });

  chunker.push('여기서 이 ');
  chunker.push('공식을 적용해 보면 ');
  chunker.push('어떨까?'); // '?' 로 플러시
  assert.equal(sentences.length, 1, '구두점 완성 시 즉시 플러시');
  assert.equal(sentences[0], '여기서 이 공식을 적용해 보면 어떨까?');

  chunker.push('소수점 ');
  chunker.push('3.14');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sentences.length, 1, '소수점은 문장 끝으로 보지 않음');

  const before = sentences.length;
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(sentences.length, before + 1, '타임아웃 시 미완성 문장 플러시');

  chunker.push('매우 '); // 길이 초과 강제 분리
  chunker.push('긴 '.repeat(200));
  assert.ok(sentences.length > before + 1, 'maxChunkChars 초과 시 강제 분리');
  record('SentenceChunker', true);
}

async function testLongTermMemory() {
  const db = new LongTermMemory({ dbPath: path.join(tmpDir, 'memory.json') });
  await db.init();

  await db.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분', importance: 4 });
  await db.add({ type: 'fact', content: '수열의 합 공식', importance: 2 });

  const now = new LongTermMemory({ dbPath: path.join(tmpDir, 'memory2.json') });
  await now.init();
  const old = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 지수법칙', importance: 4 });
  old.lastAccessAt = Date.now() - 30 * 86400000; // 30일 전 접근
  now._save();

  const near = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분', importance: 4 });
  near.lastAccessAt = Date.now(); // 방금 접근
  now._save();

  // 경쟁 항목: 같은 주제지만 마스터 전 상태
  const competitor = await now.add({ type: 'weak_concept', content: '헷갈리는 개념: 로그함수 미분 기본', importance: 4 });
  competitor.mastered = false;
  competitor.lastAccessAt = Date.now();
  now._save();

  const recalled = now.recall('로그함수 미분 잘 모르겠어');
  const nearRank = recalled.findIndex((r) => r.id === near.id);
  const oldRank = recalled.findIndex((r) => r.id === old.id);
  assert.ok(nearRank !== -1, '최근 접근 항목 검색');
  assert.ok(oldRank === -1 || nearRank < oldRank, '망각 감쇠로 오래된 항목 가중치 하락');

  await now.setMastered(near.id, true);
  const afterMaster = now.recall('로그함수 미분 잘 모르겠어');
  const masteredRank = afterMaster.findIndex((r) => r.id === near.id);
  const compRank = afterMaster.findIndex((r) => r.id === competitor.id);
  assert.ok(masteredRank === -1 || (compRank !== -1 && compRank < masteredRank), '마스터된 항목은 가중치가 크게 감소');

  const goal = await db.setGoal('오늘은 미분의 연쇄법칙 마스터하기');
  assert.equal(db.getGoal().content, '오늘은 미분의 연쇄법칙 마스터하기');
  assert.ok(fs.existsSync(path.join(tmpDir, 'memory.json')), '영구 저장');
  record('LongTermMemory (망각 알고리즘)', true);
}

async function testPipeline() {
  const providers = await getRuntime();
  const shortTerm = new ShortTermMemory({ maxTurns: 8 });
  const longTerm = new LongTermMemory({ dbPath: path.join(tmpDir, 'pipe-memory.json') });
  await longTerm.init();

  const events = [];
  const send = (payload) => events.push(typeof payload === 'string' ? JSON.parse(payload) : payload);

  const pipeline = new Pipeline({ providers, memory: { shortTerm, longTerm }, send });

  const t0 = Date.now();
  await pipeline.handleUserText('안녕, 오늘 공식 문제 같이 풀자!');

  const statuses = events.filter((e) => e.type === 'status').map((e) => e.state);
  assert.ok(statuses.includes('thinking') && statuses.includes('speaking'), '상태 전이 발생');

  const emotions = events.filter((e) => e.type === 'emotion').map((e) => e.tag);
  assert.ok(emotions.length >= 1, '감정 태그 파싱');
  const tags = ['smile', 'think', 'cheer', 'sad', 'wink', 'neutral', 'love'];
  assert.ok(tags.includes(emotions[0]), `유효한 감정 태그 (${emotions[0]})`);

  const display = events
    .filter((e) => e.type === 'assistant_text_partial')
    .map((e) => e.text)
    .join('');
  assert.ok(display.includes('이'), '표시 텍스트 스트리밍');
  assert.ok(!display.includes('['), '감정 태그가 표시에서 제거됨');

  const ttsMetas = events.filter((e) => e.type === 'tts_meta');
  assert.ok(ttsMetas.length >= 1, 'TTS 메타 전송');
  const binaryCount = events.filter((e) => e instanceof ArrayBuffer).length;
  assert.ok(binaryCount >= 1, 'TTS 오디오 바이너리 전송');

  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 8000, `소요 시간 적정 (${elapsed}ms)`);

  assert.equal(shortTerm.turns.length, 2, '단기 기억에 user/assistant 기록');
  record('Pipeline (mock LLM/TTS 통합)', true, `첫 응답 완료 ${elapsed}ms`);
}

async function testRagChunk() {
  const chunks = chunkText('첫 번째 문단입니다.\n\n두 번째 문단입니다. 내용이 충분히 길어야 합니다.'.repeat(8));
  assert.ok(chunks.length >= 1, '청크 분할 생성');
  assert.ok(chunks.every((c) => c.length <= 700), '청크 크기 제한');
  record('RAG 청크 분할', true, `${chunks.length}개 청크`);
}

(async () => {
  await testChunker();
  await testLongTermMemory();
  await testPipeline();
  await testRagChunk();

  console.log('\n===== 테스트 결과 =====');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('❌'));
  console.log(failed.length ? `\n실패: ${failed.length}` : '\n전체 통과 🎉');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('테스트 에러:', err);
  process.exit(1);
});
// Provider 팩토리: .env 설정에 따라 실제 구현체를 로드합니다.
// 실제 프로바이더 연결 실패 시 mock으로 자동 폴백하여 서버가 항상 기동되도록 합니다.
import { config } from '../config.js';
import { MockLLMProvider } from './llm/mock.js';
import { MockTTSProvider } from './tts/mock.js';
import { MockSTTProvider } from './stt/mock.js';
import { TransformersEmbeddingProvider } from './embedding/transformers.js';

export async function createProviders() {
  const { llm, tts, stt, embedding } = config.providers;

  const providers = {
    llm: null,
    tts: null,
    stt: null,
    embedding: null,
  };

  // --- LLM ---
  if (llm === 'mock') {
    providers.llm = new MockLLMProvider();
  } else {
    try {
      const { loadRealProvider } = await import(`./llm/${llm}.js`);
      if (!loadRealProvider) throw new Error(`알 수 없는 LLM provider: ${llm}`);
      providers.llm = await loadRealProvider();
    } catch (err) {
      console.warn(`[providers] LLM(${llm}) 연결 실패, mock으로 폴백:`, err.message);
      providers.llm = new MockLLMProvider();
    }
  }

  // --- TTS ---
  if (tts === 'mock') {
    providers.tts = new MockTTSProvider();
  } else {
    try {
      const mod = await import(`./tts/${tts}.js`);
      const Ctor = mod.Provider || mod.default;
      if (typeof Ctor !== 'function') throw new Error(`TTS provider 기본 내보내기 없음: ${tts}`);
      providers.tts = new Ctor();
    } catch (err) {
      console.warn(`[providers] TTS(${tts}) 로드 실패, mock으로 폴백:`, err.message);
      providers.tts = new MockTTSProvider();
    }
  }

  // --- STT ---
  if (stt === 'mock') {
    providers.stt = new MockSTTProvider();
  } else {
    try {
      const mod = await import(`./stt/${stt}.js`);
      const Ctor = mod.Provider || mod.default;
      if (typeof Ctor !== 'function') throw new Error(`STT provider 기본 내보내기 없음: ${stt}`);
      providers.stt = new Ctor();
    } catch (err) {
      console.warn(`[providers] STT(${stt}) 로드 실패, mock으로 폴백:`, err.message);
      providers.stt = new MockSTTProvider();
    }
  }

  // --- Embedding ---
  if (embedding === 'transformers') providers.embedding = new TransformersEmbeddingProvider();

  // 임베딩은 첫 사용 시(lazy) 초기화하여 서버 시작을 빠르게 유지
  // 각 프로바이더 init 실패 시 mock으로 대체하여 서버가 항상 기동되도록 함
  await Promise.all(
    Object.entries(providers)
      .filter(([k, p]) => k !== 'embedding' && p)
      .map(async ([key, p]) => {
        try {
          await p.init?.();
        } catch (err) {
          console.warn(`[providers] ${key} init 실패, mock으로 폴백:`, err.message);
          if (key === 'llm') providers.llm = new MockLLMProvider();
          else if (key === 'tts') providers.tts = new MockTTSProvider();
          else if (key === 'stt') providers.stt = new MockSTTProvider();
        }
      })
  );

  return providers;
}

let runtime = null;
export async function getRuntime() {
  if (!runtime) runtime = await createProviders();
  return runtime;
}

export function getEmbeddingRuntime() {
  if (!runtime) throw new Error('프로바이더가 아직 초기화되지 않았습니다. getRuntime()을 먼저 호출하세요.');
  return runtime;
}

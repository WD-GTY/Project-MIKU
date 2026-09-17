// 로컬 실행 임베딩: @xenova/transformers (all-MiniLM-L6-v2).
// 외부 API 키 없이 로컬에서 동작하므로 RAG를 지금 바로 구현/검증할 수 있습니다.
import { pipeline } from '@xenova/transformers';
import { EmbeddingProvider } from './index.js';

export class TransformersEmbeddingProvider extends EmbeddingProvider {
  constructor() {
    super();
    this.model = 'Xenova/all-MiniLM-L6-v2';
    this.embedder = null;
  }

  async init() {
    if (!this.embedder) {
      // 첫 호출 시 모델 다운로드(캐시 후 오프라인 가능)
      this.embedder = await pipeline('feature-extraction', this.model);
    }
  }

  async embed(texts) {
    await this.init();
    const out = await this.embedder(texts, { pooling: 'mean', normalize: true });
    const batch = Array.isArray(out) ? out : [out];
    return batch.map((t) => Array.from(t.data));
  }
}
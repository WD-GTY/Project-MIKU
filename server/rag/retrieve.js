// RAG 검색: 질문을 임베딩해 Chroma에서 관련 학습 자료 청크를 찾습니다.
import { connect } from './chromaClient.js';
import { getEmbeddingRuntime } from '../providers/index.js';

export async function search(query, { topK = 4 } = {}) {
  const { collection, available } = await connect();
  if (!available) return [];

  const { embedding } = getEmbeddingRuntime();
  const vec = await embedding.embedQuery(query);

  const res = await collection.query({
    queryEmbeddings: [vec],
    nResults: topK,
    include: ['documents', 'distances', 'metadatas'],
  });

  const docs = res.documents?.[0] || [];
  const dists = res.distances?.[0] || [];
  const metas = res.metadatas?.[0] || [];
  return docs.map((document, i) => ({
    document,
    distance: dists[i],
    metadata: metas[i] || {},
    score: 1 - (dists[i] ?? 1),
  }));
}
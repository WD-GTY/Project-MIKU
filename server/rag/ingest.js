// 학습 자료 수집(RAG): PDF/텍스트를 파싱하고 청크로 분할하여 임베딩 후 Chroma에 적재합니다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MATERIALS_DIR } from '../config.js';
import { connect } from './chromaClient.js';
import { getEmbeddingRuntime } from '../providers/index.js';

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 120;

// pdf-parse 1.1.1은 index.js에 테스트 파일 의존이 있어 lib 경로로 import
async function loadPdfParser() {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  return mod.default || mod;
}

export function chunkText(text) {
  const normalized = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf && buf.length + p.length > CHUNK_SIZE) {
      chunks.push(buf.trim());
      buf = buf.slice(-CHUNK_OVERLAP) + '\n';
    }
    buf += p + '\n';
    if (buf.length >= CHUNK_SIZE) {
      chunks.push(buf.trim());
      buf = buf.slice(-CHUNK_OVERLAP) + '\n';
    }
  }
  if (buf.trim().length > 40) chunks.push(buf.trim());
  return chunks;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt') return fs.readFileSync(filePath, 'utf8');
  if (ext === '.md') return fs.readFileSync(filePath, 'utf8');
  if (ext === '.pdf') {
    const pdfParse = await loadPdfParser();
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text || '';
  }
  throw new Error(`지원하지 않는 형식: ${ext} (pdf/txt/md)`);
}

export async function ingestFile({ originalName, buffer }) {
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
  // 경로 조작 방지: 파일명만 추출하고, 화이트리스트 외 문자는 _ 로 치환
  const base = path.basename(String(originalName || '')).replace(/^\.+/, '').trim();
  const safe = `${Date.now()}-${base.replace(/[^a-zA-Z0-9._가-힣-]/g, '_') || 'upload.txt'}`;
  const filePath = path.join(MATERIALS_DIR, safe);
  fs.writeFileSync(filePath, buffer);

  const text = await extractText(filePath);
  const chunks = chunkText(text);

  const { collection, available } = await connect();
  if (!available) {
    return { filePath, chunks: chunks.length, embedded: 0, note: 'Chroma 서버 미연결 - 임베딩 건너뜀' };
  }

  const { embedding } = getEmbeddingRuntime();
  const vectors = await embedding.embed(chunks);

  const ids = chunks.map(() => randomUUID());
  await collection.upsert({
    ids,
    embeddings: vectors,
    documents: chunks,
    metadatas: chunks.map((_, i) => ({
      source: originalName,
      filePath: safe,
      chunkIndex: i,
    })),
  });

  return { filePath, chunks: chunks.length, embedded: chunks.length };
}

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const CLIENT_DIR = path.join(ROOT, 'client');
export const STORE_DIR = path.join(ROOT, 'server', 'store');
export const MATERIALS_DIR = path.join(STORE_DIR, 'materials');
export const MODEL_DIR = path.join(CLIENT_DIR, 'assets', 'models', 'live2d');

export const config = {
  port: Number(process.env.PORT) || 25565,
  chroma: {
    url: process.env.CHROMA_URL || 'http://127.0.0.1:8000',
    collection: process.env.CHROMA_COLLECTION || 'study_materials',
  },
  memory: {
    dbPath: process.env.MEMORY_DB || path.join(STORE_DIR, 'memory.db'),
    shortTermTurns: 12,
    forgetHalfLifeDays: 7,
  },
  chunker: {
    flushTimeoutMs: 1200,
    maxChunkChars: 160,
  },
  providers: {
    llm: process.env.LLM_PROVIDER || 'mock',
    stt: process.env.STT_PROVIDER || 'mock',
    tts: process.env.TTS_PROVIDER || 'mock',
    embedding: process.env.EMBEDDING_PROVIDER || 'transformers',
  },
};

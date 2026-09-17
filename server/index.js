// 서버 엔트리: Express 정적 서빙 + WebSocket 허브 + 자료 업로드 API
import express from 'express';
import http from 'node:http';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config, CLIENT_DIR, MATERIALS_DIR } from './config.js';
import { getRuntime, getEmbeddingRuntime } from './providers/index.js';
import { getSessionMemory } from './core/sessions.js';
import { Pipeline } from './core/pipeline.js';
import { createHub } from './ws/hub.js';
import { ingestFile } from './rag/ingest.js';
import { AVATAR_MODELS, DEFAULT_AVATAR_MODEL_ID, resolveAvatarModelId } from './avatarModels.js';

async function main() {
  const providers = await getRuntime();
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });

  // 임베딩 모델을 백그라운드에서 미리 로딩 (첫 RAG 검색 시 수 초 지연 제거)
  getEmbeddingRuntime().embedding?.init?.().catch((err) => {
    console.warn('[embedding] 백그라운드 사전 로딩 실패 (사용 시 재시도):', err.message);
  });

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const server = http.createServer(app);
  const deps = { providers };
  const hub = createHub({ server, deps });

  // 정적 클라이언트
  app.use(express.static(CLIENT_DIR));

  // 학습 자료 업로드 + 인제스트
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

  app.post('/api/materials', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다. (multipart 필드명: file)' });
    try {
      const result = await ingestFile({
        originalName: req.file.originalname,
        buffer: req.file.buffer,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/materials', (_req, res) => {
    const files = fs.existsSync(MATERIALS_DIR)
      ? fs.readdirSync(MATERIALS_DIR).map((f) => ({ name: f, size: fs.statSync(path.join(MATERIALS_DIR, f)).size }))
      : [];
    res.json({ files });
  });

  app.get('/api/goal', async (req, res) => {
    const lt = await getSessionMemory(config.memory.dbPath, req.query.sessionId);
    res.json({ goal: lt.getGoal() });
  });

  app.post('/api/goal', async (req, res) => {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: 'text 필드가 필요합니다.' });
    const lt = await getSessionMemory(config.memory.dbPath, req.body.sessionId);
    const goal = await lt.setGoal(text);
    res.json({ goal });
  });

  app.get('/api/memories', async (req, res) => {
    const lt = await getSessionMemory(config.memory.dbPath, req.query.sessionId);
    res.json({ memories: lt.all() });
  });

  // 클라이언트용 런타임 설정 (예: 서버 STT 사용 여부 판단)
  app.get('/api/config', (_req, res) => {
    res.json({ providers: config.providers });
  });

  // ---- 아바타 모델 ----
  // 모델 목록 (선택 UI용, 기본 모델 포함)
  app.get('/api/avatar-models', (_req, res) => {
    res.json({ models: AVATAR_MODELS, defaultModelId: DEFAULT_AVATAR_MODEL_ID });
  });

  // 세션별 선택 모델 조회 (미선택/무효 시 기본 모델)
  app.get('/api/avatar-model', async (req, res) => {
    const lt = await getSessionMemory(config.memory.dbPath, req.query.sessionId);
    const saved = lt.getAvatarModel();
    res.json({ modelId: resolveAvatarModelId(saved?.content) });
  });

  // 세션별 선택 모델 저장 (다른 세션에 영향 없음)
  app.post('/api/avatar-model', async (req, res) => {
    const modelId = resolveAvatarModelId(req.body.modelId);
    if (!req.body.modelId) return res.status(400).json({ error: 'modelId 필드가 필요합니다.' });
    const lt = await getSessionMemory(config.memory.dbPath, req.body.sessionId);
    await lt.setAvatarModel(modelId);
    res.json({ modelId });
  });

  server.listen(config.port, () => {
    console.log(`AI 컴페니언 서버: http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('서버 시작 실패:', err);
  process.exit(1);
});
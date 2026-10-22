// 앱 진입점: 아바타/오디오/WS/UI를 연결합니다.
import { Live2DStage } from './avatar/live2dStage.js';
import { WSClient } from './agent/wsClient.js';
import { TTSAudioPlayer } from './audio/playback.js';
import { MicManager } from './audio/micManager.js';
import { onLipVolume, ensureResumed } from './audio/audioBus.js';
import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);

const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
const micBtn = $('#btn-mic');
const goalCurrent = $('#goal-current');
const goalInput = $('#goal-input');
const materialList = $('#material-list');
const ragResults = $('#rag-results');
const boardBody = $('#board-body');
const explanationPanel = $('#explanation-panel');
const explanationContent = $('#explanation-content');
const explanationTitle = $('#explanation-title');

let curBubble = null;
let pendingTtsMeta = null;
let lastRagQuery = null;

// 세션 ID 로드 또는 생성
let sessionId = localStorage.getItem('agy_session_id');
if (!sessionId) {
  sessionId = Math.random().toString(36).substring(2, 10);
  localStorage.setItem('agy_session_id', sessionId);
}

// ---- 아바타 모델 선택 (세션별, 서버 저장 + 로컬 백업) ----
let avatarModels = [];
let currentModelId = null;
const avatarKey = () => `miku_avatar_${sessionId}`;

async function fetchAvatarModels() {
  try {
    const res = await fetch('/api/avatar-models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { models: data.models || [], defaultModelId: data.defaultModelId || 'haru' };
  } catch {
    return { models: [], defaultModelId: 'haru' };
  }
}

// 서버 프로바이더 설정 조회 (서버 STT 사용 여부 판단용)
async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return { providers: {} };
  }
}

async function loadSavedAvatarModel(fallbackId) {
  // 1순위: 서버에 저장된 세션별 선택, 2순위: 이 세션의 로컬 백업, 3순위: 기본 모델
  try {
    const res = await fetch(`/api/avatar-model?sessionId=${encodeURIComponent(sessionId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.modelId) return data.modelId;
    }
  } catch {}
  try {
    const local = localStorage.getItem(avatarKey());
    if (local) return local;
  } catch {}
  return fallbackId;
}

async function saveAvatarModel(modelId) {
  try { localStorage.setItem(avatarKey(), modelId); } catch {}
  try {
    await fetch('/api/avatar-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, modelId }),
    });
  } catch {}
}

function renderAvatarSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const list = avatarModels.length
    ? avatarModels
    : [{ id: 'haru', name: 'Haru (기본)', modelUrl: '/assets/models/live2d/haru/Haru.model3.json' }];
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    selectEl.appendChild(opt);
  }
  if (currentModelId) selectEl.value = currentModelId;
}

async function boot() {
  const avatarSelect = $('#avatar-select');
  const { models, defaultModelId } = await fetchAvatarModels();
  avatarModels = models;
  currentModelId = await loadSavedAvatarModel(defaultModelId);

  const stage = new Live2DStage(document.getElementById('avatar-canvas'));
  window._stage = stage; // 도구 호출에서 감정 제어용
  onLipVolume((vol) => stage.setLipVolume(vol));
  try {
    await stage.init({ modelId: currentModelId, availableModels: avatarModels });
    currentModelId = stage.modelId || currentModelId;
  } catch (err) {
    console.error(err);
    addNotice('아바타 모델을 불러오지 못했습니다. (setup-sample-model 실행 여부 확인)');
  }
  renderAvatarSelect(avatarSelect);

  // 서버 STT(Whisper) 활성 시: Web Speech API 대신 마이크 PCM을 WS로 전송
  const serverConfig = await fetchServerConfig();
  const useServerStt = Boolean(serverConfig.providers?.stt) && serverConfig.providers.stt !== 'mock';
  const mic = new MicManager({
    onTranscript: (text) => sendUserText(text),
    onListeningChange: (on) => micBtn.classList.toggle('listening', on),
    ...(useServerStt
      ? {
          mode: 'server',
          onServerChunk: (buf) => ws.sendBinary(buf),
          onServerReset: () => ws.send({ type: 'stt_reset' }),
        }
      : {}),
  });

  const player = new TTSAudioPlayer({
    onPlayStateChange: (speaking) => {
      // 초점: TTS 재생 중에만 마이크 인식 차단 (음성 간섭 방지) 및 아바타 립싱크 발화 상태 동기화
      mic.setSpeechBlocked(speaking);
      stage.setSpeaking(speaking);
    },
  });

  const ws = new WSClient({
    url: `ws://${location.host}/ws?sessionId=${sessionId}`,
    onMessage: (msg, isBinary) => {
      if (isBinary) {
        if (pendingTtsMeta) player.enqueue(pendingTtsMeta, msg);
        return;
      }
      handleMessage(msg, stage);
    },
    onOpen: () => {},
    onClose: () => {},
  });
  ws.connect();
  window._ws = ws; // 디버그용

  // ---- UI 바인딩 ----
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    sendUserText(text);
  });

  micBtn.addEventListener('click', () => {
    ensureResumed();
    mic.toggle();
  });
  if (!mic.supported) {
    micBtn.disabled = true;
    micBtn.title = '이 브라우저는 음성 인식을 지원하지 않습니다.';
  }

  $('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = goalInput.value.trim();
    if (!text) return;
    // 로컬 즉시 반영
    localStorage.setItem('agy_goal', text);
    updateGoalDisplay(text);
    ws.send({ type: 'set_goal', text });
    goalInput.value = '';
    closeModal('goal-modal-overlay');
  });

  $('#upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#upload-file').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    addNotice(`자료 업로드 중: ${file.name}`);
    try {
      const res = await fetch('/api/materials', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '업로드 실패');
      addNotice(`업로드 완료 (${data.chunks}개 청크 → 임베딩 ${data.embedded}개)`);
    } catch (err) {
      addNotice(`업로드 실패: ${err.message}`);
    }
    $('#upload-file').value = '';
    loadMaterials();
  });

  $('#btn-rag-search').addEventListener('click', () => {
    const q = $('#rag-query').value.trim();
    if (!q) return;
    ragResults.innerHTML = '';
    ws.send({ type: 'rag_search', query: q });
  });

  $('#btn-tap').addEventListener('click', () => stage.tap());
  $('#btn-recenter')?.addEventListener('click', () => stage.resetPosition());

  // 크기 슬라이더 ↔ 스테이지 줌 동기화
  const zoomSlider = $('#avatar-zoom');
  const zoomLabel = $('#avatar-zoom-label');
  const paintZoom = (z) => {
    if (zoomSlider) zoomSlider.value = String(Math.round(z * 100));
    if (zoomLabel) zoomLabel.textContent = `${Math.round(z * 100)}%`;
  };
  if (zoomSlider) {
    zoomSlider.addEventListener('input', () => {
      stage.setZoom(Number(zoomSlider.value) / 100);
    });
    stage.onZoomChange = paintZoom;
    paintZoom(stage.getZoom());
  }

  // 아바타 모델 전환 (이 세션에만 저장, 다른 세션에 영향 없음)
  if (avatarSelect) {
    avatarSelect.addEventListener('change', async () => {
      const nextId = avatarSelect.value;
      if (!nextId || nextId === currentModelId) return;
      const prevId = currentModelId;
      avatarSelect.disabled = true;
      addNotice('아바타 모델 전환 중...');
      try {
        const result = await stage.switchModel(nextId, { availableModels: avatarModels });
        currentModelId = result.id || nextId;
        avatarSelect.value = currentModelId;
        await saveAvatarModel(currentModelId);
        const label = avatarModels.find((m) => m.id === currentModelId)?.name || currentModelId;
        addNotice(`아바타 변경 완료: ${label}`);
      } catch (err) {
        console.error(err);
        avatarSelect.value = prevId;
        addNotice(`모델 전환 실패: ${err.message}`);
      } finally {
        avatarSelect.disabled = false;
      }
    });
  }

  // ---- 드로어 / 모달 바인딩 ----
  setupDrawer();
  setupGoalModal();

  // 설명 패널 닫기 버튼
  $('#btn-close-explanation')?.addEventListener('click', closeExplanationPanel);

  // 자동재생 정책 대응: 첫 상호작용 시 오디오 컨텍스트 재개
  document.addEventListener('pointerdown', ensureResumed, { once: true });

  // Shift+T: 기능별 독립 테스트 페이지 열기
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key.toLowerCase() === 't') {
      window.open('/test.html', '_blank');
    }
  });

  await loadGoal();
  loadMaterials();
}

// ---- 메시지 처리 ----
function handleMessage(msg, stage) {
  switch (msg.type) {
    case 'status':
      break;
    case 'user_text': {
      // 서버 STT로 인식된 발화 — 표시만 하고 재전송하지 않음 (무한 루프 방지)
      const div = addBubble('user');
      div.textContent = msg.text || '';
      break;
    }
    case 'emotion':
      if (stage) stage.setEmotion(msg.tag);
      break;
    case 'assistant_text_partial':
      appendAssistant(msg.text);
      break;
    case 'assistant_text_end':
      finalizeAssistant();
      break;
    case 'tts_meta':
      pendingTtsMeta = msg;
      break;
    case 'tts_end':
      break;
    case 'memory_update':
      addNotice('장기 기억에 저장했어! 🧠');
      loadGoal();
      break;
    case 'recall_result':
      renderRecall(msg);
      break;
    case 'rag_result':
      renderRagResult(msg);
      break;
    case 'notice':
      addNotice(msg.text);
      break;
    case 'tool_call':
      handleToolCall(msg.name, msg.args);
      break;
    default:
      break;
  }
}

// ---- 목표 / 자료 / 검색 결과 ----
function sendUserText(text) {
  window._ws?.send({ type: 'user_text', text });
  closeExplanationPanel();
  const div = addBubble('user');
  div.textContent = text;
}

function addBubble(role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function appendAssistant(text) {
  if (!text || !text.trim()) return; // §11: 빈 텍스트 버블 방지
  if (!curBubble) {
    curBubble = addBubble('assistant');
    curBubble.classList.add('streaming');
  }
  curBubble.textContent += text;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function finalizeAssistant() {
  if (curBubble) {
    curBubble.classList.remove('streaming');
    curBubble = null;
  }
}

function addNotice(text) {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.style.opacity = '0.7';
  div.style.fontSize = '12px';
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---- 목표 / 자료 / 검색 결과 ----
function updateGoalDisplay(text) {
  const label = `🎯 ${text}`;
  if (goalCurrent) goalCurrent.textContent = label;
}

async function loadGoal() {
  // 로컬 캐시로 즉시 표시
  const localGoal = localStorage.getItem('agy_goal');
  if (localGoal) {
    updateGoalDisplay(localGoal);
  }
  // 서버에서 최신 목표 동기화
  try {
    const res = await fetch(`/api/goal?sessionId=${sessionId}`);
    const data = await res.json();
    if (data.goal?.content) {
      updateGoalDisplay(data.goal.content);
      localStorage.setItem('agy_goal', data.goal.content);
    } else if (!localGoal) {
      updateGoalDisplay('');
    }
  } catch {
    if (!localGoal) {
      if (goalCurrent) goalCurrent.textContent = '목표 로드 실패';
    }
  }
}

async function loadMaterials() {
  try {
    const res = await fetch('/api/materials');
    const data = await res.json();
    materialList.innerHTML = data.files.length
      ? data.files.map((f) => `📄 ${f.name} (${(f.size / 1024).toFixed(1)} KB)`).join('<br/>')
      : '등록된 자료가 없습니다. (pdf/txt/md 업로드)';
  } catch {
    materialList.innerHTML = '자료 목록 로드 실패';
  }
}

function renderRecall(msg) {
  if (!msg.hits.length) return;
  addNotice(`기억 검색 결과: ${msg.hits.map((h) => h.content).join(' / ')}`);
}

function renderRagResult(msg) {
  ragResults.innerHTML = '';
  if (!msg.hits.length) {
    ragResults.innerHTML = '<div class="note">검색 결과 없음 (Chroma 서버 실행 필요: chroma run --path ./chroma)</div>';
    return;
  }
  for (const hit of msg.hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    div.innerHTML = `<strong>${hit.metadata?.source || '자료'}</strong> (유사도 ${(hit.score ?? 0).toFixed(2)})<br/>${escapeHtml(hit.document)}`;
    ragResults.appendChild(div);
  }
}

function escapeHtml(str) {
  return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 드로어 (RAG 자료 관리) ----
function setupDrawer() {
  const overlay = $('#drawer-overlay');
  const drawer = $('#material-drawer');
  const openBtns = [$('#btn-open-materials-2')];
  const closeBtn = $('#btn-close-materials');

  const open = () => {
    drawer.classList.add('open');
    overlay.classList.add('open');
  };
  const close = () => {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  };

  openBtns.forEach(btn => btn?.addEventListener('click', open));
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
}

// ---- 목표 모달 ----
function setupGoalModal() {
  const overlay = $('#goal-modal-overlay');
  const goalEditBtn = $('#btn-goal-edit');
  const closeBtn = $('#btn-close-goal');

  const open = () => {
    overlay.classList.add('open');
    goalInput?.focus();
  };
  const close = () => {
    overlay.classList.remove('open');
  };

  goalEditBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

function closeModal(overlayId) {
  const overlay = $(`#${overlayId}`);
  if (overlay) overlay.classList.remove('open');
}

// ---- 설명 패널 제어 ----
function openExplanationPanel(title, content) {
  boardBody.classList.add('split-mode');
  explanationPanel.removeAttribute('hidden');
  if (title) explanationTitle.textContent = title;
  explanationContent.innerHTML = renderMarkdown(content || '');
}
function closeExplanationPanel() {
  boardBody.classList.remove('split-mode');
  explanationPanel.setAttribute('hidden', '');
  explanationContent.innerHTML = '';
}

// ---- 도구 호출 처리 ----
const VALID_EMOTION_TAGS = new Set(['smile','think','cheer','sad','wink','neutral','love','focus','proud','fighting','shy','panic','curious','relieved','pout','whisper','sparkle','explain','surprise','joy','angry','sleepy','wakeup','greet','nod','shake','wave','clap','dance','dozeoff','spaceout']);

function handleToolCall(name, args) {
  switch (name) {
    case 'open_explanation':
      openExplanationPanel(args?.title, args?.content);
      break;
    case 'close_explanation':
      closeExplanationPanel();
      break;
    case 'set_emotion':
      if (args?.tag && VALID_EMOTION_TAGS.has(args.tag)) {
        window._stage?.setEmotion(args.tag);
      }
      break;
    case 'search_rag':
      if (args?.query) {
        const now = Date.now();
        if (!lastRagQuery || lastRagQuery.text !== args.query || now - lastRagQuery.time > 3000) {
          lastRagQuery = { text: args.query, time: now };
          window._ws?.send({ type: 'rag_search', query: args.query });
        }
      }
      break;
    case 'set_goal':
      if (args?.text) window._ws?.send({ type: 'set_goal', text: args.text });
      break;
    case 'set_tone':
      // 서버 처리, 클라이언트 무시
      break;
    default:
      console.warn('알 수 없는 tool_call:', name);
  }
}

boot().catch((err) => {
  console.error('부트 실패:', err);
  addNotice('앱 초기화 실패: ' + err.message);
});
// 앱 진입점: 아바타/오디오/WS/UI를 연결합니다.
import { Live2DStage } from './avatar/live2dStage.js';
import { WSClient } from './agent/wsClient.js';
import { TTSAudioPlayer } from './audio/playback.js';
import { MicManager } from './audio/micManager.js';
import { onLipVolume, ensureResumed } from './audio/audioBus.js';

const $ = (sel) => document.querySelector(sel);

const statusBadge = $('#status-badge');
const connState = $('#conn-state');
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
const micBtn = $('#btn-mic');
const goalCurrent = $('#goal-current');
const goalInput = $('#goal-input');
const materialList = $('#material-list');
const ragResults = $('#rag-results');
const statusLabels = {
  idle: '대기 중',
  thinking: '생각 중...',
  speaking: '말하는 중...',
  listening: '듣는 중...',
  busy: '잠깐만...',
};

let curBubble = null;
let pendingTtsMeta = null;

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
  onLipVolume((vol) => stage.setLipVolume(vol));
  try {
    await stage.init({ modelId: currentModelId, availableModels: avatarModels });
    currentModelId = stage.modelId || currentModelId;
  } catch (err) {
    console.error(err);
    setBadge('idle');
    addNotice('아바타 모델을 불러오지 못했습니다. (setup-sample-model 실행 여부 확인)');
  }
  renderAvatarSelect(avatarSelect);

  const mic = new MicManager({
    onTranscript: (text) => sendUserText(text),
    onListeningChange: (on) => micBtn.classList.toggle('listening', on),
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
    onOpen: () => connState.textContent = '연결됨',
    onClose: () => connState.textContent = '연결 안 됨',
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
    goalCurrent.textContent = `🎯 ${text}`;
    ws.send({ type: 'set_goal', text });
    goalInput.value = '';
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
      setBadge(msg.state);
      break;
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
    default:
      break;
  }
}

function setBadge(state) {
  const label = statusLabels[state] || statusLabels.idle;
  statusBadge.textContent = label;
  statusBadge.className = `status ${state}`;
}

function sendUserText(text) {
  window._ws?.send({ type: 'user_text', text });
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
async function loadGoal() {
  // 로컬 캐시로 즉시 표시
  const localGoal = localStorage.getItem('agy_goal');
  if (localGoal) {
    goalCurrent.textContent = `🎯 ${localGoal}`;
  }
  // 서버에서 최신 목표 동기화
  try {
    const res = await fetch(`/api/goal?sessionId=${sessionId}`);
    const data = await res.json();
    if (data.goal?.content) {
      goalCurrent.textContent = `🎯 ${data.goal.content}`;
      localStorage.setItem('agy_goal', data.goal.content);
    } else if (!localGoal) {
      goalCurrent.textContent = '아직 설정된 목표가 없어요. 왼쪽에서 설정해 보세요!';
    }
  } catch {
    if (!localGoal) goalCurrent.textContent = '목표 로드 실패';
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

boot().catch((err) => {
  console.error('부트 실패:', err);
  addNotice('앱 초기화 실패: ' + err.message);
});
// Live2D 아바타 스테이지: PIXI + pixi-live2d-display 로드 및 표정/립싱크 제어.
// 세션별 모델 전환 지원: switchModel(modelId | modelUrl)로 런타임 교체 가능.
// 기본 모델은 Haru (실패 시 Senko 폴백) - 기존 동작 유지.
// 인터랙션: 클릭=건드리기, 빈 공간 드래그=위치 이동, 모델 위 드래그=쓰다듬기,
//           꾹 누르기=쓰다듬 홀딩, 더블클릭=축하.
// 애니메이션: 커서 트래킹(머리 추적), 유휴(호흡/깜빡/좌우擺), 쓰다듬기(흔들림/기대기),
//            상황별 모션(설명=끼리, 놀람=뒤로, 수면=졸음, 기쁨=점프 등)
import { applyEmotion, softEmotion, playTapMotion, playPetMotion, playCelebrateMotion } from './emotions.js';

export const DEFAULT_MODEL_ID = 'haru';
const FALLBACK_MODEL_URLS = [
  '/assets/models/live2d/haru/Haru.model3.json',
  '/assets/models/live2d/senko/senko.model3.json',
];

const DRAG_THRESHOLD_PX = 8;
const HOLD_MS = 650;
const PET_STROKE_PX = 220;
const HEART_EVERY_STROKES = 1;

// 애니메이션 레이어 우선순위 (높을수록 우선)
const PRIO = { idle: 0, cursor: 1, pet: 2, hold: 3, emotion: 4, motion: 5, script: 6 };

function posKey(modelId) { return `miku_avatar_pos_${modelId || 'default'}`; }
function zoomKey(modelId) { return `miku_avatar_zoom_${modelId || 'default'}`; }
function modelUrlFor(models, id) { return models?.find((m) => m.id === id)?.modelUrl || null; }

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 2.5;

// 부드러운 보간 유틸
function lerp(a, b, t) { return a + (b - a) * Math.min(1, Math.max(0, t)); }
function approach(current, target, speed) {
  const d = target - current;
  if (Math.abs(d) < 0.001) return target;
  return current + d * Math.min(1, speed);
}

export class Live2DStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.model = null;
    this.modelId = null;
    this.modelUrl = null;
    this.availableModels = [];
    this.persistParams = {};
    this.lipVolume = 0;
    this._loading = null;

    // 위치/크기
    this.offsetX = 0;
    this.offsetY = 0;
    this.zoom = 1;
    this.onZoomChange = null;
    this._baseW = 1;
    this._baseH = 1;

    // 커서 트래킹
    this._cursorX = 0;
    this._cursorY = 0;
    this._cursorOnCanvas = false;
    this._trackAngleX = 0;
    this._trackAngleY = 0;
    this._trackTargetX = 0;
    this._trackTargetY = 0;
    this._trackIntensity = 0; // 0~1, 거리에 반비례

    // 유휴 애니메이션
    this._idleTime = 0;
    this._idlePhase = 0;
    this._blinkTimer = 0;
    this._blinkState = 0; // 0=열림, 1=닫는중, 2=열리는중
    this._breathPhase = 0;
    this._swayPhase = 0;
    this._lastInteraction = Date.now();

    // 쓰다듬기
    this._petAcc = 0;
    this._petStrokes = 0;
    this._petIntensity = 0; // 0~1, 점진적 증가
    this._petSwayPhase = 0;
    this._petCursorDx = 0;

    // 파라미터 보간 시스템
    this._paramTarget = {}; // { paramId: { value, prio, decay } }
    this._paramCurrent = {}; // { paramId: currentValue }

    // 인터랙션 상태
    this._press = null;
    this._holdTimer = null;
    this._holdFired = false;

    // 티커
    this._boundTick = this._tick.bind(this);
  }

  // ========== 초기화 ==========

  async init({ modelId = null, modelUrl = null, availableModels = [] } = {}) {
    if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      throw new Error('Live2D 플러그인 로드 실패 (vendor 스크립트 확인)');
    }
    this.availableModels = availableModels || [];

    const { Live2DModel } = PIXI.live2d;
    Live2DModel.registerTicker(PIXI.Ticker);

    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || 400;
    const h = parent?.clientHeight || 400;

    this.app = new PIXI.Application({
      view: this.canvas,
      width: w,
      height: h,
      backgroundAlpha: 0,
      autoStart: true,
      antialias: true,
    });

    const ordered = [];
    const pushUrl = (url, id) => {
      if (url && !ordered.some((o) => o.url === url)) ordered.push({ url, id });
    };
    const explicitUrl = modelUrl || (modelId ? modelUrlFor(this.availableModels, modelId) : null);
    if (explicitUrl) pushUrl(explicitUrl, modelId);
    const defaultUrl = modelUrlFor(this.availableModels, DEFAULT_MODEL_ID) || FALLBACK_MODEL_URLS[0];
    pushUrl(defaultUrl, DEFAULT_MODEL_ID);
    for (const url of FALLBACK_MODEL_URLS) pushUrl(url, null);

    let lastErr = null;
    for (const { url, id } of ordered) {
      try {
        await this._loadIntoStage(url, id);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('모델 로드 실패, 다음 후보 시도:', url, err?.message);
      }
    }
    if (!this.model) {
      throw new Error(`Live2D 모델을 불러오지 못했습니다. (npm run setup 실행 확인) ${lastErr?.message ?? ''}`);
    }

    this._bindInteraction();
    this._startTicker();
    this.setEmotion('neutral');
  }

  async switchModel(modelIdOrUrl, { availableModels } = {}) {
    if (availableModels?.length) this.availableModels = availableModels;
    if (this._loading) await this._loading.catch(() => {});
    const task = this._doSwitch(modelIdOrUrl);
    this._loading = task;
    try { return await task; } finally { if (this._loading === task) this._loading = null; }
  }

  async _doSwitch(modelIdOrUrl) {
    let url = null, id = null;
    if (/^\/|^https?:/.test(modelIdOrUrl || '')) {
      url = modelIdOrUrl;
      id = this.availableModels.find((m) => m.modelUrl === url)?.id || null;
    } else {
      id = modelIdOrUrl;
      url = modelUrlFor(this.availableModels, id) || null;
      if (!url) throw new Error(`알 수 없는 모델입니다: ${id}`);
    }
    if (url === this.modelUrl) return { id: this.modelId, url: this.modelUrl };

    const { Live2DModel } = PIXI.live2d;
    const next = await Live2DModel.from(url, { autoInteract: false });
    this._stopTicker();
    this._detachCurrent();
    this.model = next;
    this.modelUrl = url;
    this.modelId = id;
    this._attachModel();
    this._resetAnimState();
    this._startTicker();
    this.setEmotion('neutral');
    return { id: this.modelId, url: this.modelUrl };
  }

  async _loadIntoStage(url, id) {
    const { Live2DModel } = PIXI.live2d;
    const model = await Live2DModel.from(url, { autoInteract: false });
    this._detachCurrent();
    this.model = model;
    this.modelUrl = url;
    this.modelId = id;
    this._attachModel();
  }

  _attachModel() {
    this._loadOffset();
    this._loadZoom();
    this._baseW = this.model.width || 1;
    this._baseH = this.model.height || 1;
    this.app.stage.addChild(this.model);
    this.model.anchor.set(0.5, 0.5);
    this._fit();
    // 모션 파일의 ParamMouthOpenY 0 덮어쓰기 방지 및 물리 엔진 전달용 (모션 직후)
    this.model.internalModel.on('afterMotionUpdate', () => this._applyLipSync());
    // 최종 렌더 직전 표정 및 립싱크 확정 (렌더 직전)
    this.model.internalModel.on('beforeModelUpdate', () => this._applyModelParams());
  }

  _detachCurrent() {
    if (!this.model) return;
    try { this.app.stage.removeChild(this.model); } catch {}
    try { this.model.destroy({ children: true, texture: true, baseTexture: true }); } catch {
      try { this.model.destroy(); } catch {}
    }
    this.model = null;
  }

  _resetAnimState() {
    this._trackAngleX = 0;
    this._trackAngleY = 0;
    this._trackIntensity = 0;
    this._petIntensity = 0;
    this._petStrokes = 0;
    this._idleTime = 0;
    this._blinkTimer = 2 + Math.random() * 4;
    this._paramTarget = {};
    this._paramCurrent = {};
  }

  // ========== 파라미터 시스템 ==========

  // 안전하게 파라미터 설정 (Cubism 4 / Cubism 2 호환)
  _setParam(id, value) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;
    try { core.setParameterValueById?.(id, value, 1); } catch {}
    try { core.setParamFloat?.(id, value, 1); } catch {}
  }

  // 립싱크 전용: 모션/물리/모델 차이(Haru/Senko/Yinlang)에 영향받지 않고 확실하게 입을 개폐
  _setMouthOpen(val) {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;
    const clamped = Math.max(0, Math.min(1, val));
    // Cubism 4 (ParamMouthOpenY, ParamMouthOpenY2, MouthJawOpen) 및 Cubism 2 (PARAM_MOUTH_OPEN_Y) 동시 반영
    const mouthIds = ['ParamMouthOpenY', 'ParamMouthOpenY2', 'PARAM_MOUTH_OPEN_Y', 'MouthJawOpen'];
    for (const id of mouthIds) {
      try { core.setParameterValueById?.(id, clamped, 1); } catch {}
      try { core.setParamFloat?.(id, clamped, 1); } catch {}
    }
  }

  // 발화 중 및 오디오 볼륨 기반 실시간 입 개폐량 계산
  _computeLipOpen() {
    let open = 0;
    // 1) 오디오 볼륨(RMS) 기반 다이내믹 립싱크
    if (this.lipVolume > 0.008) {
      // 0.008~1.0을 0~1.0의 시원한 개폐 범위로 비선형 증폭 (최대 1.0)
      open = Math.min(1, Math.pow(this.lipVolume, 0.85) * 1.35);
    }

    // 2) 말하고 있는 상태(isSpeaking)일 때:
    // 자음/숨고르기 등으로 볼륨이 순간 낮아져도 최소 음절 개폐 애니메이션 유지 (초당 약 4~6회 발화 리듬)
    if (this.isSpeaking) {
      const t = performance.now();
      const rhythm1 = Math.sin(t * 0.024) * 0.5 + 0.5;
      const rhythm2 = Math.sin(t * 0.039) * 0.25;
      const syllabic = Math.max(0.12, Math.min(0.85, rhythm1 * 0.6 + rhythm2));
      open = Math.max(open, syllabic);
    }
    return open;
  }

  // 모션 직후 적용 (모션 파일의 0 덮어쓰기 무력화 + 물리 연산에 입 열림 전달)
  _applyLipSync() {
    const open = this._computeLipOpen();
    if (open > 0.01 || this.isSpeaking) {
      this._setMouthOpen(open);
    }
  }

  // 보간된 파라미터 설정 (decelayer 없이 즉시)
  _setParamImmediate(id, value, prio = 0) {
    this._paramTarget[id] = { value, prio, decay: 0 };
    this._paramCurrent[id] = value;
    this._setParam(id, value);
  }

  // 보간된 파라미터 설정 (decelayer 적용)
  _setParamSmooth(id, value, prio = 0, speed = 0.12) {
    const cur = this._paramTarget[id];
    if (cur && cur.prio > prio) return; // 더 높은 우선순위가 있으면 무시
    this._paramTarget[id] = { value, prio, decay: 0, speed };
  }

  // 파라미터를 원래대로 감쇠
  _decayParam(id, speed = 0.06) {
    const cur = this._paramTarget[id];
    if (!cur) return;
    cur.decay = speed;
  }

  // ========== 메인 파라미터 적용 (beforeModelUpdate) ==========

  _applyModelParams() {
    const core = this.model?.internalModel?.coreModel;
    if (!core) return;

    // persistParams: 감정 시스템에서 설정한 악센트 파라미터 적용
    // (단, 립싱크 파라미터는 음성/발화 애니메이션이 전담하므로 고정값 덮어쓰기 제외)
    for (const [id, value] of Object.entries(this.persistParams)) {
      if (id === 'ParamMouthOpenY' || id === 'ParamMouthOpenY2' || id === 'PARAM_MOUTH_OPEN_Y') continue;
      try { core.setParameterValueById?.(id, value, 1); } catch {}
      try { core.setParamFloat?.(id, value, 1); } catch {}
    }

    // 최종 립싱크 반영 (말할 때 모션에 입이 굳지 않도록 최우선 보장)
    const open = this._computeLipOpen();
    if (open > 0.01 || this.isSpeaking) {
      this._setMouthOpen(open);
    } else {
      // 발화 중이 아닐 때는 감정별 기본 대기 입 크기
      const base = this.persistParams.ParamMouthOpenY ?? 0.04;
      this._setMouthOpen(base);
    }
  }

  // ========== 티커 (매 프레임 애니메이션) ==========

  _startTicker() {
    if (this.app) this.app.ticker.add(this._boundTick);
  }

  _stopTicker() {
    if (this.app) this.app.ticker.remove(this._boundTick);
  }

  _tick(dt) {
    if (!this.model) return;
    const sec = dt / 60;
    const now = Date.now();

    this._tickCursorTracking(sec);
    this._tickIdle(sec, now);
    this._tickPetting(sec);
    this._tickParamInterpolation(sec);
  }

  // --- 커서 트래킹 ---
  _tickCursorTracking(sec) {
    if (!this._cursorOnCanvas || !this.model) {
      this._trackIntensity = approach(this._trackIntensity, 0, sec * 3);
      if (this._trackIntensity < 0.01) return;
    }

    // 모델 중앙 기준 상대 좌표 (-1 ~ 1 범위로 정규화)
    const cx = this.app.renderer.width / 2 + this.offsetX;
    const cy = this.app.renderer.height / 2 + this.offsetY;
    const dx = this._cursorX - cx;
    const dy = this._cursorY - cy;
    const maxDist = Math.max(this.app.renderer.width, this.app.renderer.height) * 0.5;

    // 거리 기반 강도 (가까울수록 강함)
    const dist = Math.hypot(dx, dy);
    constproximity = Math.max(0, 1 - dist / (maxDist * 0.6));
    this._trackIntensity = approach(this._trackIntensity, proximity, sec * 4);

    // 목표 각도 (커서 방향으로 고개 돌리기, 최대 ±30도)
    const maxAngle = 30;
    this._trackTargetX = Math.max(-maxAngle, Math.min(maxAngle, (dx / maxDist) * maxAngle * 2));
    this._trackTargetY = Math.max(-maxAngle, Math.min(maxAngle, (-dy / maxDist) * maxAngle * 1.5));

    // 부드럽게 보간
    const speed = this._press?.dragging ? 0.18 : 0.08;
    this._trackAngleX = approach(this._trackAngleX, this._trackTargetX * this._trackIntensity, sec * 8 * speed);
    this._trackAngleY = approach(this._trackAngleY, this._trackTargetY * this._trackIntensity, sec * 8 * speed);

    this._setParam('ParamAngleX', this._trackAngleX);
    this._setParam('ParamAngleY', this._trackAngleY);
  }

  // --- 유휴 애니메이션 ---
  _tickIdle(sec, now) {
    const idleMs = now - this._lastInteraction;
    if (idleMs < 2000) return; // 상호작용 후 2초는 유휴 안 함

    this._idleTime += sec;

    // 호흡 (ParamBodyAngleY 미세 변화)
    this._breathPhase += sec * 1.8;
    const breath = Math.sin(this._breathPhase) * 2;
    this._setParamSmooth('ParamBodyAngleY', breath, PRIO.idle, 0.04);

    // 좌우 가벼운 흔들림 (ParamAngleZ)
    this._swayPhase += sec * 0.7;
    const sway = Math.sin(this._swayPhase) * 3 + Math.sin(this._swayPhase * 1.7) * 1.5;
    this._setParamSmooth('ParamAngleZ', sway, PRIO.idle, 0.03);

    // 어깨 움직임 (ParamBodyAngleX)
    const shoulder = Math.sin(this._swayPhase * 0.5) * 2;
    this._setParamSmooth('ParamBodyAngleX', shoulder, PRIO.idle, 0.025);

    // 눈깜빡 (랜덤 간격)
    this._blinkTimer -= sec;
    if (this._blinkTimer <= 0 && this._blinkState === 0) {
      this._blinkState = 1;
      this._blinkTimer = 0.12; // 닫히는 시간
    }
    if (this._blinkState === 1) {
      this._setParamSmooth('ParamEyeLOpen', 0.1, PRIO.idle + 0.5, 0.5);
      this._setParamSmooth('ParamEyeROpen', 0.1, PRIO.idle + 0.5, 0.5);
      if (this._blinkTimer <= 0) {
        this._blinkState = 2;
        this._blinkTimer = 0.1;
      }
    }
    if (this._blinkState === 2) {
      this._setParamSmooth('ParamEyeLOpen', 1, PRIO.idle + 0.5, 0.4);
      this._setParamSmooth('ParamEyeROpen', 1, PRIO.idle + 0.5, 0.4);
      if (this._blinkTimer <= 0) {
        this._blinkState = 0;
        this._blinkTimer = 2 + Math.random() * 5; // 다음 깜빡까지
      }
    }

    // 미세 입 움직임 (말하지 않고 소리가 없을 때만 살짝)
    if (!this.isSpeaking && this.lipVolume <= 0.008) {
      const mouthIdle = 0.04 + Math.sin(this._breathPhase * 0.3) * 0.02;
      this._setParamSmooth('ParamMouthOpenY', mouthIdle, PRIO.idle, 0.03);
    }
  }

  // --- 쓰다듬기 애니메이션 ---
  _tickPetting(sec) {
    if (this._petIntensity <= 0) return;

    // 쓰다듬기 강도 감쇠
    this._petIntensity = approach(this._petIntensity, 0, sec * 0.8);

    // 커서 방향으로 고개 기울이기 (쓰다듬는 방향 추적)
    this._petSwayPhase += sec * 6;
    const petSway = Math.sin(this._petSwayPhase) * 8 * this._petIntensity;
    const petTilt = this._petCursorDx * 12 * this._petIntensity;

    this._setParamSmooth('ParamAngleX', petSway + petTilt, PRIO.pet, 0.15);
    this._setParamSmooth('ParamAngleZ', Math.sin(this._petSwayPhase * 0.7) * 5 * this._petIntensity, PRIO.pet, 0.12);

    // 몸이 커서 방향으로 기울기
    this._setParamSmooth('ParamBodyAngleX', this._petCursorDx * 8 * this._petIntensity, PRIO.pet, 0.1);

    // 뺨 주홍 ( ParamCheek )
    this._setParamSmooth('ParamCheek', 0.4 * this._petIntensity, PRIO.pet, 0.08);

    // 기쁨 표정 (입 벌림 + 눈)
    if (!this.isSpeaking && this.lipVolume <= 0.008) {
      this._setParamSmooth('ParamMouthOpenY', 0.15 + this._petIntensity * 0.1, PRIO.pet, 0.1);
    }
    this._setParamSmooth('ParamMouthForm', 0.3 * this._petIntensity, PRIO.pet, 0.1);
    this._setParamSmooth('ParamEyeLOpen', 0.85 + this._petIntensity * 0.1, PRIO.pet, 0.08);
    this._setParamSmooth('ParamEyeROpen', 0.85 + this._petIntensity * 0.1, PRIO.pet, 0.08);
    this._setParamSmooth('ParamBrowLY', 0.3 * this._petIntensity, PRIO.pet, 0.08);
    this._setParamSmooth('ParamBrowRY', 0.3 * this._petIntensity, PRIO.pet, 0.08);
  }

  // --- 파라미터 보간 (매 프레임) ---
  _tickParamInterpolation(sec) {
    const speakingNow = this.isSpeaking || this.lipVolume > 0.008;
    for (const [id, target] of Object.entries(this._paramTarget)) {
      // 발화 중일 때는 립싱크 엔진이 입 개폐를 전담하므로 모션 보간에서 제외 (모션 중 입 굳음 방지)
      if (speakingNow && (id === 'ParamMouthOpenY' || id === 'ParamMouthOpenY2' || id === 'PARAM_MOUTH_OPEN_Y')) {
        continue;
      }
      if (target.decay > 0) {
        // 감쇠 중: 0으로 수렴
        const cur = this._paramCurrent[id] ?? 0;
        const next = approach(cur, 0, target.decay);
        this._paramCurrent[id] = next;
        this._setParam(id, next);
        if (Math.abs(next) < 0.01) {
          delete this._paramTarget[id];
          delete this._paramCurrent[id];
        }
      } else if (target.speed) {
        // 부드러운 보간
        const cur = this._paramCurrent[id] ?? 0;
        const next = approach(cur, target.value, target.speed);
        this._paramCurrent[id] = next;
        this._setParam(id, next);
      } else {
        // 즉시 적용
        this._paramCurrent[id] = target.value;
        this._setParam(id, target.value);
      }
    }
  }

  // ========== 감정/표정/발화 ==========

  setLipVolume(vol) {
    this.lipVolume = vol;
    this._applyLipSync();
  }

  setSpeaking(speaking) {
    this.isSpeaking = Boolean(speaking);
    if (!this.isSpeaking && this.lipVolume < 0.01) {
      const base = this.persistParams?.ParamMouthOpenY ?? 0.04;
      this._setMouthOpen(base);
    }
  }

  setEmotion(tag) {
    if (!this.model) return;
    this.persistParams = { ...applyEmotion(this.model, tag || 'smile', this.modelId) };
    this._applyModelParams();
    this._lastInteraction = Date.now();
    this.playSituation(tag);
  }

  setEmotionSoft(tag) {
    if (!this.model) return;
    this.persistParams = { ...softEmotion(this.model, tag || 'smile', this.modelId) };
    this._applyModelParams();
    this._lastInteraction = Date.now();
  }

  tap() {
    if (!this.model) return;
    playTapMotion(this.model);
    this._lastInteraction = Date.now();
  }

  // ========== 위치/크기 ==========

  _loadOffset() {
    this.offsetX = 0; this.offsetY = 0;
    try {
      const raw = localStorage.getItem(posKey(this.modelId));
      if (!raw) return;
      const p = JSON.parse(raw);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        this.offsetX = Math.max(-800, Math.min(800, p.x));
        this.offsetY = Math.max(-800, Math.min(800, p.y));
      }
    } catch {}
  }

  _saveOffset() {
    try { localStorage.setItem(posKey(this.modelId), JSON.stringify({ x: this.offsetX, y: this.offsetY })); } catch {}
  }

  _loadZoom() {
    this.zoom = 1;
    try {
      const raw = localStorage.getItem(zoomKey(this.modelId));
      const z = raw == null ? NaN : Number(raw);
      if (Number.isFinite(z)) this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    } catch {}
  }

  _saveZoom() {
    try { localStorage.setItem(zoomKey(this.modelId), String(this.zoom)); } catch {}
  }

  resetPosition() {
    this.offsetX = 0; this.offsetY = 0; this.zoom = 1;
    this._saveOffset(); this._saveZoom(); this._notifyZoom(); this._fit();
  }

  setZoom(z, { save = true } = {}) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(z) || 1));
    if (clamped === this.zoom && this.model) return this.zoom;
    this.zoom = clamped;
    if (save) this._saveZoom();
    this._notifyZoom();
    this._fit();
    return this.zoom;
  }

  getZoom() { return this.zoom; }
  _notifyZoom() { try { this.onZoomChange?.(this.zoom); } catch {} }

  _fit() {
    if (!this.app || !this.model) return;
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    if (w === 0 || h === 0) return;
    const scale = Math.min(w / this._baseW, h / this._baseH) * 0.92 * this.zoom;
    this.model.scale.set(scale);
    this.model.x = w / 2 + this.offsetX;
    this.model.y = h / 2 + this.offsetY;
  }

  // ========== 인터랙션 ==========

  _toLocal(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _pointOnModel(x, y) {
    if (!this.model) return false;
    try {
      const b = this.model.getBounds();
      return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    } catch { return false; }
  }

  _bindInteraction() {
    const canvas = this.canvas;
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';

    // 커서 위치 추적 (항상)
    canvas.addEventListener('pointermove', (e) => {
      const p = this._toLocal(e);
      this._cursorX = p.x;
      this._cursorY = p.y;
      this._cursorOnCanvas = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this._cursorOnCanvas = false;
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.model || (e.button !== undefined && e.button !== 0)) return;
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      const p = this._toLocal(e);
      this._press = {
        id: e.pointerId, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y,
        onModel: this._pointOnModel(p.x, p.y), dragging: false, movedModel: false,
      };
      this._petAcc = 0;
      this._holdFired = false;
      canvas.style.cursor = 'grabbing';
      clearTimeout(this._holdTimer);
      this._holdTimer = setTimeout(() => this._onHold(), HOLD_MS);
      this._lastInteraction = Date.now();
    });

    canvas.addEventListener('pointermove', (e) => {
      const pr = this._press;
      if (!pr || pr.id !== e.pointerId) return;
      const p = this._toLocal(e);
      const dx = p.x - pr.lastX;
      const dy = p.y - pr.lastY;
      pr.lastX = p.x; pr.lastY = p.y;

      if (!pr.dragging && Math.hypot(p.x - pr.startX, p.y - pr.startY) > DRAG_THRESHOLD_PX) {
        pr.dragging = true;
        clearTimeout(this._holdTimer);
      }
      if (!pr.dragging) return;

      if (pr.onModel) {
        this._onPet(dx, dy, p);
      } else {
        const w = this.app.renderer.width;
        const h = this.app.renderer.height;
        this.offsetX = Math.max(-w * 0.6, Math.min(w * 0.6, this.offsetX + dx));
        this.offsetY = Math.max(-h * 0.6, Math.min(h * 0.6, this.offsetY + dy));
        this.model.x = w / 2 + this.offsetX;
        this.model.y = h / 2 + this.offsetY;
        pr.movedModel = true;
      }
      this._lastInteraction = Date.now();
    });

    const up = (e) => {
      const pr = this._press;
      clearTimeout(this._holdTimer);
      canvas.style.cursor = 'grab';
      if (!pr || (e.pointerId !== undefined && pr.id !== e.pointerId)) return;
      this._press = null;
      if (pr.movedModel) this._saveOffset();
      if (!pr.dragging && !this._holdFired) this.tap();
      this._lastInteraction = Date.now();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => {
      clearTimeout(this._holdTimer);
      canvas.style.cursor = 'grab';
      if (this._press?.movedModel) this._saveOffset();
      this._press = null;
    });

    canvas.addEventListener('dblclick', (e) => {
      if (!this.model) return;
      const p = this._toLocal(e);
      this.celebrateAt(p.x, p.y);
    });

    canvas.addEventListener('wheel', (e) => {
      if (!this.model) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });

    let rafId = null;
    const onResize = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const pw = parent.clientWidth;
        const ph = parent.clientHeight;
        if (pw < 10 || ph < 10) return;
        this.app.renderer.resize(pw, ph);
        this._fit();
      });
    };
    window.addEventListener('resize', onResize);
    setTimeout(() => onResize(), 100);
  }

  // ========== 인터랙션 핸들러 ==========

  _onHold() {
    const pr = this._press;
    if (!pr || pr.dragging) return;
    this._holdFired = true;
    if (!pr.onModel || !this.model) return;
    this.holdAt(pr.lastX, pr.lastY);
  }

  _onPet(dx, dy, p) {
    if (!this.model) return;
    this._petAcc += Math.hypot(dx, dy);
    if (this._petAcc < PET_STROKE_PX) return;
    this._petAcc = 0;
    this.petStroke(p.x, p.y, dx);
  }

  // ========== 테스트/외부 API ==========

  getModelInfo() {
    let bounds = null;
    try {
      const b = this.model?.getBounds();
      if (b) bounds = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    } catch {}
    return {
      id: this.modelId, url: this.modelUrl,
      offsetX: Math.round(this.offsetX), offsetY: Math.round(this.offsetY),
      zoom: Math.round(this.zoom * 100) / 100, bounds,
    };
  }

  centerPoint() {
    if (!this.app) return { x: 200, y: 200 };
    return { x: this.app.renderer.width / 2 + this.offsetX, y: this.app.renderer.height / 2 + this.offsetY };
  }

  nudge(dx, dy) {
    if (!this.model) return null;
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    this.offsetX = Math.max(-w * 0.6, Math.min(w * 0.6, this.offsetX + dx));
    this.offsetY = Math.max(-h * 0.6, Math.min(h * 0.6, this.offsetY + dy));
    this.model.x = w / 2 + this.offsetX;
    this.model.y = h / 2 + this.offsetY;
    this._saveOffset();
    return { offsetX: Math.round(this.offsetX), offsetY: Math.round(this.offsetY) };
  }

  // 쓰다듬기 1 스트로크
  petStroke(x, y, cursorDx = 0) {
    if (!this.model) return 0;
    this._petStrokes += 1;
    this._petIntensity = Math.min(1, this._petIntensity + 0.25);
    this._petCursorDx = Math.max(-1, Math.min(1, cursorDx / 20));

    // 점진적 표정 변화 (쓰다듬을수록 강해짐)
    if (this._petStrokes <= 3) {
      this.setEmotionSoft('smile');
    } else if (this._petStrokes <= 8) {
      this.setEmotionSoft('love');
    } else {
      this.setEmotionSoft('cheer');
    }

    // 3스트로크마다 모션
    if (this._petStrokes % 3 === 0) playPetMotion(this.model, this.modelId);
    // 하트
    if (this._petStrokes % HEART_EVERY_STROKES === 0) this._spawnHearts(x, y, 1);
    if (this._petStrokes > 1000) this._petStrokes = 0;
    this._lastInteraction = Date.now();
    return this._petStrokes;
  }

  petAt(x, y, strokes = 3) {
    let n = 0;
    for (let i = 0; i < strokes; i++) {
      n = this.petStroke(x + (Math.random() * 40 - 20), y + (Math.random() * 24 - 12), Math.random() * 20 - 10);
    }
    return n;
  }

  holdAt(x, y) {
    if (!this.model) return false;
    this.setEmotion('love');
    this._petIntensity = 0.8;
    this._petCursorDx = 0;
    this._spawnHearts(x, y, 3);
    // 홀딩 시 강한 반응
    this._setParamSmooth('ParamAngleZ', -5, PRIO.hold, 0.12);
    this._setParamSmooth('ParamBodyAngleY', -3, PRIO.hold, 0.1);
    this._lastInteraction = Date.now();
    return true;
  }

  celebrateAt(x, y) {
    if (!this.model) return false;
    this.setEmotion('cheer');
    playCelebrateMotion(this.model, this.modelId);
    this._spawnHearts(x, y, 5);
    // 축하 바운스
    this._setParamSmooth('ParamBodyAngleY', -6, PRIO.motion, 0.15);
    setTimeout(() => this._setParamSmooth('ParamBodyAngleY', 0, PRIO.motion - 1, 0.08), 300);
    this._lastInteraction = Date.now();
    return true;
  }

  heartAt(x, y, n = 1) {
    this._spawnHearts(x, y, n);
    return true;
  }

  motionGroups() {
    try {
      const defs = this.model?.internalModel?.motionManager?.definitions;
      if (!defs) return {};
      return Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v?.length ?? 0]));
    } catch { return {}; }
  }

  async motionTest(group, index) {
    if (!this.model) return false;
    try { return await this.model.motion(group, index ?? undefined); } catch { return false; }
  }

  async expressionTest(id) {
    if (!this.model) return false;
    try { return await this.model.expression(id); } catch { return false; }
  }

  // ========== 상황별 모션 (파라미터 기반) ==========

  // 설명/강의 중: 고개 끄덕임 + 손 제스처
  playExplain() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    // 고개 끄덕임 (3회)
    let delay = 0;
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this._setParamSmooth('ParamAngleY', -8, PRIO.script, 0.18);
        setTimeout(() => this._setParamSmooth('ParamAngleY', 3, PRIO.script, 0.12), 180);
        setTimeout(() => this._setParamSmooth('ParamAngleY', 0, PRIO.script - 1, 0.1), 360);
      }, delay);
      delay += 600;
    }
    // 몸 기울이기 (설명 포즈)
    this._setParamSmooth('ParamBodyAngleX', -4, PRIO.script, 0.06);
    setTimeout(() => this._setParamSmooth('ParamBodyAngleX', 0, PRIO.script - 1, 0.04), 2000);
    this.setEmotionSoft('think');
  }

  // 놀람: 눈 커지고 고개 뒤로
  playSurprise() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('cheer');
    this._setParamSmooth('ParamEyeLOpen', 1.2, PRIO.script, 0.3);
    this._setParamSmooth('ParamEyeROpen', 1.2, PRIO.script, 0.3);
    this._setParamSmooth('ParamAngleY', -12, PRIO.script, 0.25);
    this._setParamSmooth('ParamMouthOpenY', 0.3, PRIO.script, 0.2);
    this._setParamSmooth('ParamBrowLY', 0.6, PRIO.script, 0.2);
    this._setParamSmooth('ParamBrowRY', 0.6, PRIO.script, 0.2);
    // 원위리
    setTimeout(() => {
      this._decayParam('ParamEyeLOpen', 0.08);
      this._decayParam('ParamEyeROpen', 0.08);
      this._decayParam('ParamAngleY', 0.06);
      this._decayParam('ParamMouthOpenY', 0.06);
      this._decayParam('ParamBrowLY', 0.06);
      this._decayParam('ParamBrowRY', 0.06);
    }, 1200);
  }

  // 생각/고민: 고개 기울임 + 눈 좁힘
  playThink() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('think');
    this._setParamSmooth('ParamAngleZ', -8, PRIO.script, 0.08);
    this._setParamSmooth('ParamAngleX', 5, PRIO.script, 0.06);
    this._setParamSmooth('ParamEyeLOpen', 0.7, PRIO.script, 0.08);
    this._setParamSmooth('ParamEyeROpen', 0.7, PRIO.script, 0.08);
    this._setParamSmooth('ParamBrowLY', -0.3, PRIO.script, 0.08);
    this._setParamSmooth('ParamBrowRY', -0.3, PRIO.script, 0.08);
    this._setParamSmooth('ParamMouthForm', -0.2, PRIO.script, 0.06);
    // 3초 후 원위리
    setTimeout(() => {
      this._decayParam('ParamAngleZ', 0.05);
      this._decayParam('ParamAngleX', 0.05);
      this._decayParam('ParamEyeLOpen', 0.05);
      this._decayParam('ParamEyeROpen', 0.05);
      this._decayParam('ParamBrowLY', 0.05);
      this._decayParam('ParamBrowRY', 0.05);
      this._decayParam('ParamMouthForm', 0.05);
    }, 3000);
  }

  // 기쁨/환희: 점프 + 미소
  playJoy() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotion('cheer');
    // 바운스
    const bounce = () => {
      this._setParamSmooth('ParamBodyAngleY', -10, PRIO.script, 0.25);
      setTimeout(() => this._setParamSmooth('ParamBodyAngleY', 4, PRIO.script, 0.15), 200);
      setTimeout(() => this._setParamSmooth('ParamBodyAngleY', 0, PRIO.script - 1, 0.1), 400);
    };
    bounce();
    setTimeout(bounce, 700);
    setTimeout(bounce, 1400);
    // 팔 벌리기
    this._setParamSmooth('ParamBodyAngleX', -6, PRIO.script, 0.12);
    setTimeout(() => this._setParamSmooth('ParamBodyAngleX', 6, PRIO.script, 0.12), 350);
    setTimeout(() => this._setParamSmooth('ParamBodyAngleX', 0, PRIO.script - 1, 0.08), 700);
    this._spawnHearts(this.centerPoint().x, this.centerPoint().y - 60, 4);
  }

  // 슬픔: 고개 숙임 + 눈 감기
  playSad() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('sad');
    this._setParamSmooth('ParamAngleY', 10, PRIO.script, 0.06);
    this._setParamSmooth('ParamAngleZ', 5, PRIO.script, 0.05);
    this._setParamSmooth('ParamEyeLOpen', 0.4, PRIO.script, 0.06);
    this._setParamSmooth('ParamEyeROpen', 0.4, PRIO.script, 0.06);
    this._setParamSmooth('ParamBrowLY', -0.5, PRIO.script, 0.06);
    this._setParamSmooth('ParamBrowRY', -0.5, PRIO.script, 0.06);
    this._setParamSmooth('ParamBodyAngleY', 5, PRIO.script, 0.04);
    // 4초 후 원위리
    setTimeout(() => {
      this._decayParam('ParamAngleY', 0.04);
      this._decayParam('ParamAngleZ', 0.04);
      this._decayParam('ParamEyeLOpen', 0.04);
      this._decayParam('ParamEyeROpen', 0.04);
      this._decayParam('ParamBrowLY', 0.04);
      this._decayParam('ParamBrowRY', 0.04);
      this._decayParam('ParamBodyAngleY', 0.03);
    }, 4000);
  }

  // 화남: 주먹潖 + 고개 떨림
  playAngry() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('think'); // 눈썹 찡그림
    this._setParamSmooth('ParamBrowLY', -0.7, PRIO.script, 0.2);
    this._setParamSmooth('ParamBrowRY', -0.7, PRIO.script, 0.2);
    this._setParamSmooth('ParamMouthForm', -0.4, PRIO.script, 0.15);
    this._setParamSmooth('ParamAngleZ', -4, PRIO.script, 0.15);
    // 떨림
    let shakeCount = 0;
    const shake = () => {
      if (shakeCount >= 8) {
        this._decayParam('ParamAngleZ', 0.08);
        this._decayParam('ParamBrowLY', 0.05);
        this._decayParam('ParamBrowRY', 0.05);
        this._decayParam('ParamMouthForm', 0.05);
        return;
      }
      this._setParam('ParamAngleZ', (shakeCount % 2 === 0 ? -6 : 2));
      shakeCount++;
      setTimeout(shake, 100);
    };
    shake();
  }

  // 졸음/수면: 고개 떨어짐 + 눈 감김
  playSleepy() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('neutral');
    this._setParamSmooth('ParamAngleY', 15, PRIO.script, 0.03);
    this._setParamSmooth('ParamAngleZ', 8, PRIO.script, 0.03);
    this._setParamSmooth('ParamEyeLOpen', 0.15, PRIO.script, 0.04);
    this._setParamSmooth('ParamEyeROpen', 0.15, PRIO.script, 0.04);
    this._setParamSmooth('ParamBodyAngleY', 8, PRIO.script, 0.03);
    this._setParamSmooth('ParamMouthOpenY', 0.08, PRIO.script, 0.03);
    // 코골이 효과 (ParamMouthOpenY 둥글게)
    this._breathPhase = 0;
  }

  // 깨어남: 기지개
  playWakeUp() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    // 빠르게 깨어나기
    this._decayParam('ParamAngleY', 0.15);
    this._decayParam('ParamAngleZ', 0.15);
    this._decayParam('ParamEyeLOpen', 0.2);
    this._decayParam('ParamEyeROpen', 0.2);
    this._decayParam('ParamBodyAngleY', 0.12);
    this._decayParam('ParamMouthOpenY', 0.1);
    // 기지개 (팔 stretche)
    setTimeout(() => {
      this._setParamSmooth('ParamBodyAngleY', -8, PRIO.script, 0.1);
      this._setParamSmooth('ParamAngleY', -5, PRIO.script, 0.12);
      this._setParamSmooth('ParamEyeLOpen', 1.1, PRIO.script, 0.15);
      this._setParamSmooth('ParamEyeROpen', 1.1, PRIO.script, 0.15);
    }, 500);
    setTimeout(() => {
      this._decayParam('ParamBodyAngleY', 0.08);
      this._decayParam('ParamAngleY', 0.08);
      this._decayParam('ParamEyeLOpen', 0.08);
      this._decayParam('ParamEyeROpen', 0.08);
      this.setEmotionSoft('smile');
    }, 1500);
  }

  // 인사: 고개 숙임
  playGreet() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('smile');
    this._setParamSmooth('ParamAngleY', 12, PRIO.script, 0.15);
    this._setParamSmooth('ParamBodyAngleY', 6, PRIO.script, 0.1);
    setTimeout(() => {
      this._decayParam('ParamAngleY', 0.08);
      this._decayParam('ParamBodyAngleY', 0.06);
    }, 1000);
  }

  // 흔들기(거절): 고개 좌우
  playShake() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('think');
    let count = 0;
    const swing = () => {
      if (count >= 6) {
        this._decayParam('ParamAngleX', 0.1);
        return;
      }
      this._setParam('ParamAngleX', count % 2 === 0 ? -15 : 15);
      count++;
      setTimeout(swing, 150);
    };
    swing();
  }

  // 맞장구(동의): 고개 끄덕임
  playNod() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('smile');
    let count = 0;
    const nod = () => {
      if (count >= 4) {
        this._decayParam('ParamAngleY', 0.1);
        return;
      }
      this._setParam('ParamAngleY', count % 2 === 0 ? -8 : 3);
      count++;
      setTimeout(nod, 200);
    };
    nod();
  }

  // 손 흔들기 인사
  playWave() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('cheer');
    this._setParamSmooth('ParamBodyAngleX', -8, PRIO.script, 0.12);
    let count = 0;
    const wave = () => {
      if (count >= 8) {
        this._decayParam('ParamBodyAngleX', 0.08);
        return;
      }
      this._setParam('ParamAngleZ', count % 2 === 0 ? -6 : 6);
      count++;
      setTimeout(wave, 180);
    };
    wave();
  }

  // 박수
  playClap() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('cheer');
    let count = 0;
    const clap = () => {
      if (count >= 6) {
        this._decayParam('ParamBodyAngleX', 0.08);
        return;
      }
      this._setParam('ParamBodyAngleX', count % 2 === 0 ? -5 : 5);
      this._setParam('ParamMouthOpenY', 0.2);
      count++;
      setTimeout(clap, 250);
    };
    clap();
  }

  // 춤: 리듬 있는 동작
  playDance() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotion('cheer');
    const beats = [
      { ax: -10, ay: -5, az: -8, body: -6, t: 0 },
      { ax: 8, ay: 3, az: 6, body: 5, t: 300 },
      { ax: -6, ay: -8, az: -4, body: -4, t: 600 },
      { ax: 10, ay: 5, az: 8, body: 6, t: 900 },
      { ax: -8, ay: 3, az: -6, body: -5, t: 1200 },
      { ax: 6, ay: -5, az: 4, body: 4, t: 1500 },
      { ax: -10, ay: -3, az: -8, body: -6, t: 1800 },
      { ax: 8, ay: 8, az: 6, body: 5, t: 2100 },
    ];
    for (const b of beats) {
      setTimeout(() => {
        this._setParamSmooth('ParamAngleX', b.ax, PRIO.script, 0.2);
        this._setParamSmooth('ParamAngleY', b.ay, PRIO.script, 0.18);
        this._setParamSmooth('ParamAngleZ', b.az, PRIO.script, 0.16);
        this._setParamSmooth('ParamBodyAngleX', b.body, PRIO.script, 0.14);
        this._setParamSmooth('ParamMouthOpenY', 0.15, PRIO.script, 0.15);
      }, b.t);
    }
    setTimeout(() => {
      ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamMouthOpenY']
        .forEach((p) => this._decayParam(p, 0.06));
    }, 2500);
  }

  // 열공/집중: 진지한 눈매, 앞으로 살짝 기울여 집중
  playFocus() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('focus');
    this._setParamSmooth('ParamAngleY', 5, PRIO.script, 0.1);
    this._setParamSmooth('ParamBodyAngleY', -5, PRIO.script, 0.08);
    this._setParamSmooth('ParamEyeLOpen', 0.88, PRIO.script, 0.12);
    this._setParamSmooth('ParamEyeROpen', 0.88, PRIO.script, 0.12);
    this._setParamSmooth('ParamBrowLY', -0.25, PRIO.script, 0.1);
    this._setParamSmooth('ParamBrowRY', -0.25, PRIO.script, 0.1);
    this._setParamSmooth('ParamMouthForm', 0.1, PRIO.script, 0.08);
    this._setParamSmooth('ParamMouthOpenY', 0.02, PRIO.script, 0.08);
    setTimeout(() => {
      this._decayParam('ParamAngleY', 0.05);
      this._decayParam('ParamBodyAngleY', 0.05);
      this._decayParam('ParamEyeLOpen', 0.06);
      this._decayParam('ParamEyeROpen', 0.06);
      this._decayParam('ParamBrowLY', 0.05);
      this._decayParam('ParamBrowRY', 0.05);
      this._decayParam('ParamMouthForm', 0.05);
    }, 2500);
  }

  // 뿌듯/자신감: 가슴 펴고 고개 으쓱, "나한테 맡겨!"
  playProud() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('proud');
    this._setParamSmooth('ParamBodyAngleY', -7, PRIO.script, 0.14);
    this._setParamSmooth('ParamBodyAngleX', 4, PRIO.script, 0.1);
    this._setParamSmooth('ParamAngleY', -8, PRIO.script, 0.12);
    this._setParamSmooth('ParamAngleZ', -7, PRIO.script, 0.12);
    this._setParamSmooth('ParamAngleX', 6, PRIO.script, 0.1);
    this._setParamSmooth('ParamBrowLY', 0.35, PRIO.script, 0.12);
    this._setParamSmooth('ParamBrowRY', 0.35, PRIO.script, 0.12);
    this._setParamSmooth('ParamMouthForm', 0.6, PRIO.script, 0.15);
    this._setParamSmooth('ParamMouthOpenY', 0.12, PRIO.script, 0.1);
    this._spawnHearts(this.centerPoint().x + 30, this.centerPoint().y - 50, 1);
    setTimeout(() => {
      this._decayParam('ParamBodyAngleY', 0.06);
      this._decayParam('ParamBodyAngleX', 0.05);
      this._decayParam('ParamAngleY', 0.06);
      this._decayParam('ParamAngleZ', 0.05);
      this._decayParam('ParamAngleX', 0.05);
      this._decayParam('ParamBrowLY', 0.05);
      this._decayParam('ParamBrowRY', 0.05);
      this._decayParam('ParamMouthForm', 0.05);
    }, 2200);
  }

  // 응원/파이팅: 힘찬 2단 도약 바운스 + 미소 + 하트
  playFighting() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotion('cheer');
    // 1단 바운스
    this._setParamSmooth('ParamBodyAngleY', -8, PRIO.script, 0.25);
    this._setParamSmooth('ParamEyeLOpen', 1.15, PRIO.script, 0.2);
    this._setParamSmooth('ParamEyeROpen', 1.15, PRIO.script, 0.2);
    this._setParamSmooth('ParamCheek', 0.35, PRIO.script, 0.15);
    setTimeout(() => {
      this._setParamSmooth('ParamBodyAngleY', 2, PRIO.script, 0.15);
    }, 180);
    // 2단 더 큰 바운스
    setTimeout(() => {
      this._setParamSmooth('ParamBodyAngleY', -14, PRIO.script, 0.28);
      this._setParamSmooth('ParamMouthOpenY', 0.28, PRIO.script, 0.2);
      this._setParamSmooth('ParamMouthForm', 0.5, PRIO.script, 0.2);
      this._setParamSmooth('ParamAngleY', -6, PRIO.script, 0.15);
      this._spawnHearts(this.centerPoint().x, this.centerPoint().y - 60, 3);
    }, 380);
    setTimeout(() => {
      this._setParamSmooth('ParamBodyAngleY', 4, PRIO.script, 0.12);
    }, 620);
    setTimeout(() => {
      this._decayParam('ParamBodyAngleY', 0.08);
      this._decayParam('ParamAngleY', 0.06);
      this._decayParam('ParamEyeLOpen', 0.06);
      this._decayParam('ParamEyeROpen', 0.06);
      this._decayParam('ParamCheek', 0.05);
      this._decayParam('ParamMouthOpenY', 0.08);
      this._decayParam('ParamMouthForm', 0.06);
    }, 1200);
  }

  // 부끄/수줍음: 볼 붉히며 시선 피하기
  playShy() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('shy');
    this._setParamSmooth('ParamCheek', 0.65, PRIO.script, 0.15);
    this._setParamSmooth('ParamAngleX', 18, PRIO.script, 0.08);
    this._setParamSmooth('ParamAngleY', 10, PRIO.script, 0.08);
    this._setParamSmooth('ParamAngleZ', -6, PRIO.script, 0.08);
    this._setParamSmooth('ParamBodyAngleX', 5, PRIO.script, 0.06);
    this._setParamSmooth('ParamEyeLOpen', 0.55, PRIO.script, 0.08);
    this._setParamSmooth('ParamEyeROpen', 0.55, PRIO.script, 0.08);
    this._setParamSmooth('ParamMouthForm', 0.25, PRIO.script, 0.08);
    this._setParamSmooth('ParamMouthOpenY', 0.06, PRIO.script, 0.08);
    this._spawnHearts(this.centerPoint().x + 25, this.centerPoint().y - 20, 2);
    setTimeout(() => {
      this._decayParam('ParamAngleX', 0.04);
      this._decayParam('ParamAngleY', 0.04);
      this._decayParam('ParamAngleZ', 0.04);
      this._decayParam('ParamBodyAngleX', 0.04);
      this._decayParam('ParamEyeLOpen', 0.05);
      this._decayParam('ParamEyeROpen', 0.05);
      this._decayParam('ParamCheek', 0.03);
    }, 2800);
  }

  // 당황/멘붕: 눈 커지고 좌우로 안절부절 지그재그 진동
  playPanic() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('panic');
    this._setParamSmooth('ParamEyeLOpen', 1.3, PRIO.script, 0.3);
    this._setParamSmooth('ParamEyeROpen', 1.3, PRIO.script, 0.3);
    this._setParamSmooth('ParamBrowLY', 0.7, PRIO.script, 0.25);
    this._setParamSmooth('ParamBrowRY', 0.7, PRIO.script, 0.25);
    this._setParamSmooth('ParamMouthOpenY', 0.32, PRIO.script, 0.2);
    this._setParamSmooth('ParamMouthForm', -0.3, PRIO.script, 0.15);

    let shake = 0;
    const interval = 80;
    const timer = setInterval(() => {
      shake++;
      if (shake > 10) {
        clearInterval(timer);
        this._decayParam('ParamAngleX', 0.08);
        this._decayParam('ParamAngleZ', 0.08);
        this._decayParam('ParamEyeLOpen', 0.06);
        this._decayParam('ParamEyeROpen', 0.06);
        this._decayParam('ParamBrowLY', 0.06);
        this._decayParam('ParamBrowRY', 0.06);
        this._decayParam('ParamMouthOpenY', 0.06);
        return;
      }
      const dir = shake % 2 === 0 ? 1 : -1;
      this._setParam('ParamAngleX', dir * 14);
      this._setParam('ParamAngleZ', dir * 8);
    }, interval);
  }

  // 갸우뚱/호기심: 고개 크게 갸우뚱 + 동그란 눈
  playCurious() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('curious');
    this._setParamSmooth('ParamAngleZ', 15, PRIO.script, 0.12);
    this._setParamSmooth('ParamAngleX', -9, PRIO.script, 0.1);
    this._setParamSmooth('ParamAngleY', -3, PRIO.script, 0.08);
    this._setParamSmooth('ParamEyeLOpen', 1.08, PRIO.script, 0.1);
    this._setParamSmooth('ParamEyeROpen', 0.95, PRIO.script, 0.1);
    this._setParamSmooth('ParamBrowLY', 0.25, PRIO.script, 0.1);
    this._setParamSmooth('ParamBrowRY', -0.15, PRIO.script, 0.1);
    this._setParamSmooth('ParamMouthOpenY', 0.12, PRIO.script, 0.1);
    this._setParamSmooth('ParamMouthForm', 0.15, PRIO.script, 0.1);
    setTimeout(() => {
      this._decayParam('ParamAngleZ', 0.05);
      this._decayParam('ParamAngleX', 0.05);
      this._decayParam('ParamAngleY', 0.05);
      this._decayParam('ParamEyeLOpen', 0.05);
      this._decayParam('ParamEyeROpen', 0.05);
      this._decayParam('ParamBrowLY', 0.05);
      this._decayParam('ParamBrowRY', 0.05);
      this._decayParam('ParamMouthOpenY', 0.05);
    }, 2600);
  }

  // 꾸벅꾸벅/졸림 참기: 고개 푹 떨어지다 화들짝 깨기
  playDozeOff() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('dozeoff');
    // 1단계: 천천히 꾸벅
    this._setParamSmooth('ParamAngleY', 18, PRIO.script, 0.03);
    this._setParamSmooth('ParamBodyAngleY', 7, PRIO.script, 0.025);
    this._setParamSmooth('ParamEyeLOpen', 0.08, PRIO.script, 0.03);
    this._setParamSmooth('ParamEyeROpen', 0.08, PRIO.script, 0.03);
    // 2단계: 깜짝 놀라며 번쩍 고개 들기!
    setTimeout(() => {
      this._setParamSmooth('ParamAngleY', -12, PRIO.script, 0.35);
      this._setParamSmooth('ParamBodyAngleY', -4, PRIO.script, 0.25);
      this._setParamSmooth('ParamEyeLOpen', 1.2, PRIO.script, 0.3);
      this._setParamSmooth('ParamEyeROpen', 1.2, PRIO.script, 0.3);
      this._setParamSmooth('ParamBrowLY', 0.4, PRIO.script, 0.25);
      this._setParamSmooth('ParamBrowRY', 0.4, PRIO.script, 0.25);
    }, 1300);
    // 3단계: 겸연쩍은 미소
    setTimeout(() => {
      this._setParamSmooth('ParamMouthForm', 0.25, PRIO.script, 0.1);
      this._setParamSmooth('ParamEyeLOpen', 0.9, PRIO.script, 0.08);
      this._setParamSmooth('ParamEyeROpen', 0.9, PRIO.script, 0.08);
      this._decayParam('ParamAngleY', 0.06);
      this._decayParam('ParamBodyAngleY', 0.05);
      this._decayParam('ParamBrowLY', 0.05);
      this._decayParam('ParamBrowRY', 0.05);
    }, 1800);
    setTimeout(() => {
      this._decayParam('ParamMouthForm', 0.05);
    }, 2800);
  }

  // 안도/다행/휴~: 한숨 쉬며 어깨 긴장 풀기
  playRelieved() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('relieved');
    // 숨 들이쉬기
    this._setParamSmooth('ParamAngleY', -6, PRIO.script, 0.08);
    this._setParamSmooth('ParamBodyAngleY', -4, PRIO.script, 0.08);
    // 내쉬며 긴장 풀기
    setTimeout(() => {
      this._setParamSmooth('ParamAngleY', 9, PRIO.script, 0.07);
      this._setParamSmooth('ParamBodyAngleY', 5, PRIO.script, 0.06);
      this._setParamSmooth('ParamEyeLOpen', 0.25, PRIO.script, 0.08);
      this._setParamSmooth('ParamEyeROpen', 0.25, PRIO.script, 0.08);
      this._setParamSmooth('ParamMouthOpenY', 0.15, PRIO.script, 0.08);
    }, 500);
    // 편안한 미소로 복귀
    setTimeout(() => {
      this._setParamSmooth('ParamEyeLOpen', 0.85, PRIO.script, 0.08);
      this._setParamSmooth('ParamEyeROpen', 0.85, PRIO.script, 0.08);
      this._setParamSmooth('ParamMouthForm', 0.4, PRIO.script, 0.1);
      this._setParamSmooth('ParamMouthOpenY', 0.04, PRIO.script, 0.08);
      this._decayParam('ParamAngleY', 0.05);
      this._decayParam('ParamBodyAngleY', 0.04);
    }, 1300);
    setTimeout(() => {
      this._decayParam('ParamMouthForm', 0.05);
    }, 2600);
  }

  // 삐짐/뾰로통: 고개 홱 돌리고 뾰로통한 입
  playPout() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('pout');
    this._setParamSmooth('ParamAngleX', -24, PRIO.script, 0.2);
    this._setParamSmooth('ParamAngleZ', -7, PRIO.script, 0.15);
    this._setParamSmooth('ParamBodyAngleX', -10, PRIO.script, 0.12);
    this._setParamSmooth('ParamMouthForm', -0.5, PRIO.script, 0.15);
    this._setParamSmooth('ParamMouthOpenY', 0.04, PRIO.script, 0.1);
    this._setParamSmooth('ParamBrowLY', -0.35, PRIO.script, 0.15);
    this._setParamSmooth('ParamBrowRY', -0.35, PRIO.script, 0.15);
    this._setParamSmooth('ParamEyeLOpen', 0.65, PRIO.script, 0.1);
    this._setParamSmooth('ParamEyeROpen', 0.65, PRIO.script, 0.1);
    this._setParamSmooth('ParamCheek', 0.25, PRIO.script, 0.08);
    setTimeout(() => {
      this._decayParam('ParamAngleX', 0.04);
      this._decayParam('ParamAngleZ', 0.04);
      this._decayParam('ParamBodyAngleX', 0.03);
      this._decayParam('ParamMouthForm', 0.04);
      this._decayParam('ParamBrowLY', 0.04);
      this._decayParam('ParamBrowRY', 0.04);
      this._decayParam('ParamEyeLOpen', 0.05);
      this._decayParam('ParamEyeROpen', 0.05);
      this._decayParam('ParamCheek', 0.03);
    }, 3000);
  }

  // 속닥속닥/비밀: 앞으로 쑥 다가와 귓속말 포즈
  playWhisper() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('whisper');
    this._setParamSmooth('ParamBodyAngleY', -9, PRIO.script, 0.1);
    this._setParamSmooth('ParamAngleY', 6, PRIO.script, 0.1);
    this._setParamSmooth('ParamAngleZ', -11, PRIO.script, 0.12);
    this._setParamSmooth('ParamAngleX', 13, PRIO.script, 0.1);
    this._setParamSmooth('ParamEyeLOpen', 0.85, PRIO.script, 0.1);
    this._setParamSmooth('ParamEyeROpen', 0.1, PRIO.script, 0.15); // 윙크
    this._setParamSmooth('ParamMouthOpenY', 0.09, PRIO.script, 0.08);
    this._setParamSmooth('ParamMouthForm', 0.35, PRIO.script, 0.08);
    setTimeout(() => {
      this._decayParam('ParamBodyAngleY', 0.05);
      this._decayParam('ParamAngleY', 0.05);
      this._decayParam('ParamAngleZ', 0.05);
      this._decayParam('ParamAngleX', 0.05);
      this._decayParam('ParamEyeLOpen', 0.06);
      this._decayParam('ParamEyeROpen', 0.06);
      this._decayParam('ParamMouthOpenY', 0.05);
      this._decayParam('ParamMouthForm', 0.05);
    }, 2600);
  }

  // 초롱초롱/기대: 눈 번쩍 + 살랑살랑 바운스 + 하트 4개
  playSparkle() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('sparkle');
    this._setParamSmooth('ParamEyeLOpen', 1.25, PRIO.script, 0.25);
    this._setParamSmooth('ParamEyeROpen', 1.25, PRIO.script, 0.25);
    this._setParamSmooth('ParamBrowLY', 0.5, PRIO.script, 0.2);
    this._setParamSmooth('ParamBrowRY', 0.5, PRIO.script, 0.2);
    this._setParamSmooth('ParamCheek', 0.45, PRIO.script, 0.15);
    this._setParamSmooth('ParamMouthForm', 0.6, PRIO.script, 0.2);
    this._setParamSmooth('ParamMouthOpenY', 0.22, PRIO.script, 0.18);
    this._setParamSmooth('ParamBodyAngleY', -5, PRIO.script, 0.12);

    // 살랑살랑
    let sway = 0;
    const sTimer = setInterval(() => {
      sway++;
      if (sway > 8) {
        clearInterval(sTimer);
        this._decayParam('ParamAngleZ', 0.06);
        this._decayParam('ParamEyeLOpen', 0.06);
        this._decayParam('ParamEyeROpen', 0.06);
        this._decayParam('ParamBrowLY', 0.05);
        this._decayParam('ParamBrowRY', 0.05);
        this._decayParam('ParamCheek', 0.03);
        this._decayParam('ParamMouthForm', 0.05);
        this._decayParam('ParamMouthOpenY', 0.06);
        this._decayParam('ParamBodyAngleY', 0.05);
        return;
      }
      this._setParam('ParamAngleZ', sway % 2 === 0 ? -7 : 7);
    }, 180);

    const cp = this.centerPoint();
    this._spawnHearts(cp.x - 20, cp.y - 50, 2);
    setTimeout(() => this._spawnHearts(cp.x + 20, cp.y - 60, 2), 400);
  }

  // 멍때리기/영혼 가출: 초점 풀린 눈으로 멍하니 정지
  playSpaceOut() {
    if (!this.model) return;
    this._lastInteraction = Date.now();
    this.setEmotionSoft('spaceout');
    this._setParamSmooth('ParamAngleY', -8, PRIO.script, 0.04);
    this._setParamSmooth('ParamAngleZ', 4, PRIO.script, 0.04);
    this._setParamSmooth('ParamBodyAngleY', 3, PRIO.script, 0.03);
    this._setParamSmooth('ParamEyeLOpen', 0.42, PRIO.script, 0.05);
    this._setParamSmooth('ParamEyeROpen', 0.42, PRIO.script, 0.05);
    this._setParamSmooth('ParamBrowLY', 0, PRIO.script, 0.05);
    this._setParamSmooth('ParamBrowRY', 0, PRIO.script, 0.05);
    this._setParamSmooth('ParamMouthOpenY', 0.12, PRIO.script, 0.04);
    this._setParamSmooth('ParamMouthForm', 0, PRIO.script, 0.04);
    setTimeout(() => {
      this._decayParam('ParamAngleY', 0.04);
      this._decayParam('ParamAngleZ', 0.04);
      this._decayParam('ParamBodyAngleY', 0.04);
      this._decayParam('ParamEyeLOpen', 0.06);
      this._decayParam('ParamEyeROpen', 0.06);
      this._decayParam('ParamMouthOpenY', 0.05);
    }, 3500);
  }

  // 상황별 모션 통합 디스패처 (이름으로 직접 실행)
  playSituation(name) {
    if (!name || !this.model) return false;
    const map = {
      nod: () => this.playNod(),
      think: () => this.playThink(),
      surprise: () => this.playSurprise(),
      joy: () => this.playJoy(),
      sad: () => this.playSad(),
      angry: () => this.playAngry(),
      sleepy: () => this.playSleepy(),
      wakeup: () => this.playWakeUp(),
      greet: () => this.playGreet(),
      shake: () => this.playShake(),
      wave: () => this.playWave(),
      clap: () => this.playClap(),
      dance: () => this.playDance(),
      explain: () => this.playExplain(),
      focus: () => this.playFocus(),
      proud: () => this.playProud(),
      fighting: () => this.playFighting(),
      shy: () => this.playShy(),
      panic: () => this.playPanic(),
      curious: () => this.playCurious(),
      dozeoff: () => this.playDozeOff(),
      relieved: () => this.playRelieved(),
      pout: () => this.playPout(),
      whisper: () => this.playWhisper(),
      sparkle: () => this.playSparkle(),
      spaceout: () => this.playSpaceOut(),
    };
    const fn = map[String(name).toLowerCase()];
    if (fn) {
      fn();
      return true;
    }
    return false;
  }

  // 하트 표시
  _spawnHearts(x, y, count = 1) {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const marks = ['💗', '💖', '💕', '✨', '💙'];
    for (let i = 0; i < count; i++) {
      if (parent.querySelectorAll('.float-heart').length > 30) return;
      const el = document.createElement('div');
      el.className = 'float-heart';
      el.textContent = marks[Math.floor(Math.random() * marks.length)];
      el.style.left = `${x + (Math.random() * 56 - 28)}px`;
      el.style.top = `${y + (Math.random() * 20 - 10)}px`;
      el.style.fontSize = `${16 + Math.random() * 14}px`;
      el.addEventListener('animationend', () => el.remove());
      setTimeout(() => el.remove(), 2200);
      parent.appendChild(el);
    }
  }
}

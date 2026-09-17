// 감정 태그 → 아바타 모션/파라미터 매핑.
// 두 기본 모델(Haru: TapBody 그룹 / Senko: Tap, Taphead 그룹) 모두에서 동작하도록
// 모션 그룹 후보 목록을 정의하고, 모델에 실제로 존재하는 그룹을 선택합니다.

const PARAMS_BY_TAG = {
  smile: { ParamMouthOpenY: 0.18, ParamBrowLY: 0.1, ParamBrowRY: 0.1 },
  neutral: { ParamMouthOpenY: 0.04 },
  think: {
    ParamAngleZ: -5,
    ParamEyeLOpen: 0.6,
    ParamEyeROpen: 0.6,
    ParamBrowLY: -0.35,
    ParamBrowRY: -0.35,
    ParamMouthOpenY: 0.06,
  },
  cheer: {
    ParamMouthForm: 0.4,
    ParamMouthOpenY: 0.25,
    ParamBrowLY: 0.4,
    ParamBrowRY: 0.4,
    ParamCheek: 0.3,
  },
  sad: {
    ParamAngleZ: 4,
    ParamEyeLOpen: 0.45,
    ParamEyeROpen: 0.45,
    ParamBrowLY: -0.5,
    ParamBrowRY: -0.5,
    ParamMouthOpenY: 0.05,
  },
  wink: { ParamEyeLOpen: 1, ParamEyeROpen: 0.05, ParamMouthForm: 0.3, ParamAngleZ: 2 },
  love: {
    ParamEyeLOpen: 0.8,
    ParamEyeROpen: 0.8,
    ParamMouthOpenY: 0.22,
    ParamBrowLY: 0.5,
    ParamBrowRY: 0.5,
    ParamCheek: 0.4,
    ParamAngleZ: -3,
  },
  // 상황별 태그 매핑
  focus: { ParamEyeLOpen: 0.88, ParamEyeROpen: 0.88, ParamBrowLY: -0.25, ParamBrowRY: -0.25, ParamMouthForm: 0.1, ParamMouthOpenY: 0.02 },
  proud: { ParamMouthForm: 0.6, ParamBrowLY: 0.35, ParamBrowRY: 0.35, ParamAngleY: -6, ParamAngleZ: -5, ParamMouthOpenY: 0.1 },
  fighting: { ParamMouthForm: 0.5, ParamMouthOpenY: 0.25, ParamBrowLY: 0.4, ParamBrowRY: 0.4, ParamCheek: 0.35, ParamEyeLOpen: 1.15, ParamEyeROpen: 1.15 },
  shy: { ParamCheek: 0.65, ParamAngleX: 16, ParamAngleY: 8, ParamAngleZ: -5, ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamMouthForm: 0.25, ParamMouthOpenY: 0.06 },
  panic: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25, ParamBrowLY: 0.7, ParamBrowRY: 0.7, ParamMouthOpenY: 0.3, ParamMouthForm: -0.3 },
  curious: { ParamAngleZ: 14, ParamAngleX: -7, ParamEyeLOpen: 1.08, ParamEyeROpen: 0.95, ParamBrowLY: 0.25, ParamBrowRY: -0.15, ParamMouthOpenY: 0.12, ParamMouthForm: 0.15 },
  dozeoff: { ParamAngleY: 16, ParamEyeLOpen: 0.1, ParamEyeROpen: 0.1, ParamBodyAngleY: 6, ParamMouthOpenY: 0.05 },
  relieved: { ParamAngleY: 8, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7, ParamMouthForm: 0.35, ParamMouthOpenY: 0.06, ParamBrowLY: 0.1, ParamBrowRY: 0.1 },
  pout: { ParamAngleX: -22, ParamAngleZ: -7, ParamMouthForm: -0.5, ParamBrowLY: -0.35, ParamBrowRY: -0.35, ParamEyeLOpen: 0.65, ParamEyeROpen: 0.65, ParamCheek: 0.25 },
  whisper: { ParamAngleZ: -10, ParamAngleX: 12, ParamEyeLOpen: 0.85, ParamEyeROpen: 0.1, ParamMouthOpenY: 0.08, ParamMouthForm: 0.35 },
  sparkle: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25, ParamBrowLY: 0.5, ParamBrowRY: 0.5, ParamCheek: 0.45, ParamMouthForm: 0.6, ParamMouthOpenY: 0.2 },
  spaceout: { ParamAngleY: -8, ParamEyeLOpen: 0.42, ParamEyeROpen: 0.42, ParamMouthOpenY: 0.12, ParamMouthForm: 0 },
};

// (그룹, 인덱스) 후보 목록 - 앞에서부터 실제 존재하는 그룹을 사용
const MOTION_PREFS = {
  smile: [['TapBody', 0], ['Taphead', undefined], ['Tap', undefined]],
  cheer: [['TapBody', 0], ['Taphead', 0], ['Tap', undefined]],
  love: [['TapBody', 1], ['Taphead', undefined], ['Tap', 0]],
  sad: [['TapBody', 2], ['Taphead', 1], ['Tap', 0]],
  think: null,
  wink: null,
  neutral: null,
};

export const EMOTION_TAGS = Object.keys(PARAMS_BY_TAG);

function setParam(model, id, value) {
  try {
    model.internalModel.coreModel.setParameterValueById(id, value, 1);
  } catch {
    /* 파라미터가 없는 모델은 무시 */
  }
}

export function setParams(model, paramMap) {
  for (const [id, value] of Object.entries(paramMap)) setParam(model, id, value);
}

function motionGroupCount(model, group) {
  try {
    const defs = model.internalModel?.motionManager?.definitions;
    return defs?.[group]?.length ?? 0;
  } catch {
    return 0;
  }
}

export function playMotion(model, tag) {
  const prefs = MOTION_PREFS[tag];
  if (!prefs) {
    try { model.motion('Idle'); } catch { /* noop */ }
    return;
  }
  for (const [group, idx] of prefs) {
    const count = motionGroupCount(model, group);
    if (count === 0) continue;
    try {
      const safeIdx = idx == null ? undefined : Math.min(idx, count - 1);
      model.motion(group, safeIdx);
      return;
    } catch {
      /* 다음 후보 시도 */
    }
  }
  try { model.motion('Idle'); } catch { /* noop */ }
}

// 건드리기(놀리기) 반응용 그룹
export function playTapMotion(model) {
  for (const g of ['TapBody', 'Tap', 'Taphead']) {
    if (motionGroupCount(model, g) > 0) {
      try { model.motion(g); return; } catch { /* next */ }
    }
  }
}

export function applyEmotion(model, tag, modelId = null) {
  const params = PARAMS_BY_TAG[tag] || PARAMS_BY_TAG.smile;
  // 립싱크 파라미터 제외 악센트(각도/눈/눈썹) 적용
  for (const [id, value] of Object.entries(params)) {
    if (id === 'ParamMouthOpenY') continue;
    setParam(model, id, value);
  }
  applyExpression(model, tag, modelId);
  playMotion(model, tag);
  return params;
}

// 모션 없이 파라미터+표정만 적용 (쓰다듬기 연타 등 반복 호출용)
export function softEmotion(model, tag, modelId = null) {
  const params = PARAMS_BY_TAG[tag] || PARAMS_BY_TAG.smile;
  for (const [id, value] of Object.entries(params)) {
    if (id === 'ParamMouthOpenY') continue;
    setParam(model, id, value);
  }
  applyExpression(model, tag, modelId);
  return params;
}

// 모델별 표정(expression) 매핑. 표정 파일 의미를 아는 모델만 등록.
// (모르는 모델에 잘못된 표정을 씌우지 않도록 미등록 모델은 파라미터 방식만 사용)
const EXPRESSION_BY_MODEL = {
  yinlang: {
    smile: ['e05'],
    love: ['e02'],
    cheer: ['e07'],
    sad: ['e08'],
    think: ['e06'],
    wink: ['e05'],
    neutral: ['e06'],
    focus: ['e06'],
    proud: ['e05', 'e07'],
    fighting: ['e07'],
    shy: ['e02'],
    panic: ['e08', 'e04'],
    curious: ['e06'],
    dozeoff: ['e06'],
    relieved: ['e05'],
    pout: ['e04', 'e08'],
    whisper: ['e05'],
    sparkle: ['e07', 'e02'],
    spaceout: ['e06'],
  },
};

function applyExpression(model, tag, modelId) {
  const names = modelId && EXPRESSION_BY_MODEL[modelId]?.[tag];
  if (!names || !model || typeof model.expression !== 'function') return;
  for (const name of names) {
    try {
      const r = model.expression(name);
      if (r?.catch) r.catch(() => {});
      break;
    } catch {
      /* 다음 후보 시도 */
    }
  }
}

// 모션 1회 재생. 루프형 모션(VTuber용 idle 계열)이 끝나지 않고
// 계속 도는 모델을 위해 autoStopMs 지정 시 강제 종료 후 Idle 복귀.
export function playOneShot(model, group, index, autoStopMs = 0) {
  if (!model) return;
  try {
    const r = model.motion(group, index);
    if (r?.catch) r.catch(() => {});
  } catch {
    return;
  }
  if (autoStopMs > 0) {
    const target = model;
    setTimeout(() => {
      try { target.internalModel?.motionManager?.stopAllMotions(); } catch {}
    }, autoStopMs);
  }
}

// 쓰다듬기 반응용 모션: 루프형 모션 모델은 자동 정지付き
export function playPetMotion(model, modelId = null) {
  if (!model) return;
  if (modelId === 'yinlang') {
    const idx = Math.floor(Math.random() * 2); // transform1/2
    playOneShot(model, 'TapBody', idx, 2600);
    return;
  }
  playTapMotion(model);
}

// 축하(더블클릭) 반응용 모션
export function playCelebrateMotion(model, modelId = null) {
  if (!model) return;
  if (modelId === 'yinlang') {
    playOneShot(model, 'TapBody', Math.floor(Math.random() * 3), 2600);
    return;
  }
  for (const g of ['TapBody', 'Taphead', 'Tap']) {
    if (motionGroupCount(model, g) > 0) {
      try { model.motion(g, 0); return; } catch { /* next */ }
    }
  }
}
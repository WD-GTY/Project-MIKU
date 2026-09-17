// 아바타 모델 레지스트리: 클라이언트 선택 UI + 세션별 저장 검증에 사용.
// 새 모델 추가 시: 1) client/assets/models/live2d/<id>/xxx.model3.json 배치
//                 2) 아래 배열에 항목 추가 (id는 폴더명과 일치 권장)
export const AVATAR_MODELS = [
  {
    id: 'haru',
    name: 'Haru (기본)',
    modelUrl: '/assets/models/live2d/haru/Haru.model3.json',
  },
  {
    id: 'senko',
    name: 'Senko',
    modelUrl: '/assets/models/live2d/senko/senko.model3.json',
  },
  {
    id: 'yinlang',
    name: '银狼',
    modelUrl: '/assets/models/live2d/yinlang/yinlang.model3.json',
    thumbnail: '/assets/models/live2d/yinlang/icon.png',
  },
  {
    id: 'miku',
    name: 'Hatsune Miku',
    modelUrl: '/assets/models/live2d/miku/miku.model3.json',
  },
];

// 기본 모델: 기존 동작 유지 (Haru 우선, 실패 시 클라이언트가 다음 후보로 폴백)
export const DEFAULT_AVATAR_MODEL_ID = 'haru';

export function getAvatarModel(id) {
  return AVATAR_MODELS.find((m) => m.id === id) || null;
}

export function resolveAvatarModelId(id) {
  return getAvatarModel(id)?.id || DEFAULT_AVATAR_MODEL_ID;
}

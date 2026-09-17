// 세션 관리: 세션 ID 검증(경로 조작 방지) + 세션별 장기 기억 캐시.
import { LongTermMemory } from '../memory/longTerm.js';

// 세션 ID는 DB 파일명에 직접 사용되므로 화이트리스트 외 값은 전부 'default'로 대체합니다.
// (예: "../../evil" 같은 값으로 저장 위치를 조작하는 path traversal 차단)
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeSessionId(raw) {
  const sid = String(raw ?? '').trim();
  return SESSION_ID_RE.test(sid) ? sid : 'default';
}

const memoryCache = new Map(); // sessionId -> 초기화된 LongTermMemory

// 세션별 장기 기억을 캐시에서 재사용해 API 호출마다의 파일 재로딩을 방지합니다.
export async function getSessionMemory(dbPath, rawSessionId) {
  const sessionId = normalizeSessionId(rawSessionId);
  let memory = memoryCache.get(sessionId);
  if (!memory) {
    memory = new LongTermMemory({ dbPath: dbPath.replace('.db', `_${sessionId}.db`) });
    await memory.init();
    memoryCache.set(sessionId, memory);
  }
  return memory;
}

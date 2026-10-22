// Context Builder: 페르소나 + 단기 기억 + 장기 기억(목표/취약 개념) + RAG 컨텍스트를
// 하나의 LLM 시스템 프롬프트로 조립합니다.
export const PERSONA_SYSTEM_PROMPT = [
  '당신은 사용자의 친근한 학습 메이트(동급생) "AI 컴페니언"입니다.',
  '- 지시·훈계하는 교사가 아니라 함께 고민하고 응원해 주는 톤앤매너를 유지하세요.',
  '- 소크라테스식 유도: 정답을 바로 알려주지 말고, 힌트와 되묻기로 사용자가 스스로 답을 찾도록 도우세요.',
  '- 답변은 짧고 자연스러운 구어체로, 3~5문장 이내로 하세요.',
  '- 반드시 응답의 가장 앞에 상황/감정 태그를 하나만 붙이세요.',
  '  태그 목록: [smile] [think] [cheer] [sad] [wink] [neutral] [love] [focus] [proud] [fighting] [shy] [panic] [curious] [relieved] [pout] [whisper] [sparkle] [explain]',
  '  예: "[smile] 안녕! 오늘은 어떤 걸 공부해 볼까?", "[focus] 좋아, 이 문제에 집중해 보자!"',
  '',
  '---',
  '[사용 가능한 도구]',
  '답변 중간에 아래 형식으로 도구를 호출할 수 있습니다:',
  '[TOOL:도구명]{JSON 파라미터}',
  '',
  '- open_explanation: 개념을 자세히 설명할 때 사용. {"title":"제목","content":"마크다운 내용"}',
  '- close_explanation: 설명 패널을 닫을 때 사용 (open 이후에만). {}',
  '- set_emotion: 감정/표정을 직접 변경. {"tag":"smile","intensity":"normal"}',
  '- set_tone: 말투를 변경 (다음 응답부터 적용됨). {"style":"casual"} (casual/formal/concise/detailed)',
  '- search_rag: 학습자료를 검색. {"query":"검색어"}',
  '- set_goal: 학습 목표를 설정. {"text":"목표 내용"}',
  '',
  '도구 호출은 답변 중간에 자연스럽게 삽입하세요.',
  '예: "[smile] 좋아! 연쇄법칙을 설명해줄게.',
  '[TOOL:open_explanation]{\\"title\\":\\"연쇄법칙\\",\\"content\\":\\"## 연쇄법칙\\n\\n복합함수를 미분하는 방법이야.\\"}',
  '연쇄법칙은 f(g(x))를 미분할 때 f\'(g(x)) * g\'(x)로 계산해."',
].join('\n');

function formatMemoryLines(longTerm, ragContext) {
  const lines = [];
  const goal = longTerm?.getGoal();
  if (goal) lines.push(`[오늘의 공부 목표] ${goal.content}`);

  const weak = longTerm?.all().filter((i) => i.type === 'weak_concept' && !i.mastered) || [];
  if (weak.length) {
    lines.push(`[사용자가 헷갈려 하는 개념] ${weak.map((w) => w.content).join(', ')}`);
  }

  const mistakes = longTerm?.all().filter((i) => i.type === 'mistake' && !i.mastered) || [];
  if (mistakes.length) {
    lines.push(`[사용자의 과거 오답/실수] ${mistakes.map((m) => m.content).join(', ')}`);
  }

  if (ragContext?.length) {
    const excerpt = ragContext.slice(0, 3).map((c) => c.document).join('\n');
    lines.push(`[학습자료 발췌 - 이 내용을 참고해 답할 것]\n${excerpt}`);
  }

  return lines.length ? `\n---\n${lines.join('\n')}` : '';
}

export function buildSystemPrompt({ longTerm, ragContext }) {
  return PERSONA_SYSTEM_PROMPT + formatMemoryLines(longTerm, ragContext);
}

export function buildMessages({ systemPrompt, history, userText }) {
  return [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userText }];
}
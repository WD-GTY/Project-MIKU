// 경량 마크다운 파서 — 외부 의존 없음, XSS 방지 포함.
// "보호된 블록" 패턴: 코드/수식 블록을 placeholder로 추출 → 인라인 처리 → 블록 요소 → 복원.

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMarkdown(text) {
  if (!text) return '';

  const blocks = []; // 보호된 블록 저장소
  let src = text;

  // 1) 코드 블록 추출 (```...```)
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code class="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `__BLOCK_${idx}__`;
  });

  // 2) 수식 블록 추출 ($$...$$)
  src = src.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<div class="math-block">${escapeHtml(math.trim())}</div>`);
    return `__BLOCK_${idx}__`;
  });

  // 3) 인라인 코드 추출 (`` `...` ``) — 수식/강조보다 우선
  src = src.replace(/`([^`]+)`/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<code>${escapeHtml(code)}</code>`);
    return `__BLOCK_${idx}__`;
  });

  // 4) 인라인 수식 ($...$) — 경계 체크: 앞/뒤가 숫자·알파벳·한글이면 수식 아님
  src = src.replace(/(?<![a-zA-Z0-9가-힣])\$([^\$\n]+?)\$(?![a-zA-Z0-9가-])/g, (_, math) => {
    const idx = blocks.length;
    blocks.push(`<span class="math-inline">${escapeHtml(math)}</span>`);
    return `__BLOCK_${idx}__`;
  });

  // 5) 인라인 강조 (**bold**, *italic*)
  src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // 5-1) XSS 방지: 보호된 블록(placeholder)을 제외한 모든 텍스트 이스케이프
  // placeholder는 __BLOCK_N__ 형태이므로 <, >, &가 없어 안전
  src = escapeHtml(src);
  // 단, 인라인 강조 태그는 이스케이프되었으므로 복원
  src = src.replace(/&lt;strong&gt;(.+?)&lt;\/strong&gt;/g, '<strong>$1</strong>');
  src = src.replace(/&lt;em&gt;(.+?)&lt;\/em&gt;/g, '<em>$1</em>');

  // 6) 블록 요소 처리 — 줄 단위로
  const lines = src.split('\n');
  const htmlLines = [];
  let inList = false, listType = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 빈 줄: 단락 구분
    if (line.trim() === '') {
      if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
      continue;
    }

    // 헤더
    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
      const level = hMatch[1].length;
      htmlLines.push(`<h${level}>${hMatch[2]}</h${level}>`);
      continue;
    }

    // 인용 (이스케이프 후 &gt; 로 변함)
    if (line.startsWith('&gt; ')) {
      if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
      htmlLines.push(`<blockquote>${line.slice(5)}</blockquote>`);
      continue;
    }

    // 순서 없는 목록
    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) htmlLines.push(`</${listType}>`);
        htmlLines.push('<ul>');
        inList = true; listType = 'ul';
      }
      htmlLines.push(`<li>${ulMatch[1]}</li>`);
      continue;
    }

    // 순서 있는 목록
    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) htmlLines.push(`</${listType}>`);
        htmlLines.push('<ol>');
        inList = true; listType = 'ol';
      }
      htmlLines.push(`<li>${olMatch[1]}</li>`);
      continue;
    }

    // 일반 텍스트: 단락으로 감싸기
    if (inList) { htmlLines.push(`</${listType}>`); inList = false; }
    htmlLines.push(`<p>${line}</p>`);
  }
  if (inList) htmlLines.push(`</${listType}>`);

  let result = htmlLines.join('\n');

  // 7) placeholder를 원래 블록으로 복원
  for (let i = 0; i < blocks.length; i++) {
    result = result.replace(`__BLOCK_${i}__`, blocks[i]);
  }

  return result;
}

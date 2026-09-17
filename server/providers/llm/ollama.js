import { LLMProvider } from './index.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

export class OllamaLLMProvider extends LLMProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, model = 'qwen3:14b' } = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
  }

  async init() {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`올라마 서버 연결 실패 (${res.status}): ${this.baseUrl}`);
    const data = await res.json();
    const names = data.models?.map((m) => m.name) ?? [];
    if (!names.some((n) => n.startsWith(this.model))) {
      console.warn(`[ollama] 모델 "${this.model}" 이(가) 설치되어 있지 않습니다. 사용 가능: ${names.join(', ')}`);
    }
    console.log(`[ollama] 연결 성공 – 모델: ${this.model}`);
  }

  async *streamChat({ messages }) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`올라마 API 오류 (${res.status}): ${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 미완성 줄은 다음에 처리

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content) {
            yield { token: obj.message.content };
          }
        } catch {
          // JSON 파싱 실패 줄 무시
        }
      }
    }

    // 남은 버퍼 처리
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer);
        if (obj.message?.content) {
          yield { token: obj.message.content };
        }
      } catch {}
    }
  }
}

export async function loadRealProvider() {
  const model = process.env.OLLAMA_MODEL || 'qwen3:14b';
  const baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  const provider = new OllamaLLMProvider({ baseUrl, model });
  await provider.init();
  return provider;
}

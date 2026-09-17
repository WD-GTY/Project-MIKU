// 단기/순간 기억: 최근 대화 턴을 슬라이딩 윈도우로 유지합니다.
export class ShortTermMemory {
  constructor({ maxTurns = 12 } = {}) {
    this.maxTurns = maxTurns;
    this.turns = [];
  }

  add(role, content) {
    this.turns.push({ role, content, ts: Date.now() });
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
  }

  addUser(content) {
    this.add('user', content);
  }

  addAssistant(content) {
    this.add('assistant', content);
  }

  getHistory(limit = this.maxTurns) {
    return this.turns.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  clear() {
    this.turns = [];
  }
}
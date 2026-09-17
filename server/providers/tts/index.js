// TTS(음성 합성) 공급자 인터페이스.
// ElevenLabs / OpenAI TTS / Typecast 등은 이 인터페이스로 구현합니다.
export class TTSProvider {
  async init() {
    throw new Error('not implemented');
  }

  /**
   * 문장 단위 음성 생성 스트림.
   * @param {string} text
   * @yields {{ buffer: ArrayBuffer, sampleRate: number, channels: number, durationMs: number, format: string }}
   */
  async *speak(text) {
    throw new Error('not implemented');
  }
}
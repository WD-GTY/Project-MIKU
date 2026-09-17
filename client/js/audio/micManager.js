// 마이크 관리: 음성 입력(STT) + 음성 간섭 방지 게이트.
// - dev(mock STT) 모드: 브라우저 Web Speech API로 인식 (크롬/엣지)
// - 추후 실서비스: 마이크 스트림을 서버로 전송해 Whisper/Deepgram 등으로 인식
import { getContext, getMicGain, ensureResumed } from './audioBus.js';

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

export class MicManager {
  constructor({ onTranscript, onListeningChange } = {}) {
    this.onTranscript = onTranscript || (() => {});
    this.onListeningChange = onListeningChange || (() => {});
    this.recognition = null;
    this.stream = null;
    this.listening = false;
    this.blocked = false;
    this.shouldListen = false;
    this.restartTimer = null;
  }

  get supported() {
    return Boolean(SpeechRecognition);
  }

  async start() {
    ensureResumed();
    if (!this.supported) {
      alert('이 브라우저는 음성 인식(Web Speech API)을 지원하지 않습니다.\n텍스트 입력을 사용해 주세요.');
      return;
    }
    // 권한 + 추후 실시간 오디오 스트리밍을 위해 마이크 확보
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = getContext().createMediaStreamSource(this.stream);
      src.connect(getMicGain()); // 모니터링 없이 게인 라우팅만 구성
    } catch (err) {
      console.warn('마이크 접근 실패:', err);
      this.stream = null;
    }

    this.listening = true;
    this.shouldListen = true;
    this.onListeningChange(true);
    this._startRecognition();
  }

  stop() {
    this.shouldListen = false;
    this.listening = false;
    this._stopRecognition();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.onListeningChange(false);
  }

  toggle() {
    if (this.listening) this.stop();
    else this.start();
  }

  // --- 음성 간섭 방지: TTS 재생 중 임시 인식 중지 ---
  setSpeaking(speaking) {
    this.setSpeechBlocked(speaking);
  }

  setSpeechBlocked(blocked) {
    this.blocked = blocked;
    if (blocked) {
      this.listening = false;
      this._stopRecognition();
      this.onListeningChange(false);
    } else if (this.shouldListen) {
      this.listening = true;
      this.onListeningChange(true);
      this._startRecognition();
    }
  }

  _startRecognition() {
    if (this.blocked || this.recognition) return;
    const rec = new SpeechRecognition();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const final = e.results[i].isFinal;
        const text = e.results[i][0].transcript.trim();
        if (final && text) this.onTranscript(text);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop();
      }
    };
    rec.onend = () => {
      this.recognition = null;
      // 연속 청취 유지 (말하기 중간의 자동 종료 대응)
      if (this.shouldListen && !this.blocked) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this._startRecognition(), 300);
      } else {
        this.listening = false;
        this.onListeningChange(false);
      }
    };
    try {
      rec.start();
      this.recognition = rec;
    } catch {
      this.recognition = null;
    }
  }

  _stopRecognition() {
    clearTimeout(this.restartTimer);
    if (this.recognition) {
      this.recognition.onend = null; // 재시작 사이클 방지
      try {
        this.recognition.abort();
      } catch {
        /* noop */
      }
      this.recognition = null;
    }
  }
}
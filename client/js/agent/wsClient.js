// WebSocket 클라이언트 래퍼: JSON/바이너리 메시지 및 자동 재연결.
export class WSClient {
  constructor({ url, onMessage, onOpen, onClose } = {}) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.retryTimer = null;
    this.closed = false;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  open() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.onOpen();
    ws.onclose = () => {
      this.onClose();
      if (!this.closed) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.open(), 2000);
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          this.onMessage(JSON.parse(e.data), false);
        } catch {
          this.onMessage(e.data, false);
        }
      } else {
        this.onMessage(e.data, true);
      }
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendBinary(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }
}
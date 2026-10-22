import { TTSProvider } from './index.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const DEFAULT_VOICE = 'ko-KR-SunHiNeural';
const SAMPLE_RATE = 24000;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BING_WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

// ---- Sec-MS-GEC v2 토큰 생성 (Microsoft 2026-10 보안 규격 대응) ----
const SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS = [...SHA256_ROUND_CONSTANTS.slice(0, 14), SHA256_ADJUSTMENT, ...SHA256_ROUND_CONSTANTS.slice(15)];
const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];

const rotr = (v, n) => (((v >>> n) | (v << (32 - n))) >>> 0);
const rol16 = (v) => (((v << 16) | (v >>> 16)) >>> 0);
const sigma0 = (v) => ((rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0);
const sigma1 = (v) => ((rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0);

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = g ^ (e & (f ^ g));
    const t1 = (h + s1 + ch + k[i] + words[i]) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) | (c & (a | b));
    const t2 = (s0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words.push((sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0);
  }
}

function sha256Digest(data) {
  const words = new Array(14).fill(0);
  words.push(((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0);
  words.push(data.readUInt32BE(3));
  for (let i = 16; i < 30; i++) {
    let val = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) val = (val + (i === 16 ? (sigma1(words[i - 2]) ^ 0x000B92C0) : sigma1(words[i - 2]))) >>> 0;
    if (i - 7 >= 14) val = (val + words[i - 7]) >>> 0;
    if (i - 15 >= 14) val = (val + (i === 29 ? (sigma0(words[i - 15]) ^ 0x059C0B80) : sigma0(words[i - 15]))) >>> 0;
    words.push(val >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0);
  expandSchedule(words, 31);
  let working = sha256Rounds(SHA256_STATE, words, 14);
  let state = SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);

  const length = 57 + data.length;
  const padZero = (55 - (length % 64) + 64) % 64;
  const padded = Buffer.alloc(data.length - 7 + 1 + padZero + 8);
  data.copy(padded, 0, 7);
  padded[data.length - 7] = 0x80;
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8);

  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w.push(padded.readUInt32BE(off + j * 4));
    expandSchedule(w, 16);
    working = sha256Rounds(state, w, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }
  const out = Buffer.alloc(32);
  state.forEach((v, idx) => out.writeUInt32BE(v, idx * 4));
  return out;
}

function cs64Digest(data, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [Math.imul(keyA, 0x82893933) >>> 0, Math.imul(keyB, 0x82893933) >>> 0];
  const terms = CS64_COEFFICIENTS.map(([c], i) => Math.imul(c, factors[i % 2]) >>> 0);
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o >>> 0);

  const prep = Buffer.concat([Buffer.from([0]), data]);
  const rem = (4 - (prep.length % 4)) % 4;
  const padded = rem ? Buffer.concat([prep, Buffer.alloc(rem)]) : prep;
  const dataWords = [];
  for (let i = 0; i < padded.length; i += 4) dataWords.push(padded.readUInt32LE(i));
  if (dataWords.length % 2 === 1) dataWords.push(0);

  dataWords.forEach((word, index) => {
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0;
    if (index === 0) {
      term = (term + Math.imul(0xF2F90B1A, factors[0])) >>> 0;
      offset = (offset + 0x0B1A0000) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swapAcc = (swapAcc + ((Math.imul(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(rol16(state), 0x257E1D83) >>> 0;
    acc = (acc + state) >>> 0;
    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xA27416F5) >>> 0;
    t = Math.imul(rol16(t), 0xD38396FF) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return out;
}

export function generateSecMsGecV2(unixTs = (Date.now() + (MsEdgeTTS._clockOffsetMs || 0)) / 1000) {
  let ticks = Math.floor(unixTs) + 11644473600;
  ticks -= ticks % 300;
  ticks = Math.round(ticks * 1e7);
  const strBuf = Buffer.from(String(ticks) + TRUSTED_CLIENT_TOKEN, 'ascii');
  const digest = sha256Digest(strBuf);
  const cs64 = cs64Digest(strBuf, digest);
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

// MsEdgeTTS가 429 제한이 걸리는 api.msedgeservices.com 대신 공식 ReadAloud v2 토큰 엔드포인트를 쓰도록 패치
MsEdgeTTS.getSynthUrl = async function getSynthUrlV2() {
  const reqId = MsEdgeTTS.generateUUID();
  const secMsGEC = generateSecMsGecV2();
  return `${BING_WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGEC}&Sec-MS-GEC-Version=2-143.0.3650.75&ConnectionId=${reqId}`;
};

export class Provider extends TTSProvider {
  constructor({
    voice = process.env.TTS_VOICE || DEFAULT_VOICE,
    pitch = process.env.TTS_PITCH || '+15Hz',
    rate = process.env.TTS_RATE || '+5%',
    volume = process.env.TTS_VOLUME || '+0%',
  } = {}) {
    super();
    this.voice = voice;
    this.pitch = pitch;
    this.rate = rate;
    this.volume = volume;
    this.tts = new MsEdgeTTS();
  }

  async init() {
    await this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    console.log(`[tts] msedge 연결 성공 – 음성: ${this.voice} | pitch: ${this.pitch} | rate: ${this.rate} | volume: ${this.volume}`);
  }

  async *speak(text) {
    if (!text?.trim()) return;

    const { audioStream } = this.tts.toStream(text, {
      pitch: this.pitch,
      rate: this.rate,
      volume: this.volume,
    });
    const chunks = [];

    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const durationMs = Math.round((buffer.length / (48000 / 8)) * 1000);

    yield {
      buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      sampleRate: SAMPLE_RATE,
      channels: 1,
      durationMs,
      format: 'mp3',
    };
  }
}

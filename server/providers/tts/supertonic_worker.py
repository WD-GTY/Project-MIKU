import os
import sys
import json
import base64
import io
import traceback
import soundfile as sf
import numpy as np

# PyTorch의 CUDA/cuDNN DLL 경로를 Windows 동적 라이브러리 검색 경로에 등록
try:
    import torch
    torch_lib = os.path.join(os.path.dirname(torch.__file__), 'lib')
    if os.path.exists(torch_lib):
        if hasattr(os, 'add_dll_directory'):
            os.add_dll_directory(torch_lib)
        os.environ['PATH'] = torch_lib + os.pathsep + os.environ.get('PATH', '')
except Exception:
    pass

# Supertonic의 ONNX 프로바이더 설정 (SUPERTONIC_DEVICE: cpu 기본, gpu 선택 가능)
try:
    import onnxruntime as ort
    ort.set_default_logger_severity(3)
    import supertonic.config
    import supertonic.loader
    target_device = os.environ.get('SUPERTONIC_DEVICE', 'cpu').lower()
    if target_device == 'gpu':
        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
    else:
        providers = ['CPUExecutionProvider']
    supertonic.config.DEFAULT_ONNX_PROVIDERS = providers
    supertonic.loader.DEFAULT_ONNX_PROVIDERS = providers
except Exception:
    pass

# UTF-8 입출력 강제 설정
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def main():
    try:
        from supertonic import TTS
        tts = TTS(auto_download=True)
    except Exception as e:
        sys.stdout.write(json.dumps({"status": "error", "message": f"Failed to load Supertonic TTS: {e}"}) + "\n")
        sys.stdout.flush()
        return

    # 활성화된 프로바이더 확인 (CUDA GPU 여부)
    active_providers = getattr(tts.model.vocoder_ort, 'get_providers', lambda: ['unknown'])()
    is_gpu = 'CUDAExecutionProvider' in active_providers

    # 음성 스타일 캐시
    cached_styles = {}
    for v in getattr(tts, 'voice_style_names', ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']):
        try:
            cached_styles[v] = tts.get_voice_style(v)
        except Exception:
            pass

    # 준비 완료 알림
    sys.stdout.write(json.dumps({
        "status": "ready",
        "model": "supertonic-3",
        "device": "GPU (RTX 3060 CUDA)" if is_gpu else "CPU",
        "sampleRate": tts.sample_rate,
        "voices": list(cached_styles.keys()),
        "providers": active_providers
    }) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            text = req.get("text", "").strip()
            voice_name = req.get("voice", "F1")
            lang = req.get("lang", "ko")
            speed = float(req.get("speed", 1.05))
            total_steps = int(req.get("steps", 8))

            if not text:
                sys.stdout.write(json.dumps({"id": req_id, "error": "Empty text"}) + "\n")
                sys.stdout.flush()
                continue

            # 스타일 가져오기
            style = cached_styles.get(voice_name)
            if style is None:
                style = tts.get_voice_style(voice_name)
                cached_styles[voice_name] = style

            wav, duration = tts.synthesize(
                text=text,
                voice_style=style,
                lang=lang,
                speed=speed,
                total_steps=total_steps
            )

            # WAV 16bit 인코딩
            buf = io.BytesIO()
            audio_data = wav[0] if wav.ndim > 1 else wav
            sf.write(buf, audio_data, tts.sample_rate, format='WAV', subtype='PCM_16')
            wav_bytes = buf.getvalue()

            dur_sec = float(duration[0]) if hasattr(duration, '__iter__') else float(duration)
            duration_ms = int(dur_sec * 1000)

            b64_str = base64.b64encode(wav_bytes).decode('ascii')
            sys.stdout.write(json.dumps({
                "id": req_id,
                "audioBase64": b64_str,
                "durationMs": duration_ms,
                "sampleRate": tts.sample_rate
            }) + "\n")
            sys.stdout.flush()

        except Exception as err:
            sys.stdout.write(json.dumps({
                "id": req.get("id") if 'req' in locals() else None,
                "error": str(err),
                "trace": traceback.format_exc()
            }) + "\n")
            sys.stdout.flush()

if __name__ == '__main__':
    main()

@echo off
title GPT-SoVITS API Server (Port 9880)
cd /d "%~dp0tools\gpt_sovits"
set PYTHONIOENCODING=utf-8
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
set CUDA_MODULE_LOADING=LAZY
echo ============================================================
echo   GPT-SoVITS API v2 Server (Port 9880 - 11GB VRAM Boost)
echo ============================================================
py -3.11 api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
pause

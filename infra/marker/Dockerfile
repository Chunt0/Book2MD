# Book2MD — marker PDF→Markdown conversion service (GPU).
# Pure deterministic conversion (NO LLM — M0 found in-loop LLM = hours/book).
# Book2MD has no LLM at all; QA is lint + human review. See NEW_PROJECT_SPEC §5/§13/§14.
#
# Base must already ship torch >= 2.7 (marker-pdf 1.10.x requires it). If torch is
# older, pip silently UPGRADES torch but not torchvision, and their compiled ops
# desync ("operator torchvision::nms does not exist") — crash-loop at startup.
# 2.8.0 satisfies marker, so torch/torchvision/torchaudio stay matched; cu12.8
# runs fine on the host's 580 / CUDA 13 driver (forward-compatible).
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

# OpenCV / image libs marker pulls in at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# marker-pdf + the optional server extras (uvicorn/fastapi/multipart).
RUN pip install --no-cache-dir marker-pdf uvicorn fastapi python-multipart

# Fail the BUILD (not runtime) if torch/torchvision ops ever desync again.
RUN python -c "import torch, torchvision; from torchvision.ops import nms; \
print('torch', torch.__version__, '| torchvision', torchvision.__version__, '| cuda', torch.version.cuda)"

# Surya/marker model weights download on first run — cache them on a mounted
# volume (/cache) so container recreates don't re-download a few GB each time.
ENV HF_HOME=/cache/hf \
    TORCH_HOME=/cache/torch

EXPOSE 8001
# Stock marker_server (binds 127.0.0.1:8001 on the host via network_mode: host,
# which the native API reaches at localhost:8001). Request params: filepath,
# output_format, paginate_output, force_ocr, page_range — all deterministic.
CMD ["marker_server", "--port", "8001"]

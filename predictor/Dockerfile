# Prediction Lab worker: Kronos-mini on CPU (ARM for the AWS t4g server, x86 too). Built by GitHub Actions
# (.github/workflows/predictor-image.yml) and pulled by the server; Watchtower there picks up new versions.
FROM python:3.11-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/data/hf PYTHONPATH=/kronos:/app
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 \
 && pip install numpy==1.26.4 pandas==2.2.2 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm==4.67.1
# The official Kronos model code (MIT licence), pinned.
ADD https://github.com/shiyu-coder/Kronos/archive/67b630e67f6a18c9e9be918d9b4337c960db1e9a.tar.gz /tmp/kronos.tgz
RUN mkdir /kronos && tar -xzf /tmp/kronos.tgz -C /kronos --strip-components=1 && rm /tmp/kronos.tgz
WORKDIR /app
COPY predictor/*.py /app/
VOLUME /data
CMD ["python", "-u", "worker.py"]

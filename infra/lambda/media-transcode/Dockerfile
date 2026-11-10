# Media transcode Lambda: Debian's own ffmpeg package (no third-party
# binaries) plus AWS's Lambda runtime interface client for Python.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "awslambdaric>=3,<4" "boto3>=1.35,<2"

WORKDIR /function
COPY handler.py .

ENTRYPOINT ["python", "-m", "awslambdaric"]
CMD ["handler.handler"]

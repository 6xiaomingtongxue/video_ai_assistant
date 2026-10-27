FROM node:22-bookworm-slim AS javascript
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=javascript /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY video_jobs.py server.py ./
ENV VIDEOLENS_TEXT_HOST=0.0.0.0 VIDEOLENS_TEXT_DATA=/data
EXPOSE 8000
CMD ["python", "server.py"]

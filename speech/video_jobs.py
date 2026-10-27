"""Whole-video text jobs. Audio always starts at the source's 00:00."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit


def job_failure(stage, error):
    # Return only known messages; upstream exceptions may contain credentials or URLs.
    if isinstance(error, TypeError) and "metadata_errors" in str(error):
        return "audio_decoder_incompatible", "本机音频解码组件版本不兼容，请更新 VideoLens Bridge 后重试。"
    if isinstance(error, (ImportError, ModuleNotFoundError)):
        return "speech_dependency_missing", "本机视频处理组件不完整，请更新 VideoLens Bridge 后重试。"
    if stage == "downloading":
        return "audio_download_failed", "视频音频下载失败，请确认视频可公开访问并稍后重试。"
    return "transcription_failed", "本机语音识别失败，请重试；若仍失败，请更新 VideoLens Bridge。"


def normalize_video_url(value: str) -> str:
    parsed = urlsplit(str(value))
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.port:
        raise ValueError("Unsupported video URL")
    host = (parsed.hostname or "").lower()
    query = parse_qs(parsed.query)
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
        video_id = query.get("v", [""])[0] if parsed.path == "/watch" else parsed.path.strip("/").split("/")[-1]
        if not re.fullmatch(r"[\w-]{6,64}", video_id, flags=re.ASCII):
            raise ValueError("Invalid YouTube video ID")
        return "https://www.youtube.com/watch?" + urlencode({"v": video_id})
    if host in {"bilibili.com", "www.bilibili.com", "m.bilibili.com"}:
        match = re.fullmatch(r"/(video/(?:BV[\w]+|av\d+)|bangumi/play/(?:ep|ss)\d+)/?", parsed.path, re.ASCII | re.IGNORECASE)
        if not match:
            raise ValueError("Invalid Bilibili video URL")
        part = query.get("p", ["1"])[0]
        if not part.isascii() or not part.isdigit() or not 1 <= int(part) <= 10000:
            raise ValueError("Invalid Bilibili part")
        return f"https://www.bilibili.com/{match.group(1)}" + (f"?p={int(part)}" if int(part) > 1 else "")
    raise ValueError("Only YouTube and Bilibili videos are supported")


def validate_options(url: str, model: str, language: str = "") -> dict:
    model = str(model).strip()
    language = str(language or "").strip().lower()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)?", model) or ".." in model:
        raise ValueError("Invalid speech model")
    if language and not re.fullmatch(r"[a-z]{2,3}", language):
        raise ValueError("Invalid video language")
    return {"url": normalize_video_url(url), "model": model, "language": language}


def download_audio(url: str, directory: Path) -> tuple[Path, float]:
    from yt_dlp import YoutubeDL

    def check_video(info, *, incomplete=False):
        if info.get("is_live") or info.get("live_status") == "is_upcoming":
            return "Live and upcoming videos cannot be processed as complete recordings"
        duration = info.get("duration")
        if duration and duration > 12 * 60 * 60:
            return "Video exceeds the 12-hour processing limit"
        return None

    options = {
        "format": "bestaudio/best",
        "outtmpl": str(directory / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "retries": 3,
        "skip_unavailable_fragments": False,
        "max_filesize": 1024 * 1024 * 1024,
        "match_filter": check_video,
        "js_runtimes": {"node": {}},
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
        if not info or info.get("_type") == "playlist":
            raise ValueError("A single, accessible recorded video is required")
        audio_path = Path(downloader.prepare_filename(info)).resolve()
    if audio_path.parent != directory.resolve() or not audio_path.is_file():
        raise ValueError("The video audio could not be downloaded")
    return audio_path, float(info.get("duration") or 0)


class WhisperTranscriber:
    def __init__(self, model_directory: Path):
        self.model_directory = model_directory
        self.model = None
        self.model_name = ""

    def __call__(self, audio_path: Path, model_name: str, language: str):
        from faster_whisper import WhisperModel

        if self.model_name != model_name:
            self.model = None
            self.model = WhisperModel(
                model_name,
                device=os.getenv("VIDEOLENS_WHISPER_DEVICE", "cpu"),
                compute_type=os.getenv("VIDEOLENS_WHISPER_COMPUTE_TYPE", "int8"),
                download_root=str(self.model_directory),
            )
            self.model_name = model_name
        segments, info = self.model.transcribe(str(audio_path), language=language or None, vad_filter=True)
        return segments, float(info.duration)


class VideoJobs:
    def __init__(self, directory: Path, *, downloader=None, transcriber=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.work_directory = self.directory.resolve() / "work"
        self.work_directory.mkdir(exist_ok=True)
        self.jobs = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-text")
        self.downloader = downloader or download_audio
        self.transcriber = transcriber or WhisperTranscriber(self.directory / "models")

    def _path(self, job_id):
        if not re.fullmatch(r"[a-f0-9]{64}", str(job_id)):
            raise ValueError("Invalid job ID")
        return self.directory / (job_id + ".json")

    def _save(self, job):
        path = self._path(job["id"])
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)

    def _view(self, job, *, include_partial=False):
        return {
            **{key: value for key, value in job.items() if key not in {"segments", "options"}},
            "segments": list(job["segments"]) if include_partial or job["status"] == "completed" else [],
        }

    def start(self, url, model, language="", *, include_partial=False):
        options = validate_options(url, model, language)
        job_id = hashlib.sha256(json.dumps(options, sort_keys=True).encode()).hexdigest()
        with self.lock:
            existing = self.jobs.get(job_id)
            if existing and existing["status"] != "failed":
                return self._view(existing, include_partial=include_partial)
            path = self._path(job_id)
            if path.is_file():
                try:
                    cached = json.loads(path.read_text(encoding="utf-8"))
                    if cached.get("status") == "completed" and cached.get("options") == options:
                        self.jobs[job_id] = cached
                        return self._view(cached)
                except (ValueError, OSError):
                    pass
            if sum(job["status"] not in {"completed", "failed"} for job in self.jobs.values()) >= 5:
                raise RuntimeError("Too many video jobs; retry after an existing job completes")
            job = {
                "id": job_id, "status": "queued", "options": options,
                "recordingStart": 0, "processedUntil": 0, "duration": 0,
                "segments": [], "error": "", "errorCode": "", "failedStage": "", "createdAt": time.time(),
            }
            self.jobs[job_id] = job
            try:
                self._save(job)
            except OSError:
                self.jobs.pop(job_id, None)
                raise
            self.executor.submit(self._run, job_id)
            return self._view(job, include_partial=include_partial)

    def get(self, job_id, *, include_partial=False):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                path = self._path(job_id)
                if not path.is_file():
                    raise KeyError(job_id)
                job = json.loads(path.read_text(encoding="utf-8"))
                if job.get("status") != "completed":
                    raise KeyError(job_id)
                self.jobs[job_id] = job
            return self._view(job, include_partial=include_partial)

    def _run(self, job_id):
        with self.lock:
            job = self.jobs[job_id]
        try:
            with self.lock:
                job["status"] = "downloading"
                self._save(job)
            # No seek/currentTime option: the complete source is decoded from 00:00.
            with tempfile.TemporaryDirectory(prefix="video-audio-", dir=self.work_directory) as temporary:
                if Path(temporary).resolve().parent != self.work_directory:
                    raise ValueError("Unexpected temporary audio directory")
                audio_path, duration = self.downloader(job["options"]["url"], Path(temporary))
                with self.lock:
                    job["duration"] = duration
                    job["status"] = "transcribing"
                    self._save(job)
                segments, actual_duration = self.transcriber(audio_path, job["options"]["model"], job["options"]["language"])
                if not math.isfinite(actual_duration) or actual_duration < 0 or actual_duration > 12 * 60 * 60:
                    raise ValueError("Invalid or unsupported recording duration")
                with self.lock:
                    job["duration"] = actual_duration
                for segment in segments:
                    start, end = float(segment.start), float(segment.end)
                    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                        raise ValueError("Invalid transcription timestamp")
                    if start >= actual_duration:
                        continue
                    text = str(segment.text).strip()
                    with self.lock:
                        job["processedUntil"] = max(job["processedUntil"], min(actual_duration, end))
                        if text:
                            job["segments"].append({"start": start, "end": min(actual_duration, end), "text": text})
                        if len(job["segments"]) % 20 == 0:
                            self._save(job)
                with self.lock:
                    job["processedUntil"] = actual_duration
                    job["status"] = "completed"
                    self._save(job)
        except Exception as error:
            with self.lock:
                stage = job["status"]
                code, message = job_failure(stage, error)
                logging.getLogger(__name__).error("Video text job %s failed at %s (%s, code=%s)",
                                                 job_id[:12], stage, type(error).__name__, code)
                job["status"] = "failed"
                job["failedStage"] = stage
                job["errorCode"], job["error"] = code, message
                try:
                    self._save(job)
                except OSError:
                    pass

    def close(self):
        self.executor.shutdown(wait=True)

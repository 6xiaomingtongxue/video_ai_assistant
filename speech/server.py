"""Local HTTP API for complete-video transcription jobs."""

import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from video_jobs import VideoJobs


def create_handler(jobs, api_key=""):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            if api_key and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + api_key):
                self.respond(401, {"error": "Invalid service credential"})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == "/health":
                self.respond(200, {"status": "ok", "wholeVideoText": True, "progressiveText": True,
                                   "service": "videolens-video-text", "schema": 1})
                return
            if self.path.startswith("/v1/video-transcriptions/"):
                try:
                    parsed = urlsplit(self.path)
                    partial = parse_qs(parsed.query).get("partial", [""])[0] == "1"
                    self.respond(200, jobs.get(parsed.path.rsplit("/", 1)[-1], include_partial=partial))
                except (KeyError, ValueError, OSError):
                    self.respond(404, {"error": "Video job not found"})
                return
            self.respond(404, {"error": "Unknown endpoint"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/v1/video-transcriptions":
                self.respond(404, {"error": "Unknown endpoint"})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self.respond(415, {"error": "JSON content type required"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 16384:
                    raise ValueError("Invalid request size")
                data = json.loads(self.rfile.read(size))
                result = jobs.start(data["url"], data["model"], data.get("language", ""), include_partial=True)
                self.respond(200 if result["status"] == "completed" else 202, result)
            except (ValueError, KeyError, TypeError):
                self.respond(400, {"error": "Invalid video URL, model or language"})
            except RuntimeError:
                self.respond(429, {"error": "The video queue is full; retry later"})
            except OSError:
                self.respond(503, {"error": "The video text cache is unavailable"})

    return Handler


if __name__ == "__main__":
    jobs = VideoJobs(Path(os.getenv("VIDEOLENS_TEXT_DATA", "./data")))
    server = ThreadingHTTPServer(
        (os.getenv("VIDEOLENS_TEXT_HOST", "127.0.0.1"), int(os.getenv("VIDEOLENS_TEXT_PORT", "8000"))),
        create_handler(jobs, os.getenv("VIDEOLENS_API_KEY", "")),
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
        jobs.close()

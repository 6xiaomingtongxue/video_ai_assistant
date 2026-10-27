import io
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

from server import create_handler
from video_jobs import VideoJobs, WhisperTranscriber, download_audio, normalize_video_url, validate_options


class WholeVideoTests(unittest.TestCase):
    def setUp(self):
        temporary_root = Path(__file__).resolve().parents[1] / ".tmp"
        temporary_root.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="videolens-video-test-", dir=temporary_root)
        self.directory = Path(self.temporary.name)
        self.assertEqual(self.directory.resolve().parent, temporary_root.resolve())
        self.downloads = []
        self.audio_paths = []
        self.stores = []

    def tearDown(self):
        for store in self.stores:
            store.close()
        self.temporary.cleanup()

    def downloader(self, url, directory):
        self.downloads.append(url)
        path = directory / "audio.webm"
        path.write_bytes(b"synthetic-audio")
        self.audio_paths.append(path)
        return path, 900

    def transcriber(self, path, model, language):
        self.assertTrue(path.is_file())
        return iter([
            SimpleNamespace(start=0, end=5, text="Opening definition"),
            SimpleNamespace(start=590, end=610, text="Current explanation"),
            SimpleNamespace(start=890, end=900, text="Closing summary"),
        ]), 900

    def store(self, **overrides):
        store = VideoJobs(self.directory, downloader=overrides.get("downloader", self.downloader),
                          transcriber=overrides.get("transcriber", self.transcriber))
        self.stores.append(store)
        return store

    def test_complete_source_starts_at_zero_and_is_cached(self):
        store = self.store()
        job = store.start("https://www.youtube.com/watch?v=abcdefghijk&t=600", "Systran/faster-whisper-small", "zh")
        store.close()
        result = store.get(job["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["recordingStart"], 0)
        self.assertEqual(result["processedUntil"], 900)
        self.assertEqual(result["segments"][0]["start"], 0)
        self.assertEqual(result["segments"][-1]["end"], 900)
        self.assertEqual(self.downloads, ["https://www.youtube.com/watch?v=abcdefghijk"])
        self.assertFalse(self.audio_paths[0].exists(), "temporary audio must be removed after processing")
        restarted = self.store()
        cached = restarted.start("https://youtu.be/abcdefghijk?t=100", "Systran/faster-whisper-small", "zh")
        self.assertEqual(cached["id"], job["id"])
        self.assertEqual(cached["status"], "completed")
        self.assertEqual(len(self.downloads), 1)

    def test_in_flight_jobs_are_deduplicated_and_do_not_report_complete_text(self):
        started, finish = threading.Event(), threading.Event()

        def slow_transcriber(*args):
            started.set()
            finish.wait(3)
            return self.transcriber(*args)

        store = self.store(transcriber=slow_transcriber)
        job = store.start("https://www.youtube.com/watch?v=abcdefghijk", "small")
        self.assertTrue(started.wait(2))
        try:
            duplicate = store.start("https://www.youtube.com/watch?v=abcdefghijk&t=800", "small")
            self.assertEqual(duplicate["id"], job["id"])
            self.assertEqual(duplicate["status"], "transcribing")
            self.assertEqual(duplicate["segments"], [])
            self.assertEqual(len(self.downloads), 1)
        finally:
            finish.set()

    def test_failed_jobs_can_be_retried_from_zero(self):
        attempts = []

        def transcribe(*args):
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError("provider-token-must-not-be-returned")
            return self.transcriber(*args)

        first = self.store(transcriber=transcribe)
        job = first.start("https://www.youtube.com/watch?v=abcdefghijk", "small")
        first.close()
        failed = first.get(job["id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["failedStage"], "transcribing")
        self.assertEqual(failed["errorCode"], "transcription_failed")
        self.assertNotIn("provider-token", json.dumps(failed))
        retry = self.store(transcriber=transcribe)
        retry.start("https://www.youtube.com/watch?v=abcdefghijk&t=700", "small")
        retry.close()
        self.assertEqual(retry.get(job["id"])["segments"][0]["start"], 0)

    def test_incompatible_decoder_returns_safe_actionable_error(self):
        def incompatible(*_):
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'; secret-token")

        store = self.store(transcriber=incompatible)
        job = store.start("https://youtu.be/abcdefghijk", "small")
        store.close()
        result = store.get(job["id"])
        self.assertEqual(result["failedStage"], "transcribing")
        self.assertEqual(result["errorCode"], "audio_decoder_incompatible")
        self.assertIn("更新 VideoLens Bridge", result["error"])
        self.assertNotIn("secret-token", json.dumps(result))
        self.assertFalse(self.audio_paths[0].exists())

    def test_download_failure_is_distinct_from_transcription_failure(self):
        def unavailable(*_):
            raise RuntimeError("HTTP 403: secret-cookie")

        store = self.store(downloader=unavailable)
        job = store.start("https://youtu.be/abcdefghijk", "small")
        store.close()
        result = store.get(job["id"])
        self.assertEqual(result["failedStage"], "downloading")
        self.assertEqual(result["errorCode"], "audio_download_failed")
        self.assertNotIn("secret-cookie", json.dumps(result))

    def test_invalid_timestamps_do_not_produce_a_complete_recording(self):
        store = self.store(transcriber=lambda *_: (iter([SimpleNamespace(start=-1, end=2, text="bad")]), 900))
        job = store.start("https://www.youtube.com/watch?v=abcdefghijk", "small")
        store.close()
        self.assertEqual(store.get(job["id"])["status"], "failed")

    def test_downloader_and_whisper_adapters_do_not_seek_to_playback_time(self):
        captured = {}
        audio = self.directory / "audio.webm"

        class Downloader:
            def __init__(self, options):
                captured["options"] = options

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def extract_info(self, url, download):
                captured["url"] = url
                audio.write_bytes(b"full audio")
                return {"duration": 900}

            def prepare_filename(self, info):
                return str(audio)

        class Model:
            def __init__(self, name, **options):
                captured["model"] = (name, options)

            def transcribe(self, path, **options):
                captured["transcribe"] = (path, options)
                return iter([SimpleNamespace(start=0, end=5, text="beginning")]), SimpleNamespace(duration=900)

        with patch.dict("sys.modules", {"yt_dlp": SimpleNamespace(YoutubeDL=Downloader), "faster_whisper": SimpleNamespace(WhisperModel=Model)}):
            source, duration = download_audio("https://www.youtube.com/watch?v=abcdefghijk", self.directory)
            self.assertEqual(duration, 900)
            transcriber = WhisperTranscriber(self.directory / "models")
            segments, duration = transcriber(source, "Systran/faster-whisper-small", "zh")
            self.assertEqual(next(segments).start, 0)
        self.assertEqual(captured["options"]["js_runtimes"], {"node": {}})
        self.assertFalse(captured["options"]["skip_unavailable_fragments"])
        self.assertNotIn("download_ranges", captured["options"])
        self.assertEqual(captured["transcribe"][1], {"language": "zh", "vad_filter": True})
        self.assertTrue(captured["options"]["match_filter"]({"is_live": True}))
        self.assertTrue(captured["options"]["match_filter"]({"duration": 13 * 60 * 60}))

    def test_url_and_model_validation(self):
        self.assertEqual(normalize_video_url("https://www.bilibili.com/video/BV1testabc?p=2&t=900"),
                         "https://www.bilibili.com/video/BV1testabc?p=2")
        self.assertEqual(normalize_video_url("https://www.youtube.com/shorts/abcdefghijk?t=900"),
                         "https://www.youtube.com/watch?v=abcdefghijk")
        for value in ["http://127.0.0.1/private", "file:///audio", "https://www.youtube.com.evil.test/watch?v=abcdefghijk",
                      "https://key@www.youtube.com/watch?v=abcdefghijk", "https://www.bilibili.com/video/BV1test?p=-1"]:
            with self.assertRaises(ValueError):
                normalize_video_url(value)
        with self.assertRaises(ValueError):
            validate_options("https://youtu.be/abcdefghijk", "../../secret")
        with self.assertRaises(ValueError):
            validate_options("https://youtu.be/abcdefghijk", "small", "Chinese")

    def request(self, handler_type, method, path, data=None, authorization=""):
        handler = handler_type.__new__(handler_type)
        encoded = json.dumps(data).encode() if data is not None else b""
        handler.path = path
        handler.headers = {"Content-Length": str(len(encoded)), "Authorization": authorization, "Content-Type": "application/json"}
        handler.rfile, handler.wfile = io.BytesIO(encoded), io.BytesIO()
        statuses = []
        handler.send_response = statuses.append
        handler.send_header = lambda *_: None
        handler.end_headers = lambda: None
        getattr(handler, "do_" + method)()
        return statuses[0], json.loads(handler.wfile.getvalue())

    def test_http_job_contract_and_authentication(self):
        store = self.store()
        handler = create_handler(store, "service-key")
        self.assertEqual(self.request(handler, "GET", "/health")[0], 401)
        status, health = self.request(handler, "GET", "/health", authorization="Bearer service-key")
        self.assertEqual(status, 200)
        self.assertTrue(health["wholeVideoText"])
        self.assertEqual(health["service"], "videolens-video-text")
        self.assertEqual(health["schema"], 1)
        self.assertEqual(self.request(handler, "POST", "/v1/video-transcriptions", {})[0], 401)
        authorization = "Bearer service-key"
        self.assertEqual(self.request(handler, "POST", "/v1/video-transcriptions", {"url": "file:///secret", "model": "small"}, authorization)[0], 400)
        status, job = self.request(handler, "POST", "/v1/video-transcriptions",
                                   {"url": "https://youtu.be/abcdefghijk?t=600", "model": "small"}, authorization)
        self.assertIn(status, [200, 202])
        store.close()
        status, result = self.request(handler, "GET", "/v1/video-transcriptions/" + job["id"], authorization=authorization)
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["segments"][0]["start"], 0)
        self.assertEqual(self.request(handler, "GET", "/v1/video-transcriptions/../../secret", authorization=authorization)[0], 404)


if __name__ == "__main__":
    unittest.main()

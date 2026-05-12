"""Unit tests for backend/app/rtsp_publisher.py.

subprocess.Popen is mocked — no real ffmpeg needed.
"""

import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call


import backend.app.rtsp_publisher as pub  # noqa: E402


def _fresh_state():
    """Reset module-level _publishers dict between tests."""
    with pub._lock:
        pub._publishers.clear()


def _mock_popen(poll_return=None):
    """Return a MagicMock that looks like a live Popen process by default."""
    proc = MagicMock()
    proc.pid = 12345
    proc.poll = MagicMock(return_value=poll_return)
    proc.terminate = MagicMock()
    proc.wait = MagicMock()
    return proc


# ---------------------------------------------------------------------------
# start()
# ---------------------------------------------------------------------------

class TestStart(unittest.TestCase):
    def setUp(self):
        _fresh_state()

    def test_returns_rtsp_url(self):
        proc = _mock_popen()
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            url = pub.start("vid-001", Path("/data/videos/vid-001.mp4"))
        self.assertIn("vid-001", url)
        self.assertTrue(url.startswith("rtsp://"))

    def test_popen_called_with_ffmpeg(self):
        proc = _mock_popen()
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc) as mock_popen:
            pub.start("vid-002", Path("/data/videos/vid-002.mp4"))
        cmd = mock_popen.call_args.args[0]
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-re", cmd)
        self.assertIn("-stream_loop", cmd)
        self.assertIn("-c", cmd)
        self.assertIn("copy", cmd)
        self.assertIn("-f", cmd)
        self.assertIn("rtsp", cmd)

    def test_process_stored_in_publishers(self):
        proc = _mock_popen()
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            pub.start("vid-003", Path("/data/videos/vid-003.mp4"))
        self.assertIn("vid-003", pub._publishers)

    def test_existing_process_stopped_before_new_start(self):
        old_proc = _mock_popen()
        new_proc = _mock_popen()
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=old_proc):
            pub.start("vid-004", Path("/data/videos/vid-004.mp4"))
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=new_proc):
            pub.start("vid-004", Path("/data/videos/vid-004.mp4"))
        old_proc.terminate.assert_called_once()
        self.assertIs(pub._publishers["vid-004"], new_proc)


# ---------------------------------------------------------------------------
# stop()
# ---------------------------------------------------------------------------

class TestStop(unittest.TestCase):
    def setUp(self):
        _fresh_state()

    def test_terminates_running_process(self):
        proc = _mock_popen()
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            pub.start("vid-010", Path("/data/videos/vid-010.mp4"))
        pub.stop("vid-010")
        proc.terminate.assert_called_once()
        proc.wait.assert_called_once()
        self.assertNotIn("vid-010", pub._publishers)

    def test_stop_nonexistent_video_id_no_error(self):
        pub.stop("does-not-exist")  # should not raise

    def test_stop_already_exited_process(self):
        proc = _mock_popen(poll_return=0)  # already exited
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            pub.start("vid-011", Path("/data/videos/vid-011.mp4"))
        pub.stop("vid-011")
        # terminate should NOT be called if process already exited
        proc.terminate.assert_not_called()
        self.assertNotIn("vid-011", pub._publishers)


# ---------------------------------------------------------------------------
# is_alive()
# ---------------------------------------------------------------------------

class TestIsAlive(unittest.TestCase):
    def setUp(self):
        _fresh_state()

    def test_true_for_running_process(self):
        proc = _mock_popen(poll_return=None)
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            pub.start("vid-020", Path("/data/videos/vid-020.mp4"))
        self.assertTrue(pub.is_alive("vid-020"))

    def test_false_for_exited_process(self):
        proc = _mock_popen(poll_return=0)
        with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
            pub.start("vid-021", Path("/data/videos/vid-021.mp4"))
        self.assertFalse(pub.is_alive("vid-021"))

    def test_false_for_unknown_video_id(self):
        self.assertFalse(pub.is_alive("never-started"))


# ---------------------------------------------------------------------------
# Thread safety smoke test
# ---------------------------------------------------------------------------

class TestThreadSafety(unittest.TestCase):
    def setUp(self):
        _fresh_state()

    def test_concurrent_starts_do_not_corrupt_publishers(self):
        errors = []

        def _do_start(vid):
            try:
                proc = _mock_popen()
                with patch("backend.app.rtsp_publisher.subprocess.Popen", return_value=proc):
                    pub.start(vid, Path(f"/data/videos/{vid}.mp4"))
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=_do_start, args=(f"vid-t{i}",)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertEqual(len(pub._publishers), 10)


if __name__ == "__main__":
    unittest.main()

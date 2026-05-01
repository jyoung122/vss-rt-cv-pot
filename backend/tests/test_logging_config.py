import json
import logging
import ast
from pathlib import Path
import unittest

from backend.app.logging_config import (
    AimsJsonFormatter,
    AimsTextFormatter,
    log_context,
    new_request_id,
)


class LoggingConfigTests(unittest.TestCase):
    def test_json_formatter_emits_shared_envelope_and_context(self):
        formatter = AimsJsonFormatter()
        record = logging.LogRecord(
            name="backend.tests.logger",
            level=logging.INFO,
            pathname=__file__,
            lineno=12,
            msg="pipeline.run.complete",
            args=(),
            exc_info=None,
        )
        record.duration_ms = 123

        with log_context(request_id="req-test", run_id="run-test", video_id="vid-test"):
            payload = json.loads(formatter.format(record))

        self.assertEqual("pipeline.run.complete", payload["msg"])
        self.assertEqual("pipeline.run.complete", payload["body"])
        self.assertEqual("info", payload["level"])
        self.assertEqual("INFO", payload["severity_text"])
        self.assertEqual(payload["service"], payload["service.name"])
        self.assertEqual(payload["logger"], payload["logger.name"])
        self.assertEqual("vid-test", payload["video_id"])
        self.assertEqual("run-test", payload["run_id"])
        self.assertEqual("req-test", payload["request_id"])
        self.assertEqual(123, payload["duration_ms"])

    def test_text_formatter_smoke(self):
        formatter = AimsTextFormatter()
        record = logging.LogRecord(
            name="backend.tests.logger",
            level=logging.WARNING,
            pathname=__file__,
            lineno=35,
            msg="sdr.stream.register.degraded",
            args=(),
            exc_info=None,
        )

        line = formatter.format(record)

        self.assertIn("warning", line)
        self.assertIn("service=", line)
        self.assertIn("logger=backend.tests.logger", line)
        self.assertIn("msg=sdr.stream.register.degraded", line)

    def test_new_request_id_has_expected_prefix(self):
        request_id = new_request_id()

        self.assertTrue(request_id.startswith("req-"))
        self.assertGreater(len(request_id), len("req-"))

    def test_app_logging_extra_literals_do_not_use_reserved_log_record_keys(self):
        reserved = set(logging.makeLogRecord({}).__dict__)
        app_dir = Path(__file__).parents[1] / "app"
        offenders = []

        for path in app_dir.glob("*.py"):
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                for keyword in node.keywords:
                    if keyword.arg != "extra" or not isinstance(keyword.value, ast.Dict):
                        continue
                    for key_node in keyword.value.keys:
                        if isinstance(key_node, ast.Constant) and isinstance(key_node.value, str):
                            if key_node.value in reserved:
                                offenders.append(f"{path.name}:{key_node.lineno}:{key_node.value}")

        self.assertEqual([], offenders)


if __name__ == "__main__":
    unittest.main()

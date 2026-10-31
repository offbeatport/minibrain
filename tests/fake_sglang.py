import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STARTED = time.monotonic()
WARMUP_SECONDS = 0.5


def handler(log: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            warm = time.monotonic() - STARTED > WARMUP_SECONDS
            self.reply(200 if warm and self.path == "/health" else 503, {})

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with log.open("a") as out:
                out.write(json.dumps({"path": self.path, "body": body}) + "\n")
            if self.path == "/load_lora_adapter":
                self.reply(200, {"success": True})
                return
            text = f"{body.get('lora_path') or 'base'}:{body['messages'][-1]['content']}"
            choice = {"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
            self.reply(200, {"choices": [choice], "usage": {"prompt_tokens": 7, "completion_tokens": 2}})

        def log_message(self, format: str, *args: object) -> None:
            return

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), handler(args.log)).serve_forever()

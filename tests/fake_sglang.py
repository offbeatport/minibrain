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
            if self.path.endswith("/load_lora_adapter"):
                self.reply(200, {"success": True})
                return
            if "x-refuse" in json.dumps(body.get("response_format")):
                self.reply(400, {"object": "error", "message": "grammar compilation failed", "code": 400})
                return
            served = body.get("model") if body.get("model") != "qwen3-0.6b" else None
            if self.path == "/v1/completions":
                self.complete_text(body, f"{body.get('lora_path') or served or 'base'}:{body['prompt']}")
                return
            text = f"{body.get('lora_path') or served or 'base'}:{body['messages'][-1]['content']}"
            choice = {"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
            if (body.get("chat_template_kwargs") or {}).get("enable_thinking") or body.get("reasoning_effort"):
                choice["message"]["reasoning_content"] = f"thought:{body.get('reasoning_effort') or 'on'}"
            if body.get("tools") and body.get("tool_choice") != "none":
                name = body["tools"][0]["function"]["name"]
                call = {
                    "id": "call_fake",
                    "type": "function",
                    "function": {"name": name, "arguments": '{"city": "Paris"}'},
                }
                choice = {
                    "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                    "finish_reason": "tool_calls",
                }
            usage = {"prompt_tokens": 7, "completion_tokens": 2}
            if body.get("stream"):
                self.stream(choice, usage)
                return
            self.reply(200, {"choices": [choice], "usage": usage})

        def complete_text(self, body: dict, text: str) -> None:
            usage = {"prompt_tokens": 5, "completion_tokens": len(text)}
            if not body.get("stream"):
                self.reply(200, {"choices": [{"index": 0, "text": text, "finish_reason": "length"}], "usage": usage})
                return
            chunks = [{"choices": [{"index": 0, "text": char, "finish_reason": None}]} for char in text]
            chunks += [
                {"choices": [{"index": 0, "text": "", "finish_reason": "length"}]},
                {"choices": [], "usage": usage},
            ]
            self.send_events(chunks)

        def send_events(self, chunks: list) -> None:
            data = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data.encode())))
            self.end_headers()
            self.wfile.write(data.encode())

        def stream(self, choice: dict, usage: dict) -> None:
            message = choice["message"]
            deltas = [{"reasoning_content": message["reasoning_content"]}] if message.get("reasoning_content") else []
            deltas += [{"content": char} for char in message.get("content") or ""]
            for call in message.get("tool_calls") or []:
                function = call["function"]
                deltas.append({"tool_calls": [{"index": 0, "id": call["id"], "function": {"name": function["name"]}}]})
                arguments = function["arguments"]
                for part in (arguments[:5], arguments[5:]):
                    deltas.append({"tool_calls": [{"index": 0, "function": {"arguments": part}}]})
            chunks = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]} for delta in deltas]
            chunks += [{"choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}]}]
            chunks += [{"choices": [], "usage": usage}]
            self.send_events(chunks)

        def log_message(self, format: str, *args: object) -> None:
            return

    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), handler(args.log)).serve_forever()

import time

from openai import OpenAI

SAMPLE = "I ordered a card two weeks ago and it still hasn't arrived."


def main() -> None:
    client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="local")
    for model in client.models.list():
        started = time.perf_counter()
        response = client.chat.completions.create(
            model=model.id, messages=[{"role": "user", "content": SAMPLE}], max_tokens=32
        )
        milliseconds = (time.perf_counter() - started) * 1000
        print(f"{model.id:<14} {milliseconds:>7.0f} ms  {response.choices[0].message.content!r}")


if __name__ == "__main__":
    main()

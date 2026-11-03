import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

ACCESS_KEY = "AKIAFAKECONNECTION"
SECRET_KEY = "fake-s3-secret-for-tests-only"


@dataclass(frozen=True)
class FakeS3:
    endpoint: str
    client: Any

    def put(self, bucket: str, key: str, body: bytes) -> None:
        self.client.put_object(Bucket=bucket, Key=key, Body=body)

    def bucket(self, name: str) -> None:
        self.client.create_bucket(Bucket=name)


@contextmanager
def fake_s3() -> Iterator[FakeS3]:
    import boto3
    from moto.server import ThreadedMotoServer

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        region_name="us-east-1",
    )
    try:
        yield FakeS3(endpoint=endpoint, client=client)
    finally:
        server.stop()

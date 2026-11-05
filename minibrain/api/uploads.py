from collections.abc import AsyncIterator
from functools import partial

import anyio
from fastapi import Request

from minibrain.artifacts import ArtifactStore, Stored, StreamReader


def body_reader(request: Request) -> StreamReader:
    chunks: AsyncIterator[bytes] = request.stream().__aiter__()

    async def following() -> bytes | None:
        return await anext(chunks, None)

    return StreamReader(iter(partial(anyio.from_thread.run, following), None))


async def store_body(store: ArtifactStore, request: Request, expected: str, replace: bool = False) -> Stored:
    return await anyio.to_thread.run_sync(store.put_stream, body_reader(request), expected, replace)

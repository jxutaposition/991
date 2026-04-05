"""Batch embedding using OpenAI text-embedding-3-small."""

from __future__ import annotations

import os

from openai import OpenAI

MODEL = "text-embedding-3-small"
BATCH_SIZE = 100  # OpenAI supports up to 2048 inputs per call


def get_client() -> OpenAI:
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts, returning one 1536-dim vector per input."""
    client = get_client()
    all_embeddings: list[list[float]] = []

    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        resp = client.embeddings.create(model=MODEL, input=batch)
        for item in resp.data:
            all_embeddings.append(item.embedding)

    return all_embeddings

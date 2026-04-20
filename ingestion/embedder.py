"""Batch embedding without OpenAI.

For local/dev use when an OpenAI API key is not available. Generates
1536-dim zero vectors so the ingestion pipeline can run without calling
external embedding providers. Vector search quality will be poor, but
full-text search via `search_vector` still works.
"""

from __future__ import annotations

from typing import List


EMBED_DIM = 1536


def embed_batch(texts: List[str]) -> List[List[float]]:
    """Return one 1536-dim dummy vector per input text."""
    return [[0.0] * EMBED_DIM for _ in texts]

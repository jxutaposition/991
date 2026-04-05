"""Header-aware markdown chunking for the knowledge corpus.

Strategy: split on ## and ### headers first to respect document structure,
then recursively split oversized sections on paragraph boundaries.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from langchain_text_splitters import (
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)


@dataclass
class Chunk:
    content: str
    section_title: str
    chunk_index: int
    token_count: int


def _estimate_tokens(text: str) -> int:
    """Rough token count: ~4 chars per token for English text."""
    return max(1, len(text) // 4)


def chunk_markdown(
    markdown: str,
    *,
    max_chunk_tokens: int = 500,
    chunk_overlap_tokens: int = 50,
) -> list[Chunk]:
    """Split markdown into semantically meaningful chunks.

    1. Split on ## and ### headers to respect document structure.
    2. For sections exceeding max_chunk_tokens, split on paragraph boundaries.
    """
    if not markdown or not markdown.strip():
        return []

    header_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[("##", "section"), ("###", "subsection")],
        strip_headers=False,
    )
    header_docs = header_splitter.split_text(markdown)

    char_splitter = RecursiveCharacterTextSplitter(
        chunk_size=max_chunk_tokens * 4,
        chunk_overlap=chunk_overlap_tokens * 4,
        separators=["\n\n", "\n", ". ", " "],
    )

    chunks: list[Chunk] = []
    idx = 0

    for doc in header_docs:
        section = doc.metadata.get("subsection") or doc.metadata.get("section") or ""
        text = doc.page_content.strip()
        if not text:
            continue

        if _estimate_tokens(text) <= max_chunk_tokens:
            chunks.append(Chunk(
                content=text,
                section_title=section,
                chunk_index=idx,
                token_count=_estimate_tokens(text),
            ))
            idx += 1
        else:
            sub_docs = char_splitter.split_text(text)
            for sub in sub_docs:
                sub = sub.strip()
                if not sub:
                    continue
                chunks.append(Chunk(
                    content=sub,
                    section_title=section,
                    chunk_index=idx,
                    token_count=_estimate_tokens(sub),
                ))
                idx += 1

    return chunks


def chunk_transcript(
    text: str,
    *,
    max_chunk_tokens: int = 400,
    min_merge_tokens: int = 100,
) -> list[Chunk]:
    """Split a speaker-turn transcript into chunks.

    Splits on speaker-change lines (e.g. "Speaker Name:" or "**Speaker**:"),
    merges adjacent small turns.
    """
    speaker_pattern = re.compile(r"^(?:\*\*)?[\w\s]+(?:\*\*)?:\s", re.MULTILINE)
    turns = speaker_pattern.split(text)
    speakers = speaker_pattern.findall(text)

    if not turns or len(turns) <= 1:
        return chunk_markdown(text, max_chunk_tokens=max_chunk_tokens)

    chunks: list[Chunk] = []
    buffer = ""
    idx = 0

    for i, turn in enumerate(turns[1:], start=0):
        speaker = speakers[i].strip() if i < len(speakers) else ""
        line = f"{speaker} {turn.strip()}"

        if _estimate_tokens(buffer + line) > max_chunk_tokens and buffer:
            chunks.append(Chunk(
                content=buffer.strip(),
                section_title="",
                chunk_index=idx,
                token_count=_estimate_tokens(buffer),
            ))
            idx += 1
            buffer = line + "\n"
        else:
            buffer += line + "\n"

    if buffer.strip():
        chunks.append(Chunk(
            content=buffer.strip(),
            section_title="",
            chunk_index=idx,
            token_count=_estimate_tokens(buffer),
        ))

    return chunks

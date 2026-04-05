"""Knowledge ingestion worker.

Polls the knowledge_documents table for pending documents, processes them
through the Docling → chunk → embed → store pipeline, and marks them ready.

Supports both text files (content in normalized_markdown) and binary files
(base64-encoded content in raw_content) including PDF, DOCX, PPTX, XLSX.
ZIP archives are extracted and each file is processed individually.

Runs as a standalone Python process alongside the Rust backend.
Communication is through the shared Postgres database.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import psycopg2
import psycopg2.extras

import anthropic

from chunker import Chunk, chunk_markdown, chunk_transcript
from converters import convert_to_markdown
from embedder import embed_batch

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("ingestion-worker")

POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
DATABASE_URL = os.environ["DATABASE_URL"]

_oai_key = os.environ.get("OPENAI_API_KEY", "")
if not _oai_key:
    raise SystemExit("OPENAI_API_KEY not set — cannot start worker")
logging.getLogger("ingestion-worker").info("OPENAI_API_KEY loaded (%s...)", _oai_key[:12])

_anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
if not _anthropic_key:
    log.warning("ANTHROPIC_API_KEY not set — contextual retrieval prefixes will be skipped")
CONTEXTUAL_RETRIEVAL_ENABLED = bool(_anthropic_key)
CONTEXTUAL_MODEL = "claude-3-5-haiku-latest"
CONTEXT_PREFIX_MAX_DOC_CHARS = 8000

# File extensions supported by Docling
DOCLING_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".doc", ".html", ".htm"}

# File extensions we can handle as plain text
TEXT_EXTENSIONS = {".md", ".txt", ".csv", ".json", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log", ".tsv"}

# Extensions to skip inside zip archives (images, binaries, etc.)
SKIP_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".mp3", ".mp4", ".avi", ".mov", ".wav", ".exe", ".dll", ".so", ".dylib", ".pyc", ".class", ".o", ".woff", ".woff2", ".ttf", ".eot"}


def get_db():
    return psycopg2.connect(DATABASE_URL)


def claim_pending_document(conn) -> dict | None:
    """Atomically claim the next pending document for processing."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            UPDATE knowledge_documents
            SET status = 'processing', updated_at = NOW()
            WHERE id = (
                SELECT id FROM knowledge_documents
                WHERE status = 'pending'
                ORDER BY created_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        """)
        row = cur.fetchone()
        conn.commit()
        return dict(row) if row else None


def parse_to_markdown(doc: dict) -> str:
    """Convert the document to markdown.

    For text files, normalized_markdown is already set at upload time.
    For binary files, raw_content contains base64-encoded data → decode → Docling.
    """
    # Text file: already have markdown
    if doc.get("normalized_markdown"):
        return doc["normalized_markdown"]

    mime = doc.get("mime_type", "")
    if mime == "text/markdown" or doc["source_filename"].endswith(".md"):
        return doc.get("normalized_markdown") or ""

    # Binary file: decode from base64 and convert via Docling
    raw = doc.get("raw_content")
    if raw:
        return convert_binary_to_markdown(raw, doc["source_filename"], mime)

    return ""


def convert_binary_to_markdown(base64_content: str, filename: str, mime: str) -> str:
    """Decode base64 binary content, write to temp file, convert with Docling."""
    try:
        binary_data = base64.b64decode(base64_content)
    except Exception as e:
        log.warning("Failed to decode base64 content for %s: %s", filename, e)
        return ""

    ext = Path(filename).suffix.lower()

    # Plain text files that were uploaded as binary
    if ext in TEXT_EXTENSIONS:
        try:
            return binary_data.decode("utf-8")
        except UnicodeDecodeError:
            return binary_data.decode("latin-1", errors="replace")

    # Use Docling for document conversion
    if ext in DOCLING_EXTENSIONS:
        return _docling_convert(binary_data, filename)

    log.warning("Unsupported file extension %s for %s, attempting text decode", ext, filename)
    try:
        return binary_data.decode("utf-8")
    except UnicodeDecodeError:
        return f"[Binary file: {filename} ({len(binary_data)} bytes) — format not supported for text extraction]"


def _docling_convert(binary_data: bytes, filename: str) -> str:
    """Convert binary document to markdown using Docling."""
    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        log.error("Docling not installed. Install with: pip install docling")
        return f"[Docling not available — cannot convert {filename}]"

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False) as tmp:
        tmp.write(binary_data)
        tmp_path = tmp.name

    try:
        converter = DocumentConverter()
        result = converter.convert(tmp_path)
        markdown = result.document.export_to_markdown()
        log.info("Docling converted %s: %d chars of markdown", filename, len(markdown))
        return markdown
    except Exception as e:
        log.warning("Docling conversion failed for %s: %s", filename, e)
        return f"[Conversion failed for {filename}: {e}]"
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def handle_zip_archive(conn, doc: dict) -> int:
    """Extract a zip archive and create child documents for each supported file.

    Returns the number of child documents created.
    """
    raw = doc.get("raw_content")
    if not raw:
        return 0

    try:
        binary_data = base64.b64decode(raw)
    except Exception as e:
        log.warning("Failed to decode zip base64 for %s: %s", doc["source_filename"], e)
        return 0

    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp.write(binary_data)
        tmp_path = tmp.name

    count = 0
    try:
        with zipfile.ZipFile(tmp_path, "r") as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue

                ext = Path(info.filename).suffix.lower()
                if ext in SKIP_EXTENSIONS:
                    log.debug("Skipping unsupported file in zip: %s", info.filename)
                    continue

                # Skip hidden files and __MACOSX
                if info.filename.startswith("__MACOSX") or "/." in info.filename:
                    continue

                file_data = zf.read(info.filename)
                if not file_data:
                    continue

                # Determine if this is text or binary
                is_text_file = ext in TEXT_EXTENSIONS
                base_path = doc.get("source_folder", "")
                child_path = f"{base_path}/{info.filename}".strip("/")

                child_id = str(uuid.uuid4())
                encoded = base64.b64encode(file_data).decode("ascii")

                # Detect mime type
                mime = _guess_mime(ext)

                # For text files, try to decode directly as normalized_markdown
                normalized_md = None
                raw_content = None
                if is_text_file:
                    try:
                        normalized_md = file_data.decode("utf-8")
                    except UnicodeDecodeError:
                        normalized_md = file_data.decode("latin-1", errors="replace")
                else:
                    raw_content = encoded

                child_filename = Path(info.filename).name
                child_folder = str(Path(child_path).parent) if "/" in child_path else ""

                with conn.cursor() as cur:
                    cur.execute(
                        """INSERT INTO knowledge_documents
                           (id, tenant_id, project_id, expert_id, source_filename,
                            source_path, source_folder, mime_type, storage_key,
                            file_hash, normalized_markdown, raw_content,
                            file_size_bytes, parent_document_id,
                            inferred_scope, inferred_scope_id, status)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')""",
                        (
                            child_id,
                            doc["tenant_id"],
                            doc.get("project_id"),
                            doc.get("expert_id"),
                            child_filename,
                            child_path,
                            child_folder,
                            mime,
                            f"knowledge/{child_id}",
                            "",  # file_hash computed later
                            normalized_md,
                            raw_content,
                            len(file_data),
                            doc["id"],  # parent_document_id
                            doc.get("inferred_scope"),
                            doc.get("inferred_scope_id"),
                        ),
                    )
                    count += 1

            conn.commit()
            log.info("Extracted %d files from zip %s", count, doc["source_filename"])

    except zipfile.BadZipFile:
        log.warning("Invalid zip file: %s", doc["source_filename"])
    except Exception as e:
        log.exception("Failed to extract zip %s: %s", doc["source_filename"], e)
        conn.rollback()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    return count


def _guess_mime(ext: str) -> str:
    """Guess MIME type from file extension."""
    mime_map = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".doc": "application/msword",
        ".xls": "application/vnd.ms-excel",
        ".ppt": "application/vnd.ms-powerpoint",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".html": "text/html",
        ".htm": "text/html",
        ".json": "application/json",
        ".xml": "text/xml",
        ".yaml": "text/yaml",
        ".yml": "text/yaml",
    }
    return mime_map.get(ext, "application/octet-stream")


def choose_chunker(doc: dict) -> str:
    """Determine chunking strategy based on content type."""
    path = doc.get("source_path", "").lower()
    filename = doc.get("source_filename", "").lower()

    if "transcript" in path or "transcript" in filename:
        return "transcript"
    return "markdown"


def generate_context_prefixes(
    doc: dict,
    chunks: list[Chunk],
    markdown: str,
) -> list[str]:
    """Use Claude to generate contextual retrieval prefixes for each chunk.

    Sends the document context (filename, path, first N chars of markdown) plus
    each chunk to Claude. Returns a context prefix per chunk that anchors it to
    its source document. Uses prompt caching so the document context is only
    billed once across all chunks.

    Returns empty strings for all chunks if contextual retrieval is disabled
    or if the Claude call fails.
    """
    if not CONTEXTUAL_RETRIEVAL_ENABLED:
        return [""] * len(chunks)

    doc_context = markdown[:CONTEXT_PREFIX_MAX_DOC_CHARS]
    source_info = (
        f"Filename: {doc.get('source_filename', 'unknown')}\n"
        f"Path: {doc.get('source_path', 'unknown')}\n"
        f"Scope: {doc.get('inferred_scope', 'unknown')}"
    )

    try:
        client = anthropic.Anthropic(api_key=_anthropic_key)
        prefixes: list[str] = []

        # Build all chunk texts for a single batched prompt
        chunk_list_text = ""
        for i, chunk in enumerate(chunks):
            preview = chunk.content[:600]
            chunk_list_text += f"\n[CHUNK {i}]\n{preview}\n"

        response = client.messages.create(
            model=CONTEXTUAL_MODEL,
            max_tokens=4096,
            system=[{
                "type": "text",
                "text": (
                    "You generate short context prefixes for document chunks to improve "
                    "search retrieval. For each chunk, write a 1-2 sentence prefix that "
                    "identifies the source document, its topic, and the specific section. "
                    "The prefix should help a search engine understand what the chunk is "
                    "about even in isolation.\n\n"
                    "Output one prefix per line, in order, prefixed with the chunk number: "
                    "0: <prefix>\n1: <prefix>\netc."
                ),
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{
                "role": "user",
                "content": (
                    f"Document metadata:\n{source_info}\n\n"
                    f"Document content (first {CONTEXT_PREFIX_MAX_DOC_CHARS} chars):\n"
                    f"{doc_context}\n\n"
                    f"Generate a context prefix for each of these {len(chunks)} chunks:"
                    f"{chunk_list_text}"
                ),
            }],
        )

        # Parse the response: expect lines like "0: prefix text"
        response_text = response.content[0].text
        prefix_map: dict[int, str] = {}
        for line in response_text.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            if ":" in line and line.split(":")[0].strip().isdigit():
                idx_str, prefix = line.split(":", 1)
                prefix_map[int(idx_str.strip())] = prefix.strip()

        for i in range(len(chunks)):
            prefixes.append(prefix_map.get(i, ""))

        generated = sum(1 for p in prefixes if p)
        log.info("  Generated %d/%d context prefixes", generated, len(chunks))
        return prefixes

    except Exception as e:
        log.warning("Context prefix generation failed: %s — proceeding without prefixes", e)
        return [""] * len(chunks)


def process_document(conn, doc: dict) -> None:
    """Full pipeline: parse → chunk → embed → store.

    All DB writes (chunks + status update) happen in a single transaction
    so we never get partial state on failure.
    """
    doc_id = doc["id"]
    mime = doc.get("mime_type", "")
    log.info("Processing document %s (%s) [%s]", doc_id, doc.get("source_path"), mime)

    try:
        # Handle zip archives: extract contents as child documents
        if mime in ("application/zip", "application/x-zip-compressed") or doc["source_filename"].endswith(".zip"):
            child_count = handle_zip_archive(conn, doc)
            # Mark the zip itself as ready (it's a container, not content)
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE knowledge_documents SET status = 'ready', chunk_count = %s, "
                    "normalized_markdown = %s, updated_at = NOW() WHERE id = %s",
                    (child_count, f"[ZIP archive: {child_count} files extracted]", doc_id),
                )
                conn.commit()
            log.info("  ZIP %s processed: %d child documents created", doc_id, child_count)
            return

        markdown = parse_to_markdown(doc)
        if not markdown.strip():
            mark_error(conn, doc_id, "Empty content after parsing")
            return

        # Convert structured formats (JSON, CSV, YAML, etc.) to readable markdown
        # before chunking. This ensures that ALL files — regardless of original
        # format — produce semantically meaningful chunks.
        filename = doc.get("source_filename", "")
        original_len = len(markdown)
        markdown = convert_to_markdown(markdown, filename)
        if len(markdown) != original_len:
            log.info("  Converted %s (%d → %d chars)", filename, original_len, len(markdown))

        strategy = choose_chunker(doc)
        if strategy == "transcript":
            chunks = chunk_transcript(markdown)
        else:
            chunks = chunk_markdown(markdown)

        if not chunks:
            mark_error(conn, doc_id, "No chunks produced")
            return

        log.info("  %d chunks produced, generating context prefixes...", len(chunks))
        context_prefixes = generate_context_prefixes(doc, chunks, markdown)

        # Prepend context prefix to chunk content before embedding so the
        # embedding vector carries document-level meaning (Anthropic's
        # contextual retrieval technique).
        texts_for_embedding = []
        for chunk, prefix in zip(chunks, context_prefixes):
            if prefix:
                texts_for_embedding.append(f"{prefix} {chunk.content}")
            else:
                texts_for_embedding.append(chunk.content)

        log.info("  Embedding %d chunks...", len(chunks))
        embeddings = embed_batch(texts_for_embedding)

        store_chunks_and_mark_ready(conn, doc, chunks, embeddings, markdown, context_prefixes)
        log.info("  Document %s ready (%d chunks)", doc_id, len(chunks))

    except Exception as e:
        log.exception("Failed to process document %s", doc_id)
        try:
            conn.rollback()
            mark_error(conn, doc_id, str(e))
        except Exception:
            log.exception("Failed to mark document %s as error", doc_id)


def store_chunks_and_mark_ready(
    conn,
    doc: dict,
    chunks: list[Chunk],
    embeddings: list[list[float]],
    markdown: str,
    context_prefixes: list[str] | None = None,
) -> None:
    """Write chunks + mark document ready in a single atomic transaction."""
    if context_prefixes is None:
        context_prefixes = [""] * len(chunks)

    with conn.cursor() as cur:
        for chunk, embedding, prefix in zip(chunks, embeddings, context_prefixes):
            embedding_str = "[" + ",".join(str(f) for f in embedding) + "]"
            metadata = json.dumps({
                "section_title": chunk.section_title,
                "source_filename": doc["source_filename"],
            })
            # Combine prefix + content for the tsvector so BM25 search
            # benefits from the contextual prefix just like vector search does.
            fts_text = f"{prefix} {chunk.content}" if prefix else chunk.content
            cur.execute(
                """INSERT INTO knowledge_chunks
                   (document_id, tenant_id, project_id, content, section_title,
                    chunk_index, token_count, embedding, metadata,
                    context_prefix, search_vector)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector, %s::jsonb,
                           %s, to_tsvector('english', %s))""",
                (
                    doc["id"],
                    doc["tenant_id"],
                    doc.get("project_id"),
                    chunk.content,
                    chunk.section_title or None,
                    chunk.chunk_index,
                    chunk.token_count,
                    embedding_str,
                    metadata,
                    prefix or None,
                    fts_text,
                ),
            )
        cur.execute(
            """UPDATE knowledge_documents
               SET status = 'ready', chunk_count = %s,
                   normalized_markdown = %s, updated_at = NOW()
               WHERE id = %s""",
            (len(chunks), markdown, doc["id"]),
        )
        conn.commit()


def mark_error(conn, doc_id: str, error_msg: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE knowledge_documents
               SET status = 'error', error_message = %s, updated_at = NOW()
               WHERE id = %s""",
            (error_msg[:2000], doc_id),
        )
        conn.commit()


def recover_stuck_documents(conn) -> int:
    """Reset documents stuck in 'processing' for over 10 minutes back to 'pending'."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE knowledge_documents
            SET status = 'pending', updated_at = NOW()
            WHERE status = 'processing'
              AND updated_at < NOW() - INTERVAL '10 minutes'
        """)
        count = cur.rowcount
        conn.commit()
        return count


def main() -> None:
    log.info("Knowledge ingestion worker starting (poll interval: %ds)", POLL_INTERVAL)
    conn = get_db()

    recovered = recover_stuck_documents(conn)
    if recovered > 0:
        log.info("Recovered %d stuck documents", recovered)

    while True:
        try:
            doc = claim_pending_document(conn)
            if doc:
                process_document(conn, doc)
            else:
                time.sleep(POLL_INTERVAL)
        except psycopg2.OperationalError:
            log.warning("DB connection lost, reconnecting...")
            time.sleep(2)
            try:
                conn = get_db()
            except Exception:
                log.exception("Reconnect failed")
                time.sleep(10)
        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception:
            log.exception("Unexpected error in worker loop")
            time.sleep(5)

    conn.close()


if __name__ == "__main__":
    main()

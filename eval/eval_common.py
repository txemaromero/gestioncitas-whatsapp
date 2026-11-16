"""Shared helpers for the evaluation scripts (stdlib only).

Everything here must stay importable without third-party packages so that
``--dry-run`` and the "missing API key" path work on any Python >= 3.10.
"""

from __future__ import annotations

import csv
import hashlib
import http.client
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence, TypeVar

# Paths are resolved from this file, never from the current working directory.
EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parent
DATA_DIR = EVAL_DIR / "data"
RESULTS_DIR = EVAL_DIR / "results"

INTENT_PROMPT_PATH = REPO_ROOT / "apps" / "bot" / "src" / "prompts" / "intent.txt"
FAQ_GUARD_PATH = REPO_ROOT / "apps" / "bot" / "src" / "prompts" / "faq-guard.txt"
FAQ_KNOWLEDGE_PATH = (
    REPO_ROOT / "packages" / "db" / "prisma" / "seed-data" / "fisiodemo-faq.txt"
)

DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BASE_URL = "https://api.openai.com/v1"

MISSING_KEY_MESSAGE = (
    "[eval] OPENAI_API_KEY no está definida: se omite la evaluación "
    "(salida 0, no es un error).\n"
    "       Defínela como variable de entorno o en eval/.env (o en el .env de la "
    "raíz del repositorio)\n"
    "       para ejecutar la evaluación real. Para validar solo el dataset y el "
    "prompt usa --dry-run."
)

T = TypeVar("T")
R = TypeVar("R")


def setup_console() -> None:
    """Make Spanish output safe on Windows.

    Interactive consoles already handle Unicode; when output is piped or
    redirected (CI logs, Git Bash, files) Python < 3.15 on Windows defaults to
    the ANSI code page, so switch to UTF-8 there. Never crash on encoding.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError, OSError):
            pass


def load_env() -> None:
    """Load eval/.env and <repo>/.env if python-dotenv is installed.

    Real environment variables always win; eval/.env wins over the root .env.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    for env_file in (EVAL_DIR / ".env", REPO_ROOT / ".env"):
        if env_file.is_file():
            load_dotenv(env_file, override=False)


@dataclass(frozen=True)
class OpenAISettings:
    api_key: str | None
    model: str
    base_url: str

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)


def get_settings() -> OpenAISettings:
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip() or None
    model = (os.environ.get("OPENAI_MODEL") or "").strip() or DEFAULT_MODEL
    base_url = (os.environ.get("OPENAI_BASE_URL") or "").strip() or DEFAULT_BASE_URL
    return OpenAISettings(api_key=api_key, model=model, base_url=base_url.rstrip("/"))


def read_text(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"No se encuentra el fichero: {path}")
    return path.read_text(encoding="utf-8")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_dataset(path: Path, required: Sequence[str] = ("question", "ground_truth")) -> list[dict[str, str]]:
    """Read a UTF-8 CSV and validate columns and non-empty values."""
    if not path.is_file():
        raise FileNotFoundError(f"No se encuentra el dataset: {path}")
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in required if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"{path.name}: faltan columnas {missing} (cabecera: {reader.fieldnames})")
        rows: list[dict[str, str]] = []
        for line_no, row in enumerate(reader, start=2):
            clean = {k: (row.get(k) or "").strip() for k in required}
            empty = [k for k, v in clean.items() if not v]
            if empty:
                raise ValueError(f"{path.name}:{line_no}: valores vacíos en {empty}")
            rows.append(clean)
    if not rows:
        raise ValueError(f"{path.name}: el dataset está vacío")
    return rows


# --------------------------------------------------------------------------- #
# OpenAI Chat Completions client (urllib, with retries and backoff)
# --------------------------------------------------------------------------- #

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class OpenAIError(RuntimeError):
    pass


def _retry_after_seconds(err: urllib.error.HTTPError) -> float | None:
    headers = err.headers or {}
    for name in ("retry-after-ms", "Retry-After-Ms"):
        value = headers.get(name)
        if value:
            try:
                return float(value) / 1000.0
            except ValueError:
                pass
    value = headers.get("Retry-After")
    if value:
        try:
            return float(value)
        except ValueError:
            return None
    return None


def chat_completion(
    settings: OpenAISettings,
    messages: list[dict[str, str]],
    temperature: float,
    *,
    max_retries: int = 6,
    timeout: float = 60.0,
) -> tuple[str, dict[str, Any]]:
    """POST /chat/completions and return (content, usage).

    Retries on 408/409/429/5xx and network errors with exponential backoff and
    jitter, honouring ``Retry-After`` when the server sends it.
    """
    if not settings.api_key:
        raise OpenAIError("OPENAI_API_KEY no definida")
    url = f"{settings.base_url}/chat/completions"
    body = json.dumps(
        {"model": settings.model, "messages": messages, "temperature": temperature}
    ).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {settings.api_key}",
        "Content-Type": "application/json",
    }

    attempt = 0
    while True:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            content = payload["choices"][0]["message"].get("content") or ""
            return content, payload.get("usage") or {}
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read().decode("utf-8", errors="replace")[:500]
            except Exception:  # noqa: BLE001 - best effort diagnostics only
                pass
            if err.code not in RETRYABLE_STATUS or attempt >= max_retries:
                raise OpenAIError(f"HTTP {err.code} en {url}: {detail}") from err
            wait = _retry_after_seconds(err)
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError) as err:
            if attempt >= max_retries:
                raise OpenAIError(f"Error de red en {url}: {err}") from err
            wait = None
        except (KeyError, IndexError, json.JSONDecodeError) as err:
            raise OpenAIError(f"Respuesta inesperada de {url}: {err}") from err

        backoff = min(60.0, (2 ** attempt)) + random.uniform(0, 1)
        time.sleep(max(wait or 0.0, backoff))
        attempt += 1


def parallel_map(fn: Callable[[T], R], items: Iterable[T], concurrency: int) -> list[R]:
    """Order-preserving map with a small thread pool (concurrency=1 is sequential)."""
    items = list(items)
    if concurrency <= 1:
        return [fn(item) for item in items]
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        return list(pool.map(fn, items))


def add_usage(total: dict[str, int], usage: dict[str, Any]) -> None:
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, int):
            total[key] = total.get(key, 0) + value


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #


def run_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d_%H%M%S")


def write_results(stamp: str, kind: str, data: dict[str, Any], markdown: str) -> tuple[Path, Path]:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    json_path = RESULTS_DIR / f"{stamp}_{kind}.json"
    md_path = RESULTS_DIR / f"{stamp}_{kind}.md"
    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(markdown, encoding="utf-8")
    write_github_summary(markdown)
    return json_path, md_path


def write_github_summary(markdown: str) -> None:
    """In GitHub Actions, also shows the report on the run's summary page (GITHUB_STEP_SUMMARY)."""
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary:
        return
    with open(summary, "a", encoding="utf-8") as handle:
        handle.write(markdown.rstrip("\n") + "\n\n")


def strict_exit(strict: bool, passed: bool, reason: str) -> int:
    """Exit code: 0 always measures; with --strict (CI) a failed objective is an error."""
    if strict and not passed:
        print(f"[eval] --strict: {reason} → código de salida 1")
        return 1
    return 0


def md_escape(text: str) -> str:
    """Make a value safe inside a Markdown table cell."""
    return str(text).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)

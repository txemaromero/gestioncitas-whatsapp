"""FAQ answer evaluation with Ragas (answer_relevancy, answer_correctness).

1. Generates each answer with the production call: system prompt =
   ``fisiodemo-faq.txt`` + "\\n\\n" + ``faq-guard.txt``, user = question,
   temperature 0.3.
2. Scores every answer with the Ragas 0.4 "collections" metrics
   ``AnswerRelevancy`` and ``AnswerCorrectness`` (LLM judge + embeddings).

Heavy dependencies (ragas, openai, langchain) are imported lazily, so
``--dry-run`` and the "missing API key" path only need the standard library.

Usage:
    python eval/eval_faq.py [--limit N] [--dry-run] [--concurrency K]
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import math
import os
import sys
import threading
import time
from typing import Any

import eval_common as common

TEMPERATURE = 0.3
METRICS = ("answer_relevancy", "answer_correctness")
TARGETS = {"answer_relevancy": 0.75, "answer_correctness": 0.75}
# --strict: at least 90 % of the rows must be scored for the mean to count.
MIN_SCORED_SHARE = 0.9
REFERENCE_RESULTS = {"answer_relevancy": 0.75, "answer_correctness": 0.77}
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DATASET_PATH = common.DATA_DIR / "faq.csv"
# Packages needed only for the real Ragas run (checked without importing them).
RAGAS_MODULES = ("ragas", "openai", "langchain_openai", "langchain_community")


class DependencyError(RuntimeError):
    pass


def build_system_prompt(knowledge: str, guard: str) -> str:
    return knowledge + "\n\n" + guard


def build_messages(system_prompt: str, question: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": question},
    ]


def missing_modules() -> list[str]:
    return [name for name in RAGAS_MODULES if importlib.util.find_spec(name) is None]


def judge_models(settings: common.OpenAISettings) -> tuple[str, str]:
    llm = (os.environ.get("RAGAS_LLM_MODEL") or "").strip() or settings.model
    embeddings = (os.environ.get("RAGAS_EMBEDDING_MODEL") or "").strip() or DEFAULT_EMBEDDING_MODEL
    return llm, embeddings


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evalúa las respuestas FAQ con Ragas.")
    parser.add_argument("--limit", type=int, default=None, help="Evalúa solo las N primeras filas.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Valida dataset y prompts sin llamar a la API ni importar Ragas.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "Termina con código 1 si no se alcanza el objetivo o si quedan sin puntuar más del 10 %% "
            "de las filas (para la CI)."
        ),
    )
    parser.add_argument(
        "--concurrency", type=int, default=4, help="Peticiones simultáneas (por defecto 4; 1 = secuencial)."
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit debe ser >= 1")
    if args.concurrency < 1:
        parser.error("--concurrency debe ser >= 1")
    return args


# --------------------------------------------------------------------------- #
# Ragas scoring (lazy imports)
# --------------------------------------------------------------------------- #


def _load_ragas() -> tuple[Any, Any, Any, Any, Any]:
    # Opt out of Ragas usage telemetry unless the user decided otherwise.
    os.environ.setdefault("RAGAS_DO_NOT_TRACK", "true")
    try:
        from openai import AsyncOpenAI
        from ragas.embeddings.base import embedding_factory
        from ragas.llms import llm_factory
        from ragas.metrics.collections import AnswerCorrectness, AnswerRelevancy
    except ImportError as err:
        raise DependencyError(str(err)) from err
    return AsyncOpenAI, llm_factory, embedding_factory, AnswerRelevancy, AnswerCorrectness


async def score_items(
    items: list[dict[str, Any]],
    settings: common.OpenAISettings,
    llm_model: str,
    embedding_model: str,
    concurrency: int,
) -> list[tuple[dict[str, float | None], dict[str, str]]]:
    AsyncOpenAI, llm_factory, embedding_factory, AnswerRelevancy, AnswerCorrectness = _load_ragas()

    # The openai SDK retries 408/409/429/5xx and connection errors with backoff.
    client = AsyncOpenAI(
        api_key=settings.api_key, base_url=settings.base_url, max_retries=6, timeout=120.0
    )
    try:
        llm = llm_factory(llm_model, client=client)
        embeddings = embedding_factory(
            "openai", model=embedding_model, client=client, interface="modern"
        )
        relevancy = AnswerRelevancy(llm=llm, embeddings=embeddings)
        correctness = AnswerCorrectness(llm=llm, embeddings=embeddings)
        semaphore = asyncio.Semaphore(concurrency)

        async def score_one(item: dict[str, Any]) -> tuple[dict[str, float | None], dict[str, str]]:
            scores: dict[str, float | None] = {name: None for name in METRICS}
            errors: dict[str, str] = {}
            if not item["answer"]:
                errors["generation"] = item.get("error") or "respuesta vacía"
                return scores, errors
            jobs = (
                ("answer_relevancy", relevancy, {"user_input": item["question"], "response": item["answer"]}),
                (
                    "answer_correctness",
                    correctness,
                    {
                        "user_input": item["question"],
                        "response": item["answer"],
                        "reference": item["ground_truth"],
                    },
                ),
            )
            async with semaphore:
                for name, metric, kwargs in jobs:
                    try:
                        result = await metric.ascore(**kwargs)
                        value = float(result.value)
                        scores[name] = None if math.isnan(value) else value
                    except Exception as err:  # noqa: BLE001 - keep evaluating other rows
                        errors[name] = f"{type(err).__name__}: {err}"[:500]
            return scores, errors

        return list(await asyncio.gather(*(score_one(item) for item in items)))
    finally:
        await client.close()


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #


def _fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.3f}"


def build_markdown(result: dict[str, Any]) -> str:
    lines = [
        f"# Evaluación FAQ (Ragas) — {result['timestamp']}",
        "",
        f"- Modelo evaluado: `{result['model']}` (temperature {result['temperature']})",
        f"- Juez Ragas: `{result['ragas']['llm_model']}` · embeddings `{result['ragas']['embedding_model']}`"
        f" · ragas {result['ragas']['version']}",
        f"- Dataset: `{result['dataset']}` ({result['n']} filas)",
        f"- Prompt: `{result['prompt']['knowledge']}` + `{result['prompt']['guard']}`"
        f" (sha256 `{result['prompt']['sha256'][:12]}`)",
        f"- Errores de generación: {result['generation_errors']} · errores de métricas: {result['metric_errors']}",
        f"- Duración: {result['elapsed_seconds']} s",
        f"- **Resultado global: {'PASS' if result['passed'] else 'FAIL'}**",
        "",
        "| Métrica | Media | Objetivo | Referencia | Filas puntuadas | Estado |",
        "|---|---|---|---|---|---|",
    ]
    for name in METRICS:
        m = result["metrics"][name]
        lines.append(
            f"| `{name}` | **{_fmt(m['mean'])}** | ≥ {m['target']:.2f} | {m['reference']:.2f} | "
            f"{m['scored']}/{result['n']} | {'PASS' if m['passed'] else 'FAIL'} |"
        )
    lines += [
        "",
        "## Respuestas por pregunta",
        "",
        "| # | Pregunta | Respuesta generada | Relevancy | Correctness |",
        "|---|---|---|---|---|",
    ]
    for row in result["rows"]:
        lines.append(
            f"| {row['row']} | {common.md_escape(row['question'])} | {common.md_escape(row['answer'] or '(sin respuesta)')} | "
            f"{_fmt(row['answer_relevancy'])} | {_fmt(row['answer_correctness'])} |"
        )
    failed = [r for r in result["rows"] if r["errors"]]
    if failed:
        lines += ["", "## Errores", ""]
        for row in failed:
            for stage, message in row["errors"].items():
                lines.append(f"- Fila {row['row']} ({stage}): {common.md_escape(message)}")
    lines += ["", "## Referencia esperada", "", "| # | Pregunta | Respuesta de referencia |", "|---|---|---|"]
    for row in result["rows"]:
        lines.append(f"| {row['row']} | {common.md_escape(row['question'])} | {common.md_escape(row['ground_truth'])} |")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    common.setup_console()
    args = parse_args(argv)
    common.load_env()

    knowledge = common.read_text(common.FAQ_KNOWLEDGE_PATH)
    guard = common.read_text(common.FAQ_GUARD_PATH)
    system_prompt = build_system_prompt(knowledge, guard)
    rows = common.load_dataset(DATASET_PATH)
    if args.limit:
        rows = rows[: args.limit]

    settings = common.get_settings()
    llm_model, embedding_model = judge_models(settings)

    if args.dry_run:
        missing = missing_modules()
        messages = build_messages(system_prompt, rows[0]["question"])
        print("[faq] DRY-RUN: no se llama a la API ni se importa Ragas.")
        print(f"  Conocimiento: {common.rel(common.FAQ_KNOWLEDGE_PATH)} ({len(knowledge)} caracteres)")
        print(f"  Guardas:      {common.rel(common.FAQ_GUARD_PATH)} ({len(guard)} caracteres)")
        print(f"  System prompt: {len(system_prompt)} caracteres (sha256 {common.sha256_text(system_prompt)[:12]})")
        print(f"  Dataset:      {common.rel(DATASET_PATH)} -> {len(rows)} filas")
        print(f"  Modelo:       {settings.model} @ {settings.base_url} (temperature {TEMPERATURE})")
        print(f"  Juez Ragas:   {llm_model} · embeddings {embedding_model}")
        print(f"  API key:      {'definida' if settings.has_key else 'NO definida'}")
        print(
            "  Dependencias Ragas: "
            + ("instaladas" if not missing else f"FALTAN {', '.join(missing)} (pip install -r eval/requirements.txt)")
        )
        print(f"  Mensajes (fila 1): {[m['role'] for m in messages]} -> user: {messages[1]['content']!r}")
        print("[faq] DRY-RUN OK")
        return 0

    if not settings.has_key:
        print(common.MISSING_KEY_MESSAGE)
        return 0

    missing = missing_modules()
    if missing:
        print(
            f"[faq] Faltan dependencias para calcular las métricas Ragas: {', '.join(missing)}.\n"
            "      Crea un entorno virtual con Python 3.11 o 3.12 y ejecuta:\n"
            "      python -m pip install -r eval/requirements.txt"
        )
        return 1

    # 1) Generate answers with the production FAQ call.
    print(f"[faq] Generando {len(rows)} respuestas con {settings.model} (concurrencia {args.concurrency})...")
    usage_total: dict[str, int] = {}
    usage_lock = threading.Lock()
    started = time.monotonic()

    def generate(indexed: tuple[int, dict[str, str]]) -> dict[str, Any]:
        idx, row = indexed
        try:
            answer, usage = common.chat_completion(
                settings, build_messages(system_prompt, row["question"]), TEMPERATURE
            )
        except common.OpenAIError as err:
            print(f"  ! fila {idx}: {err}", file=sys.stderr)
            return {"row": idx, **row, "answer": "", "error": str(err)}
        with usage_lock:
            common.add_usage(usage_total, usage)
        return {"row": idx, **row, "answer": answer.strip(), "error": None}

    items = common.parallel_map(generate, list(enumerate(rows, start=2)), args.concurrency)

    # 2) Score with Ragas.
    print(f"[faq] Calculando métricas Ragas (juez {llm_model}, embeddings {embedding_model})...")
    try:
        scored = asyncio.run(
            score_items(items, settings, llm_model, embedding_model, args.concurrency)
        )
    except DependencyError as err:
        print(
            f"[faq] No se pudo importar Ragas ({err}).\n"
            "      Usa Python 3.11 o 3.12 y ejecuta: python -m pip install -r eval/requirements.txt"
        )
        return 1
    elapsed = round(time.monotonic() - started, 1)

    result_rows = []
    for item, (scores, errors) in zip(items, scored):
        result_rows.append(
            {
                "row": item["row"],
                "question": item["question"],
                "ground_truth": item["ground_truth"],
                "answer": item["answer"],
                **scores,
                "errors": errors,
            }
        )

    metrics: dict[str, dict[str, Any]] = {}
    for name in METRICS:
        values = [r[name] for r in result_rows if r[name] is not None]
        mean = sum(values) / len(values) if values else None
        metrics[name] = {
            "mean": mean,
            "scored": len(values),
            "target": TARGETS[name],
            "reference": REFERENCE_RESULTS[name],
            "passed": mean is not None and mean >= TARGETS[name],
        }
    passed = all(m["passed"] for m in metrics.values())

    try:
        from importlib.metadata import version

        ragas_version = version("ragas")
    except Exception:  # noqa: BLE001
        ragas_version = "desconocida"

    stamp = common.run_stamp()
    result: dict[str, Any] = {
        "kind": "faq",
        "timestamp": stamp,
        "model": settings.model,
        "base_url": settings.base_url,
        "temperature": TEMPERATURE,
        "prompt": {
            "knowledge": common.rel(common.FAQ_KNOWLEDGE_PATH),
            "guard": common.rel(common.FAQ_GUARD_PATH),
            "sha256": common.sha256_text(system_prompt),
        },
        "ragas": {"version": ragas_version, "llm_model": llm_model, "embedding_model": embedding_model},
        "dataset": common.rel(DATASET_PATH),
        "n": len(result_rows),
        "metrics": metrics,
        "passed": passed,
        "generation_errors": sum(1 for i in items if i["error"]),
        "metric_errors": sum(
            1 for r in result_rows for stage in r["errors"] if stage != "generation"
        ),
        "usage_generation": usage_total,
        "elapsed_seconds": elapsed,
        "rows": result_rows,
    }
    json_path, md_path = common.write_results(stamp, "faq", result, build_markdown(result))

    print("")
    worst = sorted(
        (r for r in result_rows if r["answer_correctness"] is not None),
        key=lambda r: r["answer_correctness"],
    )[:3]
    if worst:
        print("Peores respuestas (answer_correctness):")
        for r in worst:
            print(f"  [fila {r['row']}] {r['answer_correctness']:.3f} · {r['question']} -> {r['answer']}")
        print("")
    for name in METRICS:
        m = metrics[name]
        print(
            f"{name:<20} media {_fmt(m['mean'])} ({m['scored']}/{len(result_rows)} filas) — "
            f"objetivo ≥ {m['target']:.2f} (referencia {m['reference']:.2f}) → {'PASS' if m['passed'] else 'FAIL'}"
        )
    print(f"\nResultado global: {'PASS' if passed else 'FAIL'}")
    print(f"Resultados: {common.rel(json_path)} | {common.rel(md_path)}")
    # A measurement by default; with --strict (CI) a gate. Too many unscored rows (API or judge
    # errors) would make the mean unreliable, so they also fail in strict mode.
    unscored = [name for name in METRICS if metrics[name]["scored"] < MIN_SCORED_SHARE * len(result_rows)]
    if not passed:
        reason = "objetivo no alcanzado"
    else:
        reason = f"demasiadas filas sin puntuar en {', '.join(unscored)}"
    return common.strict_exit(args.strict, passed and not unscored, reason)


if __name__ == "__main__":
    sys.exit(main())

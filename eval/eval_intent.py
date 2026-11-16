"""Intent classification evaluation (CITA / FAQ).

Reproduces the production call: a single ``user`` message whose content is
``apps/bot/src/prompts/intent.txt`` with ``{sector}`` and ``{mensaje}``
replaced, temperature 0, and the same output normalisation as the bot.

Usage:
    python eval/eval_intent.py [--limit N] [--dry-run] [--concurrency K]
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from collections import Counter
from typing import Any

import eval_common as common

SECTOR = "clínica de fisioterapia"
LABELS = ("CITA", "FAQ")
FALLBACK_LABEL = "FAQ"
TARGET_ACCURACY = 0.99
TEMPERATURE = 0.0
DATASET_PATH = common.DATA_DIR / "intent.csv"

# Characters stripped around the model output before upper-casing.
_STRIP_CHARS = " \t\r\n\"'`“”‘’«».,;:!¡?¿*()[]{}<>-_"


def render_prompt(template: str, message: str) -> str:
    # {mensaje} is substituted last so a client message can never alter {sector}.
    return template.replace("{sector}", SECTOR).replace("{mensaje}", message)


def normalize_intent(raw: str) -> tuple[str, bool]:
    """Return (label, was_valid). Anything other than CITA/FAQ falls back to FAQ."""
    value = (raw or "").strip().strip(_STRIP_CHARS).upper()
    if value in LABELS:
        return value, True
    return FALLBACK_LABEL, False


def validate(template: str, rows: list[dict[str, str]]) -> list[str]:
    errors: list[str] = []
    for placeholder in ("{sector}", "{mensaje}"):
        if placeholder not in template:
            errors.append(f"El prompt no contiene el marcador {placeholder}")
    for idx, row in enumerate(rows, start=2):
        if row["ground_truth"] not in LABELS:
            errors.append(f"intent.csv:{idx}: ground_truth inválido {row['ground_truth']!r}")
    sample = render_prompt(template, rows[0]["question"]) if rows else ""
    if "{sector}" in sample or "{mensaje}" in sample:
        errors.append("Quedan marcadores sin sustituir tras renderizar el prompt")
    return errors


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evalúa la detección de intención CITA/FAQ.")
    parser.add_argument("--limit", type=int, default=None, help="Evalúa solo las N primeras filas.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Valida dataset y renderizado del prompt sin llamar a la API.",
    )
    parser.add_argument(
        "--concurrency", type=int, default=4, help="Peticiones simultáneas (por defecto 4; 1 = secuencial)."
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Termina con código 1 si no se alcanza el objetivo (para la CI).",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit debe ser >= 1")
    if args.concurrency < 1:
        parser.error("--concurrency debe ser >= 1")
    return args


def build_markdown(result: dict[str, Any]) -> str:
    cm = result["confusion_matrix"]
    lines = [
        f"# Evaluación de intención — {result['timestamp']}",
        "",
        f"- Modelo: `{result['model']}` (temperature {result['temperature']})",
        f"- Dataset: `{result['dataset']}` ({result['n']} filas)",
        f"- Prompt: `{result['prompt']}` (sha256 `{result['prompt_sha256'][:12]}`)",
        f"- **Accuracy: {result['accuracy'] * 100:.2f} %** "
        f"({result['correct']}/{result['n']}) — objetivo ≥ {result['target'] * 100:.0f} % → "
        f"**{'PASS' if result['passed'] else 'FAIL'}**",
        f"- Salidas no válidas normalizadas a FAQ: {result['invalid_outputs']}",
        f"- Errores de API: {result['api_errors']}",
        f"- Duración: {result['elapsed_seconds']} s",
        "",
        "## Matriz de confusión",
        "",
        "| Real \\ Predicho | CITA | FAQ | ERROR |",
        "|---|---|---|---|",
    ]
    for label in LABELS:
        row = cm[label]
        lines.append(f"| **{label}** | {row['CITA']} | {row['FAQ']} | {row['ERROR']} |")
    lines += ["", "## Métricas por clase", "", "| Clase | Precisión | Recall | Soporte |", "|---|---|---|---|"]
    for label in LABELS:
        m = result["per_class"][label]
        lines.append(f"| {label} | {m['precision']:.3f} | {m['recall']:.3f} | {m['support']} |")
    lines += ["", "## Filas mal clasificadas", ""]
    if result["misclassified"]:
        lines += ["| # | Mensaje | Esperado | Predicho | Salida bruta |", "|---|---|---|---|---|"]
        for item in result["misclassified"]:
            lines.append(
                f"| {item['row']} | {common.md_escape(item['question'])} | {item['expected']} | "
                f"{item['predicted']} | `{common.md_escape(item['raw_output'])}` |"
            )
    else:
        lines.append("Ninguna.")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    common.setup_console()
    args = parse_args(argv)
    common.load_env()

    template = common.read_text(common.INTENT_PROMPT_PATH)
    rows = common.load_dataset(DATASET_PATH)
    if args.limit:
        rows = rows[: args.limit]

    errors = validate(template, rows)
    if errors:
        print("[intent] Dataset/prompt no válidos:")
        for err in errors:
            print(f"  - {err}")
        return 1

    balance = Counter(r["ground_truth"] for r in rows)
    settings = common.get_settings()

    if args.dry_run:
        preview = render_prompt(template, rows[0]["question"])
        print("[intent] DRY-RUN: no se llama a la API.")
        print(f"  Prompt:   {common.rel(common.INTENT_PROMPT_PATH)} ({len(template)} caracteres)")
        print(f"  Dataset:  {common.rel(DATASET_PATH)} -> {len(rows)} filas {dict(balance)}")
        print(f"  Modelo:   {settings.model} @ {settings.base_url}")
        print(f"  API key:  {'definida' if settings.has_key else 'NO definida'}")
        print("  Últimas líneas del prompt renderizado (fila 1):")
        for line in preview.strip().splitlines()[-2:]:
            print(f"    | {line}")
        print("[intent] DRY-RUN OK")
        return 0

    if not settings.has_key:
        print(common.MISSING_KEY_MESSAGE)
        return 0

    print(
        f"[intent] Evaluando {len(rows)} mensajes con {settings.model} "
        f"(concurrencia {args.concurrency})..."
    )
    usage_total: dict[str, int] = {}
    usage_lock = threading.Lock()
    started = time.monotonic()

    def classify(indexed: tuple[int, dict[str, str]]) -> dict[str, Any]:
        idx, row = indexed
        prompt = render_prompt(template, row["question"])
        try:
            raw, usage = common.chat_completion(
                settings, [{"role": "user", "content": prompt}], TEMPERATURE
            )
        except common.OpenAIError as err:
            print(f"  ! fila {idx}: {err}", file=sys.stderr)
            return {"row": idx, **row, "raw_output": "", "predicted": "ERROR", "valid": False, "error": str(err)}
        label, valid = normalize_intent(raw)
        with usage_lock:
            common.add_usage(usage_total, usage)
        return {"row": idx, **row, "raw_output": raw, "predicted": label, "valid": valid, "error": None}

    # row numbers refer to the CSV line (header is line 1).
    predictions = common.parallel_map(classify, list(enumerate(rows, start=2)), args.concurrency)
    elapsed = round(time.monotonic() - started, 1)

    confusion = {gt: {"CITA": 0, "FAQ": 0, "ERROR": 0} for gt in LABELS}
    for p in predictions:
        confusion[p["ground_truth"]][p["predicted"]] += 1
    correct = sum(1 for p in predictions if p["predicted"] == p["ground_truth"])
    accuracy = correct / len(predictions)

    per_class = {}
    for label in LABELS:
        tp = confusion[label][label]
        predicted_as = sum(confusion[gt][label] for gt in LABELS)
        support = sum(confusion[label].values())
        per_class[label] = {
            "precision": tp / predicted_as if predicted_as else 0.0,
            "recall": tp / support if support else 0.0,
            "support": support,
        }

    misclassified = [
        {
            "row": p["row"],
            "question": p["question"],
            "expected": p["ground_truth"],
            "predicted": p["predicted"],
            "raw_output": p["raw_output"],
            "error": p["error"],
        }
        for p in predictions
        if p["predicted"] != p["ground_truth"]
    ]
    passed = accuracy >= TARGET_ACCURACY
    stamp = common.run_stamp()

    result: dict[str, Any] = {
        "kind": "intent",
        "timestamp": stamp,
        "model": settings.model,
        "base_url": settings.base_url,
        "temperature": TEMPERATURE,
        "sector": SECTOR,
        "prompt": common.rel(common.INTENT_PROMPT_PATH),
        "prompt_sha256": common.sha256_text(template),
        "dataset": common.rel(DATASET_PATH),
        "n": len(predictions),
        "label_balance": dict(balance),
        "correct": correct,
        "accuracy": accuracy,
        "target": TARGET_ACCURACY,
        "passed": passed,
        "confusion_matrix": confusion,
        "per_class": per_class,
        "invalid_outputs": sum(1 for p in predictions if not p["valid"] and p["error"] is None),
        "api_errors": sum(1 for p in predictions if p["error"] is not None),
        "usage": usage_total,
        "elapsed_seconds": elapsed,
        "misclassified": misclassified,
        "predictions": predictions,
    }
    json_path, md_path = common.write_results(stamp, "intent", result, build_markdown(result))

    print("")
    print("Matriz de confusión (filas = real, columnas = predicho):")
    print(f"  {'':6}{'CITA':>6}{'FAQ':>6}{'ERROR':>7}")
    for label in LABELS:
        r = confusion[label]
        print(f"  {label:6}{r['CITA']:>6}{r['FAQ']:>6}{r['ERROR']:>7}")
    if misclassified:
        print(f"\nMal clasificadas ({len(misclassified)}):")
        for m in misclassified:
            print(f"  [fila {m['row']}] esperado {m['expected']}, predicho {m['predicted']}: {m['question']}")
    print(
        f"\nAccuracy: {accuracy * 100:.2f} % ({correct}/{len(predictions)}) — "
        f"objetivo ≥ {TARGET_ACCURACY * 100:.0f} % → {'PASS' if passed else 'FAIL'}"
    )
    print(f"Resultados: {common.rel(json_path)} | {common.rel(md_path)}")
    # A measurement by default; with --strict (CI) a gate.
    return common.strict_exit(args.strict, passed, f"accuracy {accuracy * 100:.2f} % < {TARGET_ACCURACY * 100:.0f} %")


if __name__ == "__main__":
    sys.exit(main())

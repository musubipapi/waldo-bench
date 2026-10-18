"""Batched search: one request per scene, with one yes/no question (Noul) per tile.

The request's `state` holds the reference picture of Waldo once; each tile is its own Noul, with the tile image
inside the question. Each answer is scored exactly like the one-request-per-tile runs (search_tiles.score_scene:
the tile with the highest P(yes) wins, ties broken by the same fixed hash). Only models that read images inside
a question and take a whole scene's tiles in one request can be asked this way: Jev 1.14 (and Decider Flash V1.2).

Before any scene, one request with four colour squares checks that the model answers each question from its own
image. A run folder holds config.json, models.json, calls.jsonl (every HTTP request, API key removed),
predictions.jsonl (P(yes) per tile), searches.jsonl (one row per scene) and summary.json.
"""

import json
import random
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx
from PIL import Image

from . import dataset, openrouter
from .common import append_json, data_uri, now, png, read_jsonl, sha, write_json
from .search_tiles import SEED, score_scene

# The per-tile wording, with "the first/second image" replaced by `reference` and "this crop".
LEAD = "This is a crop from a crowded illustrated scene:"
QUESTION = ("Is Waldo (Wally), the same character as in `reference`, in this crop? He is often small and partly "
            "hidden, so sometimes only his face, round glasses, brown hair and red-and-white cap are visible. "
            "Other people in red-and-white stripes, and striped objects, are not Waldo.")
CRITERIA = {"true": "Waldo himself appears in this crop, even if small or partly hidden.",
            "false": "Waldo does not appear in this crop. Striped clothing or objects that belong to someone or something else do not count."}


def image_part(uri):
    return {"type": "image_url", "image_url": {"url": uri}}


def scene_payload(alias, reference_uri, tile_uris):
    return {**openrouter.pinned(alias), "state": {"reference": image_part(reference_uri)},
            "questions": {f"tile_{i}": {"type": "noul", "instructions": [LEAD, image_part(uri), QUESTION], "criteria": CRITERIA}
                          for i, uri in enumerate(tile_uris, 1)}}


def colour_check(client, key, alias, metadata, budget, log):
    """One request, four Nouls, each with its own square: the answers must follow the right image."""
    red = data_uri(png(Image.new("RGB", (384, 384), "red")), "image/png")
    blue = data_uri(png(Image.new("RGB", (384, 384), "blue")), "image/png")
    asks = {"q1": ("Is this square blue?", blue, True), "q2": ("Is this square blue?", red, False),
            "q3": ("Is this square red?", red, True), "q4": ("Is this square red?", blue, False)}
    body = {**openrouter.pinned(alias), "state": "Each question shows one colour swatch.",
            "questions": {q: {"type": "noul", "instructions": [text, image_part(uri)]} for q, (text, uri, _) in asks.items()}}
    response, error, calls = openrouter.ask(client, key, alias, body, metadata, budget, {"page": 0, "repeat": -1, "step": "control-colours"})
    log(calls)
    passed = response is not None
    for q, (_, _, yes) in asks.items():
        p = openrouter.noul_probability(response, q) if response else None
        passed &= p is not None and (p >= 0.8 if yes else p <= 0.2)
        print(f"check {q} expect {'yes' if yes else 'no '} P(yes)={p} error={error}", flush=True)
    return passed


def search(client, key, alias, page, cases, tile_uris, reference_uri, metadata, budget, log, output, lock):
    """One scene: one request holding a yes/no question for every tile."""
    started = time.perf_counter()
    response, error, calls = openrouter.ask(client, key, alias, scene_payload(alias, reference_uri, tile_uris), metadata, budget,
                                            {"page": page["page"], "repeat": 0, "step": "nouls-all"})
    log(calls)
    rows = []
    for i, case in enumerate(cases, 1):
        answer, why = None, error
        if response is not None:
            try:
                answer, why = openrouter.noul_probability(response, f"tile_{i}"), None
            except (KeyError, TypeError, ValueError) as exc:
                why = f"No valid answer for tile_{i}: {exc!r}"
        rows.append({"model": alias, "repeat": 0, "case_id": case["id"], "page": page["page"], "kind": "search", "answer": answer, "error": why})
    with lock:
        for row in rows:
            append_json(output / "predictions.jsonl", row)
    return {**score_scene(cases, rows, 0, SEED), "model": alias, "page": page["page"], "id": page["id"],
            "scene_group": page["scene_group"], "repeat": 0, "error": error, "wall_s": time.perf_counter() - started}


def redo_failed(manifest_path: Path, output: Path, max_attempts=1000, max_cost_usd=1.0, env_file=Path(".env")) -> int:
    """Run the scenes that hit a provider error again, one at a time; the replaced rows move to superseded-*.jsonl.
    The spending cap covers the whole run, earlier requests included."""
    config = json.loads((output / "config.json").read_text())
    alias = config["model"]
    rows = read_jsonl(output / "searches.jsonl")
    failed = [r for r in rows if not r["complete"]]
    if not failed:
        return 0
    tiles = dataset.load(manifest_path)
    by_page = {}
    for case in tiles["cases"]:
        by_page.setdefault(case["page"], []).append(case)
    pages = {p["page"]: p for p in tiles["pages"]}
    reference_uri = data_uri((output / "reference.jpg").read_bytes())
    key = openrouter.read_key(env_file)
    budget = openrouter.Budget(max_attempts, max_cost_usd, read_jsonl(output / "calls.jsonl"))
    lock = threading.Lock()
    redo = {r["page"] for r in failed}
    predictions = read_jsonl(output / "predictions.jsonl")
    for name, keep in (("searches", [r for r in rows if r["page"] not in redo]), ("predictions", [r for r in predictions if r["page"] not in redo])):
        for row in (rows if name == "searches" else predictions):
            if row["page"] in redo:
                append_json(output / f"superseded-{name}.jsonl", row)
        (output / f"{name}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in keep))

    def log(calls):
        with lock:
            for call in calls:
                append_json(output / "calls.jsonl", call)

    with httpx.Client(timeout=300) as client:
        metadata = openrouter.catalog(client, [alias])
        for page in sorted(redo):
            uris = [data_uri((manifest_path.parent / c["image"]).read_bytes()) for c in by_page[page]]
            row = search(client, key, alias, pages[page], by_page[page], uris, reference_uri, metadata, budget, log, output, lock)
            append_json(output / "searches.jsonl", row)
            print(f"redone page {page}: complete={row['complete']} | ${budget.cost:.5f}", flush=True)
    return len(redo)


def run(manifest_path: Path, source: Path, output: Path, alias="jev", concurrency=16, max_attempts=1000,
        max_cost_usd=1.0, env_file=Path(".env"), limit_pages=None) -> dict:
    tiles = dataset.load(manifest_path)
    pages = tiles["pages"][:limit_pages] if limit_pages else tiles["pages"]
    if (output / "config.json").exists():
        raise ValueError(f"{output} already holds a run")
    output.mkdir(parents=True, exist_ok=True)
    by_page = {}
    for case in tiles["cases"]:
        by_page.setdefault(case["page"], []).append(case)
    reference_raw, reference = dataset.reference_picture(source)
    (output / "reference.jpg").write_bytes(reference_raw)
    reference_uri = data_uri(reference_raw)
    uris = {p["page"]: [data_uri((manifest_path.parent / c["image"]).read_bytes()) for c in by_page[p["page"]]] for p in pages}
    key = openrouter.read_key(env_file)
    budget = openrouter.Budget(max_attempts, max_cost_usd)
    lock = threading.Lock()

    def log(calls):
        with lock:
            for call in calls:
                append_json(output / "calls.jsonl", call)

    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    with httpx.Client(timeout=300, limits=limits) as client:
        metadata = openrouter.catalog(client, [alias])
        write_json(output / "models.json", metadata)
        if not colour_check(client, key, alias, metadata, budget, log):
            raise RuntimeError(f"{alias} did not answer each question from its own image; see calls.jsonl")
        write_json(output / "config.json", {
            "created_at": now(), "model": alias, "method": "batched", "concurrency": concurrency, "seed": SEED,
            "api_url": openrouter.API_URL, "prompts": {"lead": LEAD, "question": QUESTION, "criteria": CRITERIA},
            "reference": reference, "planned_searches": len(pages), "manifest_sha256": sha(manifest_path.read_bytes()),
            "retries": "Only HTTP 429/529, at most three attempts."})
        jobs = list(pages)
        random.Random(SEED).shuffle(jobs)
        rows = []
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(search, client, key, alias, p, by_page[p["page"]], uris[p["page"]], reference_uri, metadata, budget, log, output, lock)
                       for p in jobs]
            for done, future in enumerate(as_completed(futures), 1):
                row = future.result()
                rows.append(row)
                append_json(output / "searches.jsonl", row)
                if done % 10 == 0 or done == len(futures):
                    print(f"{done}/{len(futures)} searches | {budget.attempts} requests | ${budget.cost:.5f}", flush=True)
    calls = [c for c in read_jsonl(output / "calls.jsonl") if c.get("step") == "nouls-all" and isinstance(c.get("response"), dict)]
    tokens = [c["response"]["usage"]["input_tokens"] for c in calls if "usage" in c["response"]]
    summary = {"searches": len(rows), "complete": sum(r["complete"] for r in rows), "found": sum(r["top1_hit"] for r in rows),
               "cost_usd": budget.cost, "cost_per_scene": budget.cost / max(1, len(rows)),
               "input_tokens_per_scene": statistics.mean(tokens) if tokens else None,
               "p50_s": statistics.median(r["wall_s"] for r in rows) if rows else None,
               "errors": [r["error"] for r in rows if r["error"]][:5]}
    write_json(output / "summary.json", summary)
    print(json.dumps(summary), flush=True)
    return summary

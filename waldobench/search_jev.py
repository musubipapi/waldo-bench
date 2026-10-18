"""Jev search: one request per scene, the way TypeSafe documents searching a large image.

TypeSafe's guide (docs.typesafe.ai/images, "Search a large image"): cut the image into tiles and ask a
Choice question with the tiles as its options. So each request holds the whole scene in `state`, the
reference picture of Waldo inside the instructions, and every tile of the scene as an option. The tile
Jev chooses is its answer. These are the same tiles, reference picture and wording the other models get.

Jev is the only model here that reads images inside a question and its options and takes all of a
scene's tiles (about 211) in one request. Before any scored request it must pass four checks that it
reads images in both places.

A run folder holds config.json, models.json, controls.jsonl, calls.jsonl (every HTTP request, API key
removed), searches.jsonl (one row per scene) and summary.json.
"""

import json
import random
import statistics
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal
from pathlib import Path

import httpx
from PIL import Image

from . import dataset, openrouter
from .common import append_json, data_uri, now, png, quantile, read_jsonl, sha, write_json

ALIAS = "jev"
SEED = 20261016
CHOICE_LEAD = "Which option is the tile of `scene` that contains Waldo (Wally), the same character as in this reference picture:"
DETAIL = ("He is often small and partly hidden, so sometimes only his face, round glasses, brown hair "
          "and red-and-white cap are visible. Other people in red-and-white stripes, and striped "
          "objects, are not Waldo.")


def image_part(uri):
    return {"type": "image_url", "image_url": {"url": uri}}


def choice_payload(scene_uri, tile_uris, reference_uri):
    return {**openrouter.pinned(ALIAS), "state": {"scene": image_part(scene_uri)},
            "questions": {"tile": {"type": "choice", "instructions": [CHOICE_LEAD, image_part(reference_uri), DETAIL],
                                   "criteria": {f"tile_{i}": image_part(uri) for i, uri in enumerate(tile_uris, 1)}}}}


def image_checks(client, key, metadata, budget, log):
    """Four tiny questions with coloured squares: images in the options, and images in the instructions."""
    red = data_uri(png(Image.new("RGB", (384, 384), "red")), "image/png")
    blue = data_uri(png(Image.new("RGB", (384, 384), "blue")), "image/png")
    checks = [("criteria-blue-second", "Which option is a blue square?", [red, blue], "tile_2"),
              ("criteria-blue-first", "Which option is a blue square?", [blue, red], "tile_1"),
              ("instructions-blue", ["Which option has the same color as this picture:", image_part(blue)], [red, blue], "tile_2"),
              ("instructions-red", ["Which option has the same color as this picture:", image_part(red)], [red, blue], "tile_1")]
    passed = True
    for name, instructions, options, expected in checks:
        body = {**openrouter.pinned(ALIAS), "state": "Two color swatches are given as options.",
                "questions": {"tile": {"type": "choice", "instructions": instructions,
                                       "criteria": {f"tile_{i}": image_part(u) for i, u in enumerate(options, 1)}}}}
        response, error, calls = openrouter.ask(client, key, ALIAS, body, metadata, budget, {"page": 0, "repeat": -1, "step": "control-" + name})
        log(calls)
        probability = response["answers"]["tile"]["probabilities"].get(expected) if response else None
        passed &= probability is not None and probability >= 0.8
        print(f"check {name:22} P({expected})={probability} error={error}", flush=True)
    return passed


def search(client, key, page, cases, scene_uri, tile_uris, reference_uri, repeat, metadata, budget, log):
    """One scene: one Choice request over all its tiles."""
    started = time.perf_counter()
    row = {"model": ALIAS, "page": page["page"], "id": page["id"], "scene_group": page["scene_group"],
           "repeat": repeat, "complete": False, "found": False, "error": None}
    response, error, calls = openrouter.ask(client, key, ALIAS, choice_payload(scene_uri, tile_uris, reference_uri),
                                            metadata, budget, {"page": page["page"], "repeat": repeat, "step": "choice-all"})
    log(calls)
    if error:
        row["error"] = error
    else:
        answer = response["answers"]["tile"]
        options = {f"tile_{i}": case for i, case in enumerate(cases, 1)}
        if answer.get("choice") not in options:
            row["error"] = f"Choice outside the options: {answer.get('choice')}"
        else:
            chosen = options[answer["choice"]]
            row.update(complete=True, found=chosen["positive"], chosen_tile=chosen["id"], chosen_box=chosen["box_pixels"],
                       chosen_probability=(answer.get("probabilities") or {}).get(answer["choice"]))
    row["wall_s"] = time.perf_counter() - started
    return row


def zoom_search(client, key, page, coarse, fine, scene_uri, uris, reference_uri, metadata, budget, log):
    """TypeSafe's documented search: a Choice among the scene's large tiles, then a Choice among the small tiles
    whose centre lies inside the chosen one ("repeat on the chosen tile"). The small tile it picks is its answer."""
    started = time.perf_counter()
    row = {"model": ALIAS, "page": page["page"], "id": page["id"], "scene_group": page["scene_group"],
           "repeat": 0, "complete": False, "found": False, "error": None}
    meta = {"page": page["page"], "repeat": 0}
    response, error, calls = openrouter.ask(client, key, ALIAS, choice_payload(scene_uri, [uris[c["id"]] for c in coarse], reference_uri),
                                            metadata, budget, {**meta, "step": "choice-coarse"})
    log(calls)
    big = None if error else {f"tile_{i}": c for i, c in enumerate(coarse, 1)}.get(response["answers"]["tile"].get("choice"))
    if big is None:
        row.update(error=error or "Choice outside the options", wall_s=time.perf_counter() - started)
        return row
    b = big["box_pixels"]
    inside = [c for c in fine if b[0] <= (c["box_pixels"][0] + c["box_pixels"][2]) / 2 < b[2] and b[1] <= (c["box_pixels"][1] + c["box_pixels"][3]) / 2 < b[3]]
    response, error, calls = openrouter.ask(client, key, ALIAS, choice_payload(uris[big["id"]], [uris[c["id"]] for c in inside], reference_uri),
                                            metadata, budget, {**meta, "step": "choice-fine"})
    log(calls)
    answer = None if error else response["answers"]["tile"]
    chosen = None if answer is None else {f"tile_{i}": c for i, c in enumerate(inside, 1)}.get(answer.get("choice"))
    if chosen is None:
        row.update(error=error or "Choice outside the options", coarse_tile=big["id"], wall_s=time.perf_counter() - started)
        return row
    probabilities = answer.get("probabilities") or {}
    row.update(complete=True, found=chosen["positive"], coarse_tile=big["id"], chosen_tile=chosen["id"], chosen_box=chosen["box_pixels"],
               chosen_probability=probabilities.get(answer["choice"]),
               probabilities={c["id"]: probabilities.get(f"tile_{i}") for i, c in enumerate(inside, 1)},
               wall_s=time.perf_counter() - started)
    return row


def run_zoom(manifest_path: Path, coarse_path: Path, source: Path, output: Path, max_attempts=1000, max_cost_usd=1.0,
             env_file=Path(".env"), limit_pages=None) -> dict:
    """Every scene once, one scene at a time (the same condition as the other runs), with zoom_search."""
    fine_tiles, coarse_tiles = dataset.load(manifest_path), dataset.load(coarse_path)
    pages = fine_tiles["pages"][:limit_pages] if limit_pages else fine_tiles["pages"]
    if (output / "config.json").exists():
        raise ValueError(f"{output} already holds a run")
    output.mkdir(parents=True, exist_ok=True)
    reference_raw, reference = dataset.reference_picture(source)
    (output / "reference.jpg").write_bytes(reference_raw)
    fine, coarse = defaultdict(list), defaultdict(list)
    for case in fine_tiles["cases"]:
        fine[case["page"]].append(case)
    for case in coarse_tiles["cases"]:
        coarse[case["page"]].append(case)
    uris = {c["id"]: data_uri((manifest_path.parent / c["image"]).read_bytes()) for c in fine_tiles["cases"]}
    uris.update({c["id"]: data_uri((coarse_path.parent / c["image"]).read_bytes()) for c in coarse_tiles["cases"]})
    key = openrouter.read_key(env_file)
    budget = openrouter.Budget(max_attempts, max_cost_usd)
    lock = threading.Lock()

    def log(calls):
        with lock:
            for call in calls:
                append_json(output / "calls.jsonl", call)
    with httpx.Client(timeout=120) as client:
        metadata = openrouter.catalog(client, [ALIAS])
        write_json(output / "models.json", metadata)
        if not image_checks(client, key, metadata, budget, log):
            raise RuntimeError("Jev did not read images in the options or instructions; see calls.jsonl")
        write_json(output / "config.json", {
            "created_at": now(), "model": ALIAS, "method": "zoom", "repeat": 1, "concurrency": 1, "seed": SEED,
            "api_url": openrouter.API_URL, "prompts": {"choice_lead": CHOICE_LEAD, "detail": DETAIL}, "reference": reference,
            "planned_searches": len(pages), "manifest_sha256": sha(manifest_path.read_bytes()), "coarse_manifest_sha256": sha(coarse_path.read_bytes()),
            "retries": "Only HTTP 429/529, at most three attempts."})
        jobs = list(pages)
        random.Random(SEED).shuffle(jobs)
        reference_uri = data_uri(reference_raw)
        for done, page in enumerate(jobs, 1):
            scene_uri = data_uri((manifest_path.parent / page["scene_image"]).read_bytes())
            row = zoom_search(client, key, page, coarse[page["page"]], fine[page["page"]], scene_uri, uris, reference_uri, metadata, budget, log)
            append_json(output / "searches.jsonl", row)
            if done % 10 == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)} searches | {budget.attempts} requests | ${budget.cost:.5f}", flush=True)
    rows = read_jsonl(output / "searches.jsonl")
    summary = {"found": sum(r["found"] for r in rows), "searches": len(rows), "complete_searches": sum(r["complete"] for r in rows),
               "known_cost_usd": budget.cost, "errors": [r["error"] for r in rows if r["error"]][:5]}
    write_json(output / "summary.json", summary)
    print(json.dumps(summary), flush=True)
    return summary


def summarize(output: Path) -> dict:
    rows = read_jsonl(output / "searches.jsonl")
    calls = [c for c in read_jsonl(output / "calls.jsonl") if c["step"] == "choice-all"]
    known = sum((Decimal(str(openrouter.usage_cost(c))) for c in calls if openrouter.usage_cost(c) is not None), Decimal(0))
    groups = defaultdict(list)
    for row in rows:
        groups[row["id"]].append(row["found"])
    groups = list(groups.values())
    rng = random.Random(SEED)
    boot = [statistics.mean(v for g in rng.choices(groups, k=len(groups)) for v in g) for _ in range(4000)]
    times = [r["wall_s"] for r in rows]
    summary = {"created_at": now(), "searches": len(rows), "complete_searches": sum(r["complete"] for r in rows),
               "found": sum(r["found"] for r in rows), "found_rate": statistics.mean(r["found"] for r in rows),
               "likely_range": [quantile(boot, .025), quantile(boot, .975)],
               "p50_search_s": quantile(times, .5), "p95_search_s": quantile(times, .95),
               "known_cost_usd_exact": str(known), "cost_per_search_usd": float(known) / len(rows) if rows else None,
               "unknown_billing_attempts": sum(openrouter.usage_cost(c) is None for c in calls), "http_attempts": len(calls),
               "errors": [r["error"] for r in rows if r["error"]]}
    write_json(output / "summary.json", summary)
    return summary


def run(manifest_path: Path, source: Path, output: Path, repeat=1, concurrency=16,
        max_attempts=1000, max_cost_usd=1.0, env_file=Path(".env"), limit_pages=None) -> dict:
    tiles = dataset.load(manifest_path)
    pages = tiles["pages"][:limit_pages] if limit_pages else tiles["pages"]
    if (output / "config.json").exists():
        raise ValueError(f"{output} already holds a run")
    output.mkdir(parents=True, exist_ok=True)
    reference_raw, reference = dataset.reference_picture(source)
    (output / "reference.jpg").write_bytes(reference_raw)
    by_page = defaultdict(list)
    for case in tiles["cases"]:
        by_page[case["page"]].append(case)
    inputs = {}
    for page in pages:
        scene_raw = (manifest_path.parent / page["scene_image"]).read_bytes()
        if sha(scene_raw) != page["scene_sha256"]:
            raise ValueError("A scene changed after preparation")
        inputs[page["page"]] = (data_uri(scene_raw), [data_uri((manifest_path.parent / c["image"]).read_bytes()) for c in by_page[page["page"]]])
    key = openrouter.read_key(env_file)
    budget = openrouter.Budget(max_attempts, max_cost_usd)
    lock = threading.Lock()

    def log(calls):
        with lock:
            for call in calls:
                append_json(output / "calls.jsonl", call)
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    with httpx.Client(timeout=60, limits=limits) as client:
        metadata = openrouter.catalog(client, [ALIAS])
        write_json(output / "models.json", metadata)
        if not image_checks(client, key, metadata, budget, log):
            raise RuntimeError("Jev did not read images in the options or instructions; see calls.jsonl")
        write_json(output / "config.json", {
            "created_at": now(), "model": ALIAS, "repeat": repeat, "concurrency": concurrency, "seed": SEED,
            "api_url": openrouter.API_URL, "prompts": {"choice_lead": CHOICE_LEAD, "detail": DETAIL}, "reference": reference,
            "planned_searches": len(pages) * repeat, "manifest_sha256": sha(manifest_path.read_bytes()),
            "retries": "Only HTTP 429/529, at most three attempts."})
        jobs = [(r, page) for r in range(repeat) for page in pages]
        random.Random(SEED).shuffle(jobs)
        reference_uri = data_uri(reference_raw)
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(search, client, key, page, by_page[page["page"]], *inputs[page["page"]], reference_uri, r, metadata, budget, log)
                       for r, page in jobs]
            for done, future in enumerate(as_completed(futures), 1):
                row = future.result()
                with lock:
                    append_json(output / "searches.jsonl", row)
                if done % 25 == 0 or done == len(futures):
                    print(f"{done}/{len(futures)} searches | {budget.attempts} requests | ${budget.cost:.5f}", flush=True)
    summary = summarize(output)
    print(json.dumps({k: summary[k] for k in ("found", "searches", "complete_searches", "known_cost_usd_exact")}), flush=True)
    return summary

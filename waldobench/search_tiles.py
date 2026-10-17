"""Tile search: ask a model about every tile of a scene, one yes/no question per tile.

Every request carries two images, the reference picture of Waldo and then one tile, and one Noul
(yes/no) question. The model's answer for a scene is the tile with the highest P(yes). It finds Waldo
when that tile overlaps the labelled box.

Before any scored request, each model must pass a two-image check (is the SECOND image blue?), so we
know it reads both images in order.

A run folder holds:
  config.json        settings, prompt text and the models that passed the check
  manifest.json      the scenes and tiles used
  models.json        what OpenRouter listed for each model
  controls.jsonl     the two-image check answers
  task-order.json    the shuffled order of searches
  calls.jsonl        every HTTP request: status, answer, cost, latency (API key removed)
  predictions.jsonl  one row per tile: P(yes) or the error
  timings.jsonl      wall time per search
  summary.json       results per model and per scene (from `summarize`)
"""

import hashlib
import json
import random
import shutil
import statistics
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal
from pathlib import Path

import httpx
from PIL import Image

from . import dataset, openrouter
from .common import append_json, data_uri, now, png, quantile, read_jsonl, sha, write_json
from .models import MODELS

SEED = 20261016
# The description of Waldo lives in the question; the request state holds only the two images.
INSTRUCTIONS = (
    "The first image is a reference picture of Waldo (Wally). The second image is a crop "
    "from a crowded illustrated scene. Is Waldo, the same character as in the reference, "
    "in the second image? He is often small and partly hidden, so sometimes only his face, "
    "round glasses, brown hair and red-and-white cap are visible. Other people in "
    "red-and-white stripes, and striped objects, are not Waldo."
)
CRITERIA = {
    "true": "Waldo himself appears in the second image, even if small or partly hidden.",
    "false": "Waldo does not appear in the second image. Striped clothing or objects that belong to someone or something else do not count.",
}
CONTROL_QUESTION = "Is the second image predominantly blue?"


def image_part(uri):
    return {"type": "image_url", "image_url": {"url": uri}}


def payload(alias, reference_uri, tile_uri):
    return {**openrouter.pinned(alias), "state": [image_part(reference_uri), image_part(tile_uri)],
            "questions": {"present": {"type": "noul", "instructions": INSTRUCTIONS, "criteria": CRITERIA}}}


def control_payload(alias, first_uri, second_uri):
    return {**openrouter.pinned(alias), "state": [image_part(first_uri), image_part(second_uri)],
            "questions": {"present": {"type": "noul", "instructions": CONTROL_QUESTION}}}


def ask_tile(client, key, alias, case, body, repeat, metadata, budget, kind="search"):
    """One tile question. Returns the prediction row (P(yes) or the error) and the HTTP call records."""
    meta = {"case_id": case["id"], "page": case["page"], "repeat": repeat, "kind": kind, "image_sha256": case["image_sha256"]}
    response, error, calls = openrouter.ask(client, key, alias, body, metadata, budget, meta)
    answer = None
    if response is not None:
        try:
            answer = openrouter.noul_probability(response)
        except (ValueError, TypeError, KeyError) as exception:
            error = str(exception)
    return {"model": alias, "repeat": repeat, "case_id": case["id"], "page": case["page"], "kind": kind,
            "answer": answer, "error": None if answer is not None else error, "image_sha256": case["image_sha256"],
            "payload_sha256": calls[0]["payload_sha256"] if calls else None, "http_attempts": len(calls)}, calls


def two_image_check(client, key, aliases, metadata, budget, output):
    """Each model sees [red, blue] and [blue, red] and must say whether the SECOND image is blue."""
    red = data_uri(png(Image.new("RGB", (384, 384), "red")), "image/png")
    blue = data_uri(png(Image.new("RGB", (384, 384), "blue")), "image/png")
    passed, reasons = {}, {}
    for alias in aliases:
        ok, errors = [], []
        for name, first, second, expect_yes in (("red-blue", red, blue, True), ("blue-red", blue, red, False)):
            case = {"id": "control-" + name, "page": 0, "image_sha256": sha((first + second).encode())}
            row, calls = ask_tile(client, key, alias, case, control_payload(alias, first, second), -1, metadata, budget, "control")
            for call in calls:
                append_json(output / "calls.jsonl", call)
            append_json(output / "controls.jsonl", row)
            ok.append(row["answer"] is not None and (row["answer"] >= 0.8 if expect_yes else row["answer"] <= 0.2))
            if row["answer"] is None:
                errors.append(f"{name}: {row['error']}")
            print(f"check {alias:10} {name:8} P(yes)={row['answer']} error={row['error']}", flush=True)
        passed[alias] = all(ok)
        if not passed[alias]:
            # A service error (rate limit, outage) is not evidence that the model misreads two images.
            reasons[alias] = ("check request failed: " + "; ".join(errors)) if errors else "answered the two-image check wrongly"
    return passed, reasons


def run_searches(client, pool, key, jobs, cases_by_id, encoded, reference_uri, metadata, budget, output):
    """Searches run one at a time; inside a search, its tile questions run in parallel."""
    for index, job in enumerate(jobs):
        if budget.reason:
            break
        started = time.perf_counter()
        futures = [pool.submit(ask_tile, client, key, job["model"], cases_by_id[case_id],
                               payload(job["model"], reference_uri, encoded[case_id]), job["repeat"], metadata, budget)
                   for case_id in job["cases"]]
        for future in as_completed(futures):
            row, calls = future.result()
            for call in calls:
                append_json(output / "calls.jsonl", call)
            append_json(output / "predictions.jsonl", row)
        append_json(output / "timings.jsonl", {"model": job["model"], "page": job["page"], "repeat": job["repeat"],
                                               "wall_s": time.perf_counter() - started})
        if index % 25 == 0 or index == len(jobs) - 1:
            print(f"{index + 1}/{len(jobs)} searches | {job['model']} | {budget.attempts} requests | ${budget.cost:.5f}", flush=True)


def tie_rank(case_id, repeat, seed=SEED):
    """Breaks ties between equally sure tiles the same way for every model, without looking at labels."""
    return hashlib.sha256(f"{seed}:{repeat}:{case_id}".encode()).hexdigest()


def score_scene(cases, rows, repeat, seed=SEED):
    """Pick the tile with the highest P(yes) and check it against the label. Unfinished searches score zero."""
    by_id = {r["case_id"]: r for r in rows}
    if len(by_id) != len(rows) or set(by_id) - {c["id"] for c in cases}:
        raise ValueError("Duplicate or unexpected predictions")
    answered = [c for c in cases if by_id.get(c["id"], {}).get("answer") is not None]
    ranked = sorted(answered, key=lambda c: (-by_id[c["id"]]["answer"], tie_rank(c["id"], repeat, seed)))
    complete = len(answered) == len(cases)
    top = by_id[ranked[0]["id"]]["answer"] if ranked else None
    tied = [c for c in ranked if by_id[c["id"]]["answer"] == top]
    return {"complete": complete, "coverage": len(answered) / len(cases), "tiles": len(cases),
            "winner": ranked[0]["id"] if ranked else None, "top_probability": top,
            "top1_hit": bool(complete and ranked and ranked[0]["positive"]),
            "top3_hit": bool(complete and any(c["positive"] for c in ranked[:3])),
            "top_tie_count": len(tied),
            "random_tile_hit_rate": sum(c["positive"] for c in cases) / len(cases)}


def summarize(output: Path) -> dict:
    """Score every search in a run folder and write summary.json (top1_hit = found)."""
    config = json.loads((output / "config.json").read_text())
    manifest = json.loads((output / "manifest.json").read_text())
    predictions = [r for r in read_jsonl(output / "predictions.jsonl") if r["kind"] == "search"]
    calls = read_jsonl(output / "calls.jsonl")
    timing = {(t["model"], t["repeat"], t["page"]): t["wall_s"] for t in read_jsonl(output / "timings.jsonl")}
    grouped = defaultdict(list)
    for row in predictions:
        grouped[row["model"], row["repeat"], row["page"]].append(row)
    cases_by_page = defaultdict(list)
    for case in manifest["cases"]:
        cases_by_page[case["page"]].append(case)
    page_rows, models = [], {}
    for alias in config["scored_models"]:
        rows = []
        for repeat in range(config["repeat"]):
            for page in manifest["pages"]:
                result = score_scene(cases_by_page[page["page"]], grouped[alias, repeat, page["page"]], repeat, config["seed"])
                rows.append({**result, "model": alias, "page": page["page"], "id": page["id"], "scene_group": page["scene_group"],
                             "repeat": repeat, "wall_s": timing.get((alias, repeat, page["page"]))})
        search_calls = [c for c in calls if c["model_alias"] == alias and c["kind"] == "search"]
        known = sum((Decimal(str(openrouter.usage_cost(c))) for c in search_calls if openrouter.usage_cost(c) is not None), Decimal(0))
        times = [r["wall_s"] for r in rows if r["wall_s"] is not None]
        hits = sum(r["top1_hit"] for r in rows)
        known_model = MODELS.get(alias, {"name": alias, "id": alias})  # older runs can hold models no longer in the benchmark
        models[alias] = {"name": known_model["name"], "model_id": known_model["id"], "hits": hits, "searches": len(rows),
                         "hit_rate": hits / len(rows), "complete_searches": sum(r["complete"] for r in rows),
                         "known_cost_usd_exact": str(known), "cost_per_search_usd": float(known) / len(rows),
                         "unknown_billing_attempts": sum(openrouter.usage_cost(c) is None for c in search_calls),
                         "http_attempts": len(search_calls), "p50_search_s": quantile(times, .5), "p95_search_s": quantile(times, .95)}
        page_rows.extend(rows)
    halted = [r for r in predictions if r["error"] and any(m in r["error"] for m in openrouter.HALT_MARKERS)]
    total = sum((Decimal(str(openrouter.usage_cost(c))) for c in calls if openrouter.usage_cost(c) is not None), Decimal(0))
    summary = {"created_at": now(), "models": models, "page_results": page_rows,
               "unscored_reasons": config.get("unscored_reasons", {}), "known_total_cost_usd_exact": str(total),
               "http_attempts": len(calls), "halted_predictions": len(halted),
               # "complete" means the run was not stopped by our own caps or account; failed searches are listed per model.
               "complete": len(predictions) == config["planned_predictions"] and not halted}
    write_json(output / "summary.json", summary)
    return summary


def _encode_tiles(manifest_path, cases):
    return {c["id"]: data_uri((manifest_path.parent / c["image"]).read_bytes()) for c in cases}


def run(manifest_path: Path, source: Path, output: Path, aliases, repeat=1, concurrency=16,
        max_attempts=150_000, max_cost_usd=8.0, env_file=Path(".env"), limit_pages=None) -> dict:
    tiles = dataset.load(manifest_path)
    pages, cases = tiles["pages"], tiles["cases"]
    if limit_pages:  # a quick partial run for testing; never a benchmark result
        pages = pages[:limit_pages]
        keep = {p["page"] for p in pages}
        cases = [c for c in cases if c["page"] in keep]
    if (output / "config.json").exists():
        raise ValueError(f"{output} already holds a run; use `resume` to finish it")
    output.mkdir(parents=True, exist_ok=True)
    reference_raw, reference = dataset.reference_picture(source)
    (output / "reference.jpg").write_bytes(reference_raw)
    write_json(output / "manifest.json", {"dataset": tiles["dataset"], "preprocessing": tiles["preprocessing"], "pages": pages, "cases": cases})
    shutil.copyfile(__file__, output / "code-at-run.py")
    key = openrouter.read_key(env_file)
    budget = openrouter.Budget(max_attempts, max_cost_usd)
    encoded = _encode_tiles(manifest_path, cases)
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    with httpx.Client(timeout=45, limits=limits) as client, ThreadPoolExecutor(max_workers=concurrency) as pool:
        metadata = openrouter.catalog(client, aliases)
        write_json(output / "models.json", metadata)
        passed, reasons = two_image_check(client, key, aliases, metadata, budget, output)
        scored = [alias for alias in aliases if passed[alias]]
        write_json(output / "config.json", {
            "created_at": now(), "models": list(aliases), "scored_models": scored, "unscored_reasons": reasons,
            "repeat": repeat, "concurrency": concurrency, "seed": SEED, "api_url": openrouter.API_URL,
            "instructions": INSTRUCTIONS, "criteria": CRITERIA, "control_question": CONTROL_QUESTION, "reference": reference,
            "planned_predictions": len(cases) * repeat * len(scored), "limit_pages": limit_pages,
            "retries": "Only HTTP 429/529, at most three attempts. 401/402/403 stop the run.",
            "manifest_sha256": sha((output / "manifest.json").read_bytes()), "source_manifest_sha256": sha(manifest_path.read_bytes())})
        # Shuffle scenes, tiles and model order so no model always goes first or meets the same server load.
        jobs, rng = [], random.Random(SEED)
        for pass_number in range(repeat):
            order = pages.copy()
            rng.shuffle(order)
            for index, page in enumerate(order):
                page_cases = [c for c in cases if c["page"] == page["page"]]
                rng.shuffle(page_cases)
                shift = (index + pass_number) % max(1, len(scored))
                for alias in scored[shift:] + scored[:shift]:
                    jobs.append({"model": alias, "page": page["page"], "repeat": pass_number, "cases": [c["id"] for c in page_cases]})
        write_json(output / "task-order.json", jobs)
        run_searches(client, pool, key, jobs, {c["id"]: c for c in cases}, encoded, data_uri(reference_raw), metadata, budget, output)
    summary = summarize(output)
    print(json.dumps({"complete": summary["complete"], "cost": summary["known_total_cost_usd_exact"], "unscored": reasons, "stop_reason": budget.reason}), flush=True)
    return summary


def resume(manifest_path: Path, output: Path, redo_failed=False, concurrency=None,
           max_attempts=150_000, max_cost_usd=8.0, env_file=Path(".env"), redo_slower_than=None) -> dict:
    """Finish a run. Searches stopped by our own caps or account are redone whole; with redo_failed, so are
    searches that hit a provider error; with redo_slower_than=N, so are searches that took more than N times
    their model's median time (a provider stall). The rule looks only at time, never at the answer.
    Otherwise finished searches are never asked again. Old rows move to superseded-*.jsonl so nothing is lost."""
    config = json.loads((output / "config.json").read_text())
    if sha((output / "manifest.json").read_bytes()) != config["manifest_sha256"] or sha(manifest_path.read_bytes()) != config["source_manifest_sha256"]:
        raise ValueError("The tiles changed since this run started")
    reference_raw = (output / "reference.jpg").read_bytes()
    if sha(reference_raw) != config["reference"]["sent_sha256"]:
        raise ValueError("The reference picture changed since this run started")
    manifest = json.loads((output / "manifest.json").read_text())

    def search_key(row):
        return row["model"], row["repeat"], row["page"]
    predictions, timings = read_jsonl(output / "predictions.jsonl"), read_jsonl(output / "timings.jsonl")
    redo = {search_key(p) for p in predictions if p["kind"] == "search" and p["error"]
            and (redo_failed or any(m in p["error"] for m in openrouter.HALT_MARKERS))}
    if redo_slower_than:
        times = defaultdict(list)
        for row in timings:
            times[row["model"]].append(row["wall_s"])
        redo |= {search_key(r) for r in timings if r["wall_s"] > redo_slower_than * statistics.median(times[r["model"]])}
    for name, rows in (("predictions", predictions), ("timings", timings)):
        for row in rows:
            if search_key(row) in redo:
                append_json(output / f"superseded-{name}.jsonl", row)
        (output / f"{name}.jsonl").write_text("".join(json.dumps(r, allow_nan=False) + "\n" for r in rows if search_key(r) not in redo))
    recorded = defaultdict(int)
    for row in read_jsonl(output / "predictions.jsonl"):
        if row["kind"] == "search":
            recorded[search_key(row)] += 1
    tiles_per_page = defaultdict(int)
    for case in manifest["cases"]:
        tiles_per_page[case["page"]] += 1
    if any(count != tiles_per_page[page] for (_, _, page), count in recorded.items()):
        raise ValueError("A search is half recorded for an unexpected reason; not resuming")
    jobs = [j for j in json.loads((output / "task-order.json").read_text()) if (j["model"], j["repeat"], j["page"]) not in recorded]
    calls = read_jsonl(output / "calls.jsonl")
    budget = openrouter.Budget(max_attempts, max_cost_usd, calls)
    reason = "halt" + (", failed requests" if redo_failed else "") + (f", slower than {redo_slower_than}x the model's median" if redo_slower_than else "")
    append_json(output / "resume-events.jsonl", {"at": now(), "reason": reason,
                                                 "redone_searches": sorted(redo), "pending_searches": len(jobs)})
    needed = {case_id for job in jobs for case_id in job["cases"]}
    cases = [c for c in manifest["cases"] if c["id"] in needed]
    for case in cases:
        if sha((manifest_path.parent / case["image"]).read_bytes()) != case["image_sha256"]:
            raise ValueError("A tile changed since this run started")
    concurrency = concurrency or config["concurrency"]
    print(f"Resuming: {len(jobs)} searches to run, {len(redo)} of them redone", flush=True)
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    with httpx.Client(timeout=45, limits=limits) as client, ThreadPoolExecutor(max_workers=concurrency) as pool:
        run_searches(client, pool, openrouter.read_key(env_file), jobs, {c["id"]: c for c in manifest["cases"]},
                     _encode_tiles(manifest_path, cases), data_uri(reference_raw), json.loads((output / "models.json").read_text()), budget, output)
    summary = summarize(output)
    print(json.dumps({"complete": summary["complete"], "cost": summary["known_total_cost_usd_exact"], "stop_reason": budget.reason}), flush=True)
    return summary

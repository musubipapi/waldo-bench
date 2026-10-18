"""Results: combine run folders into the leaderboard, likely ranges, head-to-head gaps and verdict.

Which runs make up the results is listed in a small JSON file (results/waldo-bench-v1/runs.json):
each run's folder, its tile size, and its method ("parallel" = one request per tile, "one-call" = one Choice
request per scene, "zoom" = TypeSafe's search, a Choice among large tiles then among the small tiles inside the chosen
one, "batched" = one request per scene with a yes/no question per tile). A run's optional "as"
shows a model under a variant name (models.VARIANTS: Jev 1.14 is shown three ways).

Definitions used everywhere:
  found         the model's chosen tile overlaps the labelled Waldo
  likely range  the 95% interval: re-draw the 66 scenes with replacement 4,000 times,
                recompute the found rate each time, keep the middle 95%
  head-to-head  the same re-draw for two models at once, on the gap between them
  cost          what OpenRouter billed (usage.cost) for the requests behind the answers, per scene (answer_calls)
  typical time  median time to search one scene, counting only successful requests: speed when the model
                works, not how reliable its provider is (see success_times)
"""

import csv
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

from .common import ROOT, quantile, read_jsonl, write_json
from .models import MODELS, NOT_INCLUDED, VARIANTS, display
from .openrouter import usage_cost

SEED = 20261016
RESAMPLES = 4000
PASSES = 1  # every model is scored on one pass; extra passes in older runs are ignored


def answer_calls(calls, method):
    """The requests behind the answers: for each tile (one request per scene: each scene) the last successful request.
    Earlier attempts (rate-limited, failed, or stalled searches run again) count toward neither time nor cost: we measure
    the model when it works, not how reliable its provider is."""
    if method == "parallel":
        scored, unit = (lambda c: c.get("kind") == "search"), (lambda c: c["case_id"])
    else:  # the Choice ("choice-all"; "choice-192-all" in one older run; zoom: "choice-coarse" and "choice-fine") or the batched yes/no request
        scored, unit = (lambda c: c.get("step", "").startswith("choice") or c.get("step") == "nouls-all"), (lambda c: (c["page"], c["step"]))
    last = {}
    for c in sorted(calls, key=lambda c: c["started_at"]):  # later requests replace earlier ones
        if scored(c) and c.get("http_status") == 200 and not c.get("error") and c.get("repeat", 0) < PASSES:
            last[c["model_alias"], c["repeat"], unit(c)] = c
    return list(last.values())


def success_times(run: Path, method: str):
    """Search time when the model works, from the requests behind the answers (answer_calls).

    Requests per scene (one, or two for zoom): the sum of their times. One request per tile: each tile's request, replayed in the order the
    tiles were sent on the run's slots (16 in flight), so the time is when the last answer would arrive.
    Returns {(model, page, repeat): seconds} and {(model, case_id, repeat): seconds after the search started}."""
    calls = answer_calls(read_jsonl(run / "calls.jsonl"), method)
    scenes, tiles = {}, {}
    if method != "parallel":
        for c in calls:
            scenes[c["model_alias"], c["page"], c["repeat"]] = scenes.get((c["model_alias"], c["page"], c["repeat"]), 0) + c["latency_s"]
        return scenes, tiles
    slots = json.loads((run / "config.json").read_text())["concurrency"]
    by_search = defaultdict(list)
    for c in calls:
        by_search[c["model_alias"], c["page"], c["repeat"]].append(c)
    for (model, page, repeat), sent in by_search.items():
        free = [0.0] * slots
        for c in sorted(sent, key=lambda c: c["started_at"]):
            slot = min(range(slots), key=free.__getitem__)
            free[slot] += c["latency_s"]
            tiles[model, c["case_id"], repeat] = free[slot]
        scenes[model, page, repeat] = max(free)
    return scenes, tiles


def scene_rows(run: Path, method: str):
    """One row per (model, scene) from a run folder, plus cost (of the requests behind the answers) and request count per model."""
    rows, cost, attempts = [], defaultdict(float), defaultdict(int)
    calls = read_jsonl(run / "calls.jsonl")
    if method in ("one-call", "zoom"):
        # Runs made before the cleanup also asked an unscored Box question after the Choice: leave its time out.
        box_s = defaultdict(float)
        for call in calls:
            if call["step"] == "box" and call.get("latency_s") is not None:
                box_s[call["page"], call["repeat"]] += call["latency_s"]
        for row in read_jsonl(run / "searches.jsonl"):
            if row["repeat"] < PASSES:
                rows.append({"model": "jev", "repeat": row["repeat"], "page": row["page"], "id": row["id"],
                             "found": bool(row["found"]), "complete": "chosen_tile" in row or "level1_tile" in row,
                             "wall_s": row["wall_s"] - box_s[row["page"], row["repeat"]]})
        for call in calls:
            # The scored request is the Choice ("choice-all"; "choice-192-all" in one older run).
            if call["step"].startswith("choice") and call["repeat"] < PASSES:
                attempts["jev"] += 1
    elif method == "batched":
        for row in read_jsonl(run / "searches.jsonl"):
            if row["repeat"] < PASSES:
                rows.append({"model": row["model"], "repeat": row["repeat"], "page": row["page"], "id": row["id"],
                             "found": bool(row["top1_hit"]), "complete": bool(row["complete"]), "wall_s": row["wall_s"]})
        for call in calls:
            if call["step"] == "nouls-all" and call["repeat"] < PASSES:
                attempts[call["model_alias"]] += 1
    else:
        for row in json.loads((run / "summary.json").read_text())["page_results"]:
            if row["repeat"] < PASSES:
                rows.append({"model": row["model"], "repeat": row["repeat"], "page": row["page"], "id": row["id"],
                             "found": bool(row["top1_hit"]), "complete": bool(row["complete"]), "wall_s": row["wall_s"]})
        for call in calls:
            if call.get("kind") == "search" and call.get("repeat", 0) < PASSES:
                attempts[call["model_alias"]] += 1
    for call in answer_calls(calls, method):
        cost[call["model_alias"]] += usage_cost(call) or 0
    timed, _ = success_times(run, method)
    for row in rows:
        if row["complete"] and (row["model"], row["page"], row["repeat"]) in timed:
            row["wall_s"] = timed[row["model"], row["page"], row["repeat"]]
    return rows, cost, attempts


def scene_order(scene_id):
    """IVSN ids are book_part, e.g. 4_12; sort them as numbers."""
    return tuple(map(int, scene_id.split("_")))


def likely_range(rows):
    """95% interval for the found rate, re-drawing scenes (all passes of a scene stay together)."""
    groups = defaultdict(list)
    for row in rows:
        groups[row["id"]].append(row["found"])
    groups = list(groups.values())
    rng = random.Random(SEED)
    draws = [statistics.mean(v for g in rng.choices(groups, k=len(groups)) for v in g) for _ in range(RESAMPLES)]
    return [quantile(draws, .025), quantile(draws, .975)]


def head_to_head(rows_a, rows_b):
    """Found-rate gap a minus b, with a 95% interval from re-drawing the same scenes for both models."""
    b = {r["id"]: r for r in rows_b}
    groups = defaultdict(list)
    for row in sorted(rows_a, key=lambda r: scene_order(r["id"])):
        groups[row["id"]].append(float(row["found"]) - float(b[row["id"]]["found"]))
    groups = list(groups.values())
    rng = random.Random(SEED)
    draws = [statistics.mean(v for g in rng.choices(groups, k=len(groups)) for v in g) for _ in range(RESAMPLES)]
    return {"gap": statistics.mean(v for g in groups for v in g), "ci95": [quantile(draws, .025), quantile(draws, .975)]}


def middle_tile_rate(manifest):
    """Baseline: always pick the tile nearest the middle of the scene."""
    tiles = defaultdict(list)
    for case in manifest["cases"]:
        tiles[case["page"]].append(case)
    hits = []
    for page in manifest["pages"]:
        cx, cy = page["size"][0] / 2, page["size"][1] / 2
        middle = min(tiles[page["page"]], key=lambda c: ((c["box_pixels"][0] + c["box_pixels"][2]) / 2 - cx) ** 2 + ((c["box_pixels"][1] + c["box_pixels"][3]) / 2 - cy) ** 2)
        hits.append(middle["positive"])
    return statistics.mean(hits)


def outclassed_by(model, others):
    """Models at least as good on accuracy, price and speed, and better on one, compared at the precision shown."""
    def shown(m):
        return m["found"], -round(m["usd_per_scene"], 4), -round(m["p50_search_s"], 1)
    rivals = [o for o in others if o is not model and all(x >= y for x, y in zip(shown(o), shown(model))) and shown(o) != shown(model)]
    return [o["model"] for o in sorted(rivals, key=lambda o: (-o["found"], o["usd_per_scene"]))]


def build(runs_file: Path, output: Path) -> dict:
    spec = json.loads(runs_file.read_text())
    entries, rows_by_entry = [], {}
    for run in spec["runs"]:
        folder = ROOT / run["path"]
        rows, cost, attempts = scene_rows(folder, run["method"])
        if run.get("timing_from"):
            # Use typical time from another pass of the same model (see runs.json for why).
            timed = {(r["id"], r["repeat"]): r["wall_s"] for r in scene_rows(ROOT / run["timing_from"], run["method"])[0]}
            rows = [{**r, "wall_s": timed[r["id"], r["repeat"]]} for r in rows]
        by_model = defaultdict(list)
        for row in rows:
            by_model[row["model"]].append(row)
        for source, model_rows in by_model.items():
            alias = run.get("as", {}).get(source, source)
            if alias not in MODELS and alias not in VARIANTS:  # ran, but not part of the benchmark (see models.NOT_INCLUDED)
                continue
            times = [r["wall_s"] for r in model_rows if r["wall_s"] is not None]
            entry = {"model": alias, "run_model": source, "name": display(alias)["name"], "model_id": display(alias)["id"], "tile_px": run["tile_px"],
                     "method": run["method"], "run": run["path"], "timing_run": run.get("timing_from", run["path"]),
                     "passes": len({r["repeat"] for r in model_rows}), "searches": len(model_rows),
                     "found": sum(r["found"] for r in model_rows), "found_rate": statistics.mean(r["found"] for r in model_rows),
                     "found_ci95": likely_range(model_rows), "complete_searches": sum(r["complete"] for r in model_rows),
                     "p50_search_s": quantile(times, .5), "p95_search_s": quantile(times, .95),
                     "usd_per_scene": cost[source] / len(model_rows), "http_attempts": attempts[source]}
            entries.append(entry)
            rows_by_entry[alias, run["tile_px"], run["method"]] = model_rows
    # Headline: every row at the headline tile size (each model once; Jev 1.14 three ways, see models.VARIANTS).
    size = spec["headline_tile_px"]
    headline = [e for e in entries if e["tile_px"] == size]
    if len({e["model"] for e in headline}) != len(headline):
        raise ValueError("Two runs give the same row at the headline tile size")
    headline.sort(key=lambda e: (-e["found_rate"], e["usd_per_scene"], e["p50_search_s"]))  # equal found: cheaper, then faster, first
    for entry in headline:
        entry["rank"] = 1 + sum(o["found"] > entry["found"] for o in headline)  # ties share a rank
        entry["beaten_by"] = outclassed_by(entry, headline)
    rows_of = {e["model"]: rows_by_entry[e["model"], size, e["method"]] for e in headline}
    leader = headline[0]
    gaps = [{"model": e["model"], **head_to_head(rows_of[leader["model"]], rows_of[e["model"]])} for e in headline[1:]]
    cheapest = min(headline, key=lambda e: e["usd_per_scene"])
    verdict = {"leader": leader["model"], "leader_clear": all(g["ci95"][0] > 0 for g in gaps), "budget": cheapest["model"],
               "significantly_better_than_budget": [e["model"] for e in headline if e is not cheapest
                                                    and head_to_head(rows_of[e["model"]], rows_of[cheapest["model"]])["ci95"][0] > 0]}
    manifests = {int(px): json.loads((ROOT / path).read_text()) for px, path in spec["tiles"].items()}
    baselines = {"random_tile": {px: statistics.mean(p["positive_tiles"] / p["tiles"] for p in m["pages"]) for px, m in manifests.items()},
                 "middle_tile": middle_tile_rate(manifests[size])}
    result = {"benchmark": "Waldo Bench", "date": spec.get("date"), "headline_tile_px": size,
              "scenes": len(manifests[size]["pages"]), "headline": headline, "head_to_head": gaps, "verdict": verdict,
              "baselines": baselines, "all_entries": entries, "not_included": NOT_INCLUDED, "notes": spec.get("notes", [])}
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "results.json", result)
    fields = ["name", "model_id", "tile_px", "method", "found", "searches", "found_rate", "found_ci95", "p50_search_s", "usd_per_scene"]
    for name, table in (("leaderboard.csv", headline), ("curve.csv", sorted(entries, key=lambda e: (e["model"], -e["tile_px"], e["method"])))):
        with (output / name).open("w") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(table)
    return result

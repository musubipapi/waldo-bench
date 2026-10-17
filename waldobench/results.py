"""Results: combine run folders into the leaderboard, likely ranges, head-to-head gaps and verdict.

Which runs make up the results is listed in a small JSON file (results/waldo-bench-v1/runs.json):
each run's folder, its tile size, and its method ("parallel" = one question per tile, "one-call" = Jev).

Definitions used everywhere:
  found         the model's chosen tile overlaps the labelled Waldo
  likely range  the 95% interval: re-draw the 65 source pictures with replacement 4,000 times,
                recompute the found rate each time, keep the middle 95%
  head-to-head  the same re-draw for two models at once, on the gap between them
  cost          what OpenRouter billed (usage.cost), per whole-scene search
  typical time  median wall time to search one scene
"""

import csv
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

from .common import ROOT, quantile, read_jsonl, write_json
from .models import MODELS, NOT_INCLUDED
from .openrouter import usage_cost

SEED = 20261016
RESAMPLES = 4000
PASSES = 1  # every model is scored on one pass; extra passes in older runs are ignored


def scene_rows(run: Path, method: str):
    """One row per (model, scene) from a run folder, plus billed cost and request count per model."""
    rows, cost, attempts = [], defaultdict(float), defaultdict(int)
    calls = read_jsonl(run / "calls.jsonl")
    if method == "one-call":
        # Runs made before the cleanup also asked an unscored Box question after the Choice: leave its time out.
        box_s = defaultdict(float)
        for call in calls:
            if call["step"] == "box" and call.get("latency_s") is not None:
                box_s[call["page"], call["repeat"]] += call["latency_s"]
        for row in read_jsonl(run / "searches.jsonl"):
            if row["repeat"] < PASSES:
                rows.append({"model": "jev", "repeat": row["repeat"], "page": row["page"], "id": row["id"], "scene_group": row["scene_group"],
                             "found": bool(row["found"]), "complete": "chosen_tile" in row or "level1_tile" in row,
                             "wall_s": row["wall_s"] - box_s[row["page"], row["repeat"]]})
        for call in calls:
            # The scored request is the Choice ("choice-all"; "choice-192-all" in one older run).
            if call["step"].startswith("choice") and call["repeat"] < PASSES:
                cost["jev"] += usage_cost(call) or 0
                attempts["jev"] += 1
    else:
        for row in json.loads((run / "summary.json").read_text())["page_results"]:
            if row["repeat"] < PASSES:
                rows.append({"model": row["model"], "repeat": row["repeat"], "page": row["page"], "id": row["id"], "scene_group": row["scene_group"],
                             "found": bool(row["top1_hit"]), "complete": bool(row["complete"]), "wall_s": row["wall_s"]})
        for call in calls:
            if call.get("kind") == "search" and call.get("repeat", 0) < PASSES:
                cost[call["model_alias"]] += usage_cost(call) or 0
                attempts[call["model_alias"]] += 1
    return rows, cost, attempts


def scene_order(scene_id):
    """IVSN ids are book_part, e.g. 4_12; sort them as numbers."""
    return tuple(map(int, scene_id.split("_")))


def likely_range(rows):
    """95% interval for the found rate, re-drawing whole source pictures (two scenes share one picture)."""
    groups = defaultdict(list)
    for row in rows:
        groups[row["scene_group"]].append(row["found"])
    groups = list(groups.values())
    rng = random.Random(SEED)
    draws = [statistics.mean(v for g in rng.choices(groups, k=len(groups)) for v in g) for _ in range(RESAMPLES)]
    return [quantile(draws, .025), quantile(draws, .975)]


def head_to_head(rows_a, rows_b):
    """Found-rate gap a minus b, with a 95% interval from re-drawing the same pictures for both models."""
    b = {r["id"]: r for r in rows_b}
    groups = defaultdict(list)
    for row in sorted(rows_a, key=lambda r: scene_order(r["id"])):
        groups[row["scene_group"]].append(float(row["found"]) - float(b[row["id"]]["found"]))
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
        for alias, model_rows in by_model.items():
            if alias not in MODELS:  # ran, but not part of the benchmark (see models.NOT_INCLUDED)
                continue
            times = [r["wall_s"] for r in model_rows if r["wall_s"] is not None]
            entry = {"model": alias, "name": MODELS[alias]["name"], "model_id": MODELS[alias]["id"], "tile_px": run["tile_px"],
                     "method": run["method"], "run": run["path"], "timing_run": run.get("timing_from", run["path"]),
                     "passes": len({r["repeat"] for r in model_rows}), "searches": len(model_rows),
                     "found": sum(r["found"] for r in model_rows), "found_rate": statistics.mean(r["found"] for r in model_rows),
                     "found_ci95": likely_range(model_rows), "complete_searches": sum(r["complete"] for r in model_rows),
                     "p50_search_s": quantile(times, .5), "p95_search_s": quantile(times, .95),
                     "usd_per_scene": cost[alias] / len(model_rows), "http_attempts": attempts[alias]}
            entries.append(entry)
            rows_by_entry[alias, run["tile_px"], run["method"]] = model_rows
    # Headline: every model at the headline tile size, called its maker's way (Jev: one call per scene).
    size = spec["headline_tile_px"]
    headline = [e for e in entries if e["tile_px"] == size and (e["model"] != "jev" or e["method"] == "one-call")]
    headline.sort(key=lambda e: -e["found_rate"])
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

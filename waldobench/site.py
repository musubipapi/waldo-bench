"""Site: export everything the results page needs into site/data and site/assets (no API calls).

Reads results.json (from `results`), the run folders it names, and the prepared tiles. Writes:
  site/data/bench.json   leaderboard, tile-size curve, every scene with each model's pick, decoys
  site/data/heat.json    each model's answer for every tile (for the "where it looked" view)
  site/assets/...        scenes, thumbnails, the tiles models chose, and close-up crops

site/assets holds the illustrations and is git-ignored: do not publish it.
"""

import json
import shutil
from collections import defaultdict
from pathlib import Path

from PIL import Image

from . import search_batched, search_jev, search_tiles
from .common import ROOT, read_jsonl, sha, write_json
from .results import success_times
from .models import MODELS, base_model, display

DECOY_MIN_MODELS = 3  # a "decoy" is a wrong spot at least this many different models chose (Jev's three rows count once)
ATTRIBUTION = {
    "paper": "Mengmi Zhang, Jiashi Feng, Keng Teck Ma, Joo Hwee Lim, Qi Zhao and Gabriel Kreiman, “Finding any Waldo "
             "with zero-shot invariant and efficient visual search,” Nature Communications 9, 3730 (2018)",
    "doi": "https://doi.org/10.1038/s41467-018-06217-x",
    "repository": "https://github.com/kreimanlab/VisualSearchZeroShot",
    "illustrations": "Where’s Wally? / Where’s Waldo? by Martin Handford",
}


def scene_order(scene_id):
    return tuple(map(int, scene_id.split("_")))


def area_shared(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def clusters(picks, tile):
    """Group wrong picks whose tiles share at least a quarter of a tile's area (single link)."""
    groups = []
    for pick in picks:
        joined = [g for g in groups if any(area_shared(pick["box"], other["box"]) >= tile * tile / 4 for other in g)]
        groups = [g for g in groups if g not in joined] + [[pick] + [p for g in joined for p in g]]
    return groups


def crop_box(scene, box, size):
    """A square region at least `size` pixels wide, centred on `box`, kept inside the picture."""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    side = int(max(size, box[2] - box[0], box[3] - box[1]))
    x0 = int(min(max(0, cx - side / 2), scene.width - side))
    y0 = int(min(max(0, cy - side / 2), scene.height - side))
    return [x0, y0, x0 + side, y0 + side]


def save_crop(scene, box, size, out):
    region = crop_box(scene, box, size)
    scene.crop(region).resize((384, 384), Image.LANCZOS).save(out, quality=88)
    return region


def answer_times(run: Path, alias: str):
    """When each tile's answer arrives, in seconds after its search started, counting only successful requests
    (results.success_times), for the race replay."""
    return {case: s for (model, case, repeat), s in success_times(run, "parallel")[1].items() if model == alias and repeat == 0}


def model_picks(entry, cases_by_page):
    """Each scene's chosen tile, found flag, confidence and time for one headline entry; plus its per-tile answers."""
    run = ROOT / entry["run"]
    source = entry.get("run_model", entry["model"])  # the model's name inside the run folder
    picks, heat = {}, {}
    if entry["method"] in ("one-call", "zoom"):
        timing = ROOT / entry["timing_run"]
        timed = {(r["page"], r["repeat"]): r["wall_s"] for r in read_jsonl(timing / "searches.jsonl")}
        box_s = defaultdict(float)  # older runs also asked an unscored Box question; leave its time out
        for call in read_jsonl(timing / "calls.jsonl"):
            if call["step"] == "box":
                box_s[call["page"], call["repeat"]] += call["latency_s"]
        for row in read_jsonl(run / "searches.jsonl"):
            if row["repeat"] == 0:
                chosen = row.get("chosen_tile", row.get("level1_tile"))  # runs before the cleanup said "level1"
                picks[row["page"]] = {"tile": chosen, "found": bool(row["found"]), "complete": chosen is not None,
                                      "seconds": timed[row["page"], 0] - box_s[row["page"], 0],
                                      # A Choice gives a share of one vote over all tiles, not a probability: shown as "–".
                                      "confidence": None}
        for row in read_jsonl(run / "searches.jsonl"):  # zoom: its vote among the small tiles inside the chosen large one
            if row["repeat"] == 0 and row.get("probabilities"):
                heat.update(row["probabilities"])
        for call in read_jsonl(run / "calls.jsonl") if entry["method"] == "one-call" else []:
            if call["step"].startswith("choice") and call["repeat"] == 0 and isinstance(call["response"], dict):
                probabilities = call["response"]["answers"]["tile"].get("probabilities") or {}
                for i, case in enumerate(cases_by_page[call["page"]], 1):
                    heat[case["id"]] = probabilities.get(f"tile_{i}")
    else:
        rows = read_jsonl(run / "searches.jsonl") if entry["method"] == "batched" else json.loads((run / "summary.json").read_text())["page_results"]
        for row in rows:
            if row["model"] == source and row["repeat"] == 0:
                picks[row["page"]] = {"tile": row["winner"], "found": bool(row["top1_hit"]), "complete": bool(row["complete"]),
                                      "seconds": row["wall_s"], "confidence": row["top_probability"]}
        for row in read_jsonl(run / "predictions.jsonl"):
            if row["model"] == source and row["kind"] == "search" and row["repeat"] == 0:
                heat[row["case_id"]] = row["answer"]
    # Time when the model works: successful requests only (results.success_times).
    timed = success_times(ROOT / entry.get("timing_run", entry["run"]), entry["method"])[0]
    for page, pick in picks.items():
        if pick["complete"] and (source, page, 0) in timed:
            pick["seconds"] = timed[source, page, 0]
    return picks, heat


def build(runs_file: Path, results_dir: Path, site: Path) -> dict:
    spec = json.loads(runs_file.read_text())
    results = json.loads((results_dir / "results.json").read_text())
    size = results["headline_tile_px"]
    tiles_path = ROOT / spec["tiles"][str(size)]
    manifest = json.loads(tiles_path.read_text())
    tiles_dir = tiles_path.parent
    cases_by_page = defaultdict(list)
    for case in manifest["cases"]:
        cases_by_page[case["page"]].append(case)
    case_by_id = {c["id"]: c for c in manifest["cases"]}
    headline = results["headline"]
    order = [e["model"] for e in headline]
    for folder in ("assets/scenes", "assets/thumbs", "assets/tiles", "assets/crops", "data"):
        (site / folder).mkdir(parents=True, exist_ok=True)
    answers = {e["model"]: model_picks(e, cases_by_page) for e in headline}
    arrivals = {e["model"]: answer_times(ROOT / e["run"], e.get("run_model", e["model"])) for e in headline if e["method"] == "parallel"}

    scenes, heat_out, used_tiles = [], {}, set()
    for number, page in enumerate(sorted(manifest["pages"], key=lambda p: scene_order(p["id"])), 1):
        scene_path = tiles_dir / page["scene_image"]
        if sha(scene_path.read_bytes()) != page["scene_sha256"]:
            raise ValueError(f"Scene {page['id']} changed")
        shutil.copyfile(scene_path, site / f"assets/scenes/{page['id']}.jpg")
        with Image.open(scene_path) as opened:
            scene = opened.convert("RGB")
        thumb = scene.copy()
        thumb.thumbnail((480, 480))
        thumb.save(site / f"assets/thumbs/{page['id']}.jpg", quality=82)
        truth = page["truth_boxes_pixels"][0]
        save_crop(scene, truth, 160, site / f"assets/crops/waldo-{page['id']}.jpg")
        picks = {}
        for alias in order:
            pick = dict(answers[alias][0][page["page"]])
            chosen = case_by_id.get(pick.pop("tile"))
            pick.update(tile=chosen["id"] if chosen else None, box=chosen["box_pixels"] if chosen else None)
            if chosen:
                used_tiles.add(chosen["id"])
                pick["tileImage"] = f"assets/tiles/{chosen['image_sha256']}.jpg"
            picks[alias] = pick
        cases = cases_by_page[page["page"]]
        heat_out[page["id"]] = {"tiles": [c["box_pixels"] for c in cases], "positive": [i for i, c in enumerate(cases) if c["positive"]],
                                "heat": {a: [None if answers[a][1].get(c["id"]) is None else round(answers[a][1][c["id"]], 4) for c in cases] for a in order},
                                # Seconds after the search started that each tile's answer arrived. Jev answers all tiles in one request.
                                "times": {a: [round(arrivals[a][c["id"]], 2) if a in arrivals else round(picks[a]["seconds"], 2) for c in cases] for a in order}}
        scenes.append({"id": page["id"], "number": number, "image": f"assets/scenes/{page['id']}.jpg", "thumb": f"assets/thumbs/{page['id']}.jpg",
                       "width": page["size"][0], "height": page["size"][1], "truth": truth, "masked": bool(page.get("mask_applied")),
                       "waldoCrop": f"assets/crops/waldo-{page['id']}.jpg", "picks": picks, "foundBy": sum(p["found"] for p in picks.values())})
        scene.close()
    for case_id in used_tiles:
        case = case_by_id[case_id]
        shutil.copyfile(tiles_dir / case["image"], site / f"assets/tiles/{case['image_sha256']}.jpg")

    # Decoys: wrong spots that several models chose.
    decoys = []
    for s in scenes:
        wrong = [{"model": a, "box": p["box"]} for a, p in s["picks"].items() if p["box"] and p["complete"] and not p["found"]]
        for group in clusters(wrong, size):
            fooled = sorted({p["model"] for p in group}, key=order.index)
            if len({base_model(a) for a in fooled}) < DECOY_MIN_MODELS:
                continue
            boxes = [p["box"] for p in group]
            core = [max(b[0] for b in boxes), max(b[1] for b in boxes), min(b[2] for b in boxes), min(b[3] for b in boxes)]
            if core[2] - core[0] < 32 or core[3] - core[1] < 32:
                core = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
            with Image.open(site / s["image"]) as opened:
                picture = opened.convert("RGB")
            region = crop_box(picture, core, 128)
            key = f"decoy-{s['id']}-{region[0]}-{region[1]}"  # named by position so names in copy.json stay attached
            save_crop(picture, core, 128, site / f"assets/crops/{key}.jpg")
            decoys.append({"id": key, "scene": s["id"], "number": s["number"], "models": fooled, "fooled": len(fooled),
                           "box": region, "crop": f"assets/crops/{key}.jpg", "foundBy": [a for a, p in s["picks"].items() if p["found"]]})
    decoys.sort(key=lambda d: (-d["fooled"], d["number"]))

    models = []
    for entry in headline:
        alias = entry["model"]
        models.append({**{k: entry[k] for k in ("model", "model_id", "method", "found", "searches", "found_rate", "found_ci95",
                                                 "p50_search_s", "usd_per_scene", "rank")},
                       "name": display(alias)["name"], "short": display(alias)["short"], "maker": display(alias)["maker"],
                       "base": base_model(alias), "baseName": MODELS[base_model(alias)]["name"],
                       "provider": display(alias)["provider"], "unfinished": entry["searches"] - entry["complete_searches"],
                       "missesPass1": [s["id"] for s in scenes if not s["picks"][alias]["found"]], "beatenBy": entry["beaten_by"]})
    bench = {
        "dataset": {"name": "IVSN Waldo quadrants (Zhang et al. 2018)", "pictures": len(scenes),
                    "tiles": sum(len(v) for v in cases_by_page.values()), "tilePx": size,
                    "tilesPerPicture": [min(len(v) for v in cases_by_page.values()), max(len(v) for v in cases_by_page.values())],
                    "stridePx": manifest["preprocessing"]["stride"], "sentPx": manifest["preprocessing"]["sent_size"]},
        "baselines": {"random": {str(k): v for k, v in results["baselines"]["random_tile"].items()}, "middle": results["baselines"]["middle_tile"]},
        "models": models,
        "curve": [{k: e[k] for k in ("model", "tile_px", "method", "found", "searches", "found_rate", "found_ci95", "usd_per_scene", "p50_search_s")}
                  for e in results["all_entries"]],
        "paired": results["head_to_head"],
        "prompts": {"noul": search_tiles.INSTRUCTIONS, "criteria": search_tiles.CRITERIA,
                    "choiceLead": search_jev.CHOICE_LEAD, "choiceDetail": search_jev.DETAIL,
                    "batchedLead": search_batched.LEAD, "batchedQuestion": search_batched.QUESTION},
        "scenes": scenes, "decoys": decoys, "attribution": ATTRIBUTION,
    }
    write_json(site / "data/bench.json", bench)
    (site / "data/heat.json").write_text(json.dumps(heat_out, separators=(",", ":")))
    parallel = next(e for e in headline if e["method"] == "parallel")
    shutil.copyfile(ROOT / parallel["run"] / "reference.jpg", site / "assets/reference.jpg")
    # Fail closed if the bundle somehow contains the API key.
    env = ROOT / ".env"
    secret = next((l.split("=", 1)[1].strip().strip("\"'") for l in env.read_text().splitlines() if l.startswith("OPENROUTER_API_KEY=")), None) if env.exists() else None
    if secret and any(secret.encode() in p.read_bytes() for p in site.rglob("*") if p.is_file()):
        raise ValueError("The API key ended up in the site bundle")
    return bench

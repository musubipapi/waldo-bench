"""Command line: `uv run python -m waldobench <step>`. Run `uv run python -m waldobench -h` for the steps."""

import argparse
from pathlib import Path

from . import dataset, results, search_batched, search_jev, search_tiles, site
from .common import ROOT
from .models import MODELS, TILE_MODELS

SOURCE = ROOT / "data/ivsn-source/waldo"
RUNS_FILE = ROOT / "results/waldo-bench-v1/runs.json"
RESULTS = ROOT / "results/waldo-bench-v1"
STRIDE = {384: 288, 192: 144, 128: 80}  # tiles overlap so Waldo is never cut in half


def main(argv=None):
    parser = argparse.ArgumentParser(prog="waldobench", description="Waldo Bench: can image-input decision models find Waldo?")
    steps = parser.add_subparsers(dest="step", required=True)

    step = steps.add_parser("extract", help="unpack the Waldo images from the IVSN archive")
    step.add_argument("archive", type=Path, help="the downloaded IVSN Part 1 .tar.gz")
    step.add_argument("--source", type=Path, default=SOURCE)

    step = steps.add_parser("prepare", help="hide printed text and cut every scene into tiles")
    step.add_argument("--tile", type=int, default=128, help="tile size in pixels (default 128)")
    step.add_argument("--stride", type=int, help="pixels between tiles (default: 80 for 128, 144 for 192, 288 for 384)")
    step.add_argument("--source", type=Path, default=SOURCE)
    step.add_argument("--output", type=Path, help="default data/tiles-<tile>")

    def run_options(step, output, cost, attempts):
        step.add_argument("--tiles", type=Path, default=ROOT / "data/tiles-128/manifest.json", help="manifest from `prepare`")
        step.add_argument("--output", type=Path, default=ROOT / output)
        step.add_argument("--source", type=Path, default=SOURCE, help="for the reference picture")
        step.add_argument("--concurrency", type=int, default=16, help="requests in flight")
        step.add_argument("--max-cost-usd", type=float, default=cost, help="stop when known spend reaches this")
        step.add_argument("--max-attempts", type=int, default=attempts, help="stop after this many HTTP requests")
        step.add_argument("--env-file", type=Path, default=ROOT / ".env")
        step.add_argument("--limit-pages", type=int, help="only the first N scenes (a quick test, not a result)")

    step = steps.add_parser("run-tiles", help="one yes/no question per tile, for each model (costs money)")
    run_options(step, "runs/tiles-128", 8.0, 150_000)
    step.add_argument("--models", nargs="+", choices=list(MODELS), default=TILE_MODELS)
    step.add_argument("--repeat", type=int, default=1, help="passes over every scene")

    step = steps.add_parser("resume", help="finish a tile run that stopped, optionally redoing failed searches")
    step.add_argument("--tiles", type=Path, default=ROOT / "data/tiles-128/manifest.json")
    step.add_argument("--output", type=Path, required=True, help="the run folder to finish")
    step.add_argument("--redo-failed", action="store_true", help="also redo searches that hit a provider error")
    step.add_argument("--rounds", type=int, default=3, help="with --redo-failed: try this many times")
    step.add_argument("--redo-slow", type=float, metavar="N", help="also redo searches slower than N x the model's median (provider stalls)")
    step.add_argument("--max-cost-usd", type=float, default=8.0)
    step.add_argument("--max-attempts", type=int, default=150_000)
    step.add_argument("--env-file", type=Path, default=ROOT / ".env")

    step = steps.add_parser("run-jev", help="Jev 1.14: one Choice request per scene (costs money)")
    run_options(step, "runs/jev-128", 1.0, 1000)
    step.add_argument("--zoom", action="store_true", help="TypeSafe's search: a Choice among large tiles, then among the small tiles inside")
    step.add_argument("--coarse-tiles", type=Path, default=ROOT / "data/tiles-384/manifest.json", help="with --zoom: the large tiles")

    step = steps.add_parser("run-batched", help="one request per scene with a yes/no question per tile (costs money)")
    run_options(step, "runs/batched-128", 1.0, 1000)
    step.add_argument("--model", choices=list(MODELS), default="jev", help="a model that reads images inside questions")
    step.add_argument("--redo-failed", action="store_true", help="finish an existing run: redo its failed scenes one at a time")

    step = steps.add_parser("results", help="combine runs into the leaderboard and likely ranges")
    step.add_argument("--runs", type=Path, default=RUNS_FILE, help="which runs make up the results")
    step.add_argument("--output", type=Path, default=RESULTS)

    step = steps.add_parser("site", help="export data and pictures for the results page in site/")
    step.add_argument("--runs", type=Path, default=RUNS_FILE)
    step.add_argument("--results", type=Path, default=RESULTS)
    step.add_argument("--site", type=Path, default=ROOT / "site")

    args = parser.parse_args(argv)
    if args.step == "extract":
        print(f"Extracted {dataset.extract(args.archive, args.source)} image files to {args.source}")
    elif args.step == "prepare":
        stride = args.stride or STRIDE.get(args.tile) or parser.error("give --stride for this tile size")
        manifest = dataset.prepare(args.source, args.output or ROOT / f"data/tiles-{args.tile}", args.tile, stride)
        print(f"Prepared {len(manifest['pages'])} scenes and {len(manifest['cases'])} tiles of {args.tile} px")
    elif args.step == "run-tiles":
        search_tiles.run(args.tiles, args.source, args.output, args.models, args.repeat, args.concurrency,
                         args.max_attempts, args.max_cost_usd, args.env_file, args.limit_pages)
    elif args.step == "resume":
        for round_number in range(args.rounds if args.redo_failed else 1):
            summary = search_tiles.resume(args.tiles, args.output, args.redo_failed, None, args.max_attempts, args.max_cost_usd, args.env_file,
                                          args.redo_slow if round_number == 0 else None)
            if summary["complete"] and all(m["complete_searches"] == m["searches"] for m in summary["models"].values()):
                break
    elif args.step == "run-jev" and args.zoom:
        search_jev.run_zoom(args.tiles, args.coarse_tiles, args.source, args.output, args.max_attempts, args.max_cost_usd, args.env_file, args.limit_pages)
    elif args.step == "run-jev":
        search_jev.run(args.tiles, args.source, args.output, 1, args.concurrency, args.max_attempts, args.max_cost_usd, args.env_file, args.limit_pages)
    elif args.step == "run-batched" and args.redo_failed:
        print(f"Redid {search_batched.redo_failed(args.tiles, args.output, args.max_attempts, args.max_cost_usd, args.env_file)} scenes")
    elif args.step == "run-batched":
        search_batched.run(args.tiles, args.source, args.output, args.model, args.concurrency, args.max_attempts, args.max_cost_usd,
                           args.env_file, args.limit_pages)
    elif args.step == "results":
        result = results.build(args.runs, args.output)
        for e in result["headline"]:
            low, high = e["found_ci95"]
            print(f"{e['rank']:>2}  {e['name']:22} {e['found']:>2}/{e['searches']}  {e['found_rate']:.0%}  likely {low:.0%}-{high:.0%}  "
                  f"${e['usd_per_scene']:.4f}/scene  {e['p50_search_s']:.1f} s")
    elif args.step == "site":
        bench = site.build(args.runs, args.results, args.site)
        print(f"Wrote {args.site / 'data'}: {len(bench['scenes'])} scenes, {len(bench['decoys'])} decoys")
        print(f"View it: python3 -m http.server 8000 -d {args.site}")


if __name__ == "__main__":
    main()

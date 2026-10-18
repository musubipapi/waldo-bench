# Waldo Bench

**How well can a decision model find Waldo?**

Waldo Bench tests image-input *decision models* on a children's puzzle: find Waldo in a crowded
Where's Waldo scene. Decision models (also called System One models) do not write text. They answer
typed questions, such as yes/no or "pick one of these options", and return a probability.

We gave eleven of these models 66 scenes and a picture of Waldo. Each scene is cut into small tiles, and
each model has to choose the tile that holds Waldo. We count how often it is right, what it costs, and
how long it takes.

## Results

One pass per model: a one-shot test. Rows that found Waldo equally often share a rank; the cheaper, then
the faster, comes first. All models were called through
[OpenRouter's Decisions API](https://openrouter.ai/docs). Jev 1.14 has 3 rows, one per way of asking it
(see [Why Jev 1.14 has 3 rows](#why-jev-114-has-3-rows)).

| Rank | Model | Found | Likely range | Cost per scene | Median time |
|---:|---|---|---|---:|---:|
| 1 | Liquid d1-ultra | 53/66 (80%) | 71–89% | $0.0052 | 3.36 s |
| 2 | Liquid d1 | 49/66 (74%) | 64–85% | $0.0025 | 4.52 s |
| 3 | Jev 1.14 (yes/no, batched) | 48/66 (73%) | 62–83% | $0.0051 | 1.54 s |
| 3 | Jev 1.14 | 48/66 (73%) | 62–83% | $0.0113 | 2.39 s |
| 5 | Decider Flash V1.2 | 47/66 (71%) | 59–82% | $0.0010 | 2.61 s |
| 5 | Respan Span-02 | 47/66 (71%) | 61–82% | $0.0016 | 3.31 s |
| 5 | Mercury Decide | 47/66 (71%) | 61–82% | $0.0020 | 4.75 s |
| 5 | Decider V1.2 | 47/66 (71%) | 59–82% | $0.0021 | 4.59 s |
| 9 | Clef | 46/66 (70%) | 58–80% | $0.0274 | 8.19 s |
| 10 | Jev 1.14 (Choice) | 45/66 (68%) | 58–79% | $0.0041 | 1.51 s |
| 10 | Clef Flash | 45/66 (68%) | 56–79% | $0.0043 | 13.55 s |
| 12 | Clef Omni | 44/66 (67%) | 55–77% | $0.0170 | 6.02 s |
| 13 | GPT-6 Luna Decisions | 35/66 (53%) | 41–65% | $0.0121 | 3.13 s |
| – | *Random tile* | *1.9%* | | | |
| – | *Always the middle tile* | *1.5%* | | | |

**Most found: Liquid d1-ultra.** It finds Waldo most often, but its lead is not clear: Liquid d1 is 6 points
behind (95% interval: −2 to 15).

**On a budget: Decider Flash V1.2.** It is the cheapest model, at $0.0010 a scene, and finds Waldo 71% of
the time. No model is clearly more accurate.

Other findings:

- **Smaller tiles help.** Averaged over the 11 models (1 request per tile), the found rate goes from 45%
  (384 px tiles) to 64% (192 px) to 70% (128 px). Over the same change, a random guess gets almost
  8 times worse (14.7% to 1.9%).
- **The most common mistake is Wenda**, Waldo's look-alike friend (same hat, glasses and stripes). In one
  scene, every model chose her instead of Waldo.
- **Most models are more confident than accurate.** d1 is on average 91% sure of its pick but right 74%
  of the time. Decider V1.2 (71% sure, right 71%) is the best calibrated.
- **Some models vary.** Asked again with the same requests, d1-ultra, d1 and Jev 1.14 give slightly
  different answers (2 to 3 scenes per run). The other models give the same answers.

`results/waldo-bench-v1/` has the full numbers: `results.json`, `leaderboard.csv`, and `curve.csv`
(every model at every tile size).

## How it works

### The scenes

The scenes come from the IVSN dataset ([Zhang et al. 2018](https://doi.org/10.1038/s41467-018-06217-x),
Kreiman lab). It has 67 Where's Waldo scenes, each a quarter of a book page, with a box around Waldo.
We leave out one scene (3_1). It is an earlier edition of a scene with several Waldo look-alikes.
13 scenes carry printed text, such as titles. The dataset includes masks for this text, and we paint it grey.

### The tiles

Each scene is cut into square tiles of 128 × 128 pixels, one every 80 pixels, so the tiles overlap.
A scene has 187 to 228 tiles (13,957 in all). Every Waldo fits inside one tile. Before sending, each
tile is enlarged to 384 × 384 pixels.

### The question

Every model gets **one request per tile**. The request holds two images, a reference picture of Waldo
and then the tile, and one yes/no question (a *Noul*):

> The first image is a reference picture of Waldo (Wally). The second image is a crop from a crowded
> illustrated scene. Is Waldo, the same character as in the reference, in the second image? He is
> often small and partly hidden, so sometimes only his face, round glasses, brown hair and
> red-and-white cap are visible. Other people in red-and-white stripes, and striped objects, are not Waldo.

The model returns P(yes) for each tile. Its answer for the scene is the tile with the highest P(yes).
Each model runs alone, one scene at a time, with 16 tile requests at a time.

### Why Jev 1.14 has 3 rows

We run every model every way its API allows. All 11 models can take one tile per request, so every model
has that row. Only Jev 1.14 can also take a whole scene in one request, because it reads an image inside
each question. The other models do not, or accept only a few images per request. So Jev 1.14 has two
more rows, each run one scene at a time:

- **Yes/no, batched:** one request per scene, with the picture of Waldo once and one yes/no question per
  tile. It is scored like the per-tile method.
- **Choice:** one request per scene, with all tiles of the scene as the options. TypeSafe documents this
  method for large images.

The tiles, picture and wording are the same in every method. Decider Flash V1.2 can also take a whole
scene, but Perplexity rate-limited those requests so often that the test was not fair, so it has only its
per-tile row.

Before any scored request, each model must pass a short check that shows it reads every image it is
sent, in the right order.

### Scoring

- **Found:** the chosen tile overlaps the box around Waldo. When two tiles are equally likely, a fixed
  hash breaks the tie. The hash is the same for every model and does not look at the answer.
- **Likely range:** the 95% interval of the found rate. We re-draw the scenes at random, with repeats,
  4,000 times, and keep the middle 95% of the results. With only 66 scenes, luck matters, so ranges that
  overlap a lot are too close to call.
- **Head-to-head:** the same re-drawing, done for two models at once on the gap between them.
- **Cost:** what OpenRouter billed (`usage.cost`) for the requests behind the answers, per scene.
  Failed attempts and searches we ran again are left out.
- **Median time:** the time to search one whole scene, counting only successful requests. We measure
  speed when the model works, not how reliable its provider is.
- Each model is pinned to one provider, with no fallback.
- A search that hit a provider error, or stalled (took more than 3 times its model's median time), was run
  again in full. Every model finished all 66 scenes. The rule looks only at time, never at the answer.

## Models

| Model | OpenRouter id | Provider |
|---|---|---|
| Liquid d1-ultra | `liquid/d1-ultra` | Liquid |
| Liquid d1 | `liquid/d1` | Liquid |
| Decider V1.2 | `perplexity/pplx-decider-v1.2` | Perplexity |
| Decider Flash V1.2 | `perplexity/pplx-decider-flash-v1.2` | Perplexity |
| Respan Span-02 | `respan/span-02` | Respan |
| Jev 1.14 | `typesafe/jev-1.14` | TypeSafe |
| Clef | `cloudflare/clef` | Cloudflare |
| Clef Flash | `cloudflare/clef-flash` | Cloudflare |
| Clef Omni | `cloudflare/clef-omni` | Cloudflare |
| GPT-6 Luna Decisions | `openai/gpt-6-luna-decisions` | OpenAI |
| Mercury Decide | `inception/mercury-decide` | Inception |

Not included: ScaleDown Classify-1 (the endpoint rejects images). Decider V1.1 27B was in the first
results, but OpenRouter retired it on 18 October 2026, so its results cannot be repeated; Decider V1.2
and Decider Flash V1.2 replace it. Mercury Decide was left out on 16 October because its provider
rate-limited every request; it works now and is included.

## Run it yourself

You need Python 3.11 or newer, [uv](https://docs.astral.sh/uv/), and an
[OpenRouter API key](https://openrouter.ai/settings/keys) with credit. The full run at 128 px costs about
$6.40 and takes about 75 minutes.

```sh
cp .env.example .env              # then add your OpenRouter key to .env

# 1. Get the scenes. Download Part 1 of the IVSN datasets (Google Drive link in
#    https://github.com/kreimanlab/VisualSearchZeroShot), then unpack the Waldo images:
uv run python -m waldobench extract path/to/the-downloaded-archive.tar.gz

# 2. Hide the printed text and cut every scene into 128 px tiles (offline, about 30 s).
uv run python -m waldobench prepare --tile 128

# 3. Run the models. These calls cost money.
uv run python -m waldobench run-tiles                     # every model, 1 request per tile, about $5.80
uv run python -m waldobench run-jev --concurrency 1       # Jev 1.14, Choice, about $0.27
uv run python -m waldobench run-batched --concurrency 1   # Jev 1.14, yes/no batched, about $0.34

# If a tile run stops (out of credit, provider errors), finish it. Finished searches are never asked again.
uv run python -m waldobench resume --output runs/tiles-128 --redo-failed

# 4. Build the results and the results page.
uv run python -m waldobench results --runs my-runs.json --output results/mine
uv run python -m waldobench site --runs my-runs.json --results results/mine
python3 -m http.server 8000 -d site    # then open http://localhost:8000
```

`results/waldo-bench-v1/runs.json` lists the runs behind the published results. For your own runs,
copy it to `my-runs.json`, change the paths to your run folders, and remove any tile sizes you did not run. The tile-size chart also needs runs at 192 px and 384 px, for example
`prepare --tile 192`, then `run-tiles --tiles data/tiles-192/manifest.json --output runs/tiles-192`.

The published runs were made on 18 October 2026 with this code. The run folders are not in this
repository, because they contain the illustrations.

Add `--limit-pages 2` to a run step for a cheap test on two scenes.

### What a run saves

Every run folder keeps the full record: the settings, every answer the API returned (with a hash of the
request that produced it), the billed cost of each request, and the time of each search.
`summary.json` holds the scores.

The results page reads `site/data/` and `site/assets/`, which `waldobench site` builds from your runs and
the IVSN scenes. A fresh clone does not have them, so the page shows a "data missing" note until you build it.

## Repository layout

| Path | What it does |
|---|---|
| `waldobench/__main__.py` | The command line: one subcommand per step |
| `waldobench/dataset.py` | Unpacks IVSN, hides printed text, cuts scenes into tiles |
| `waldobench/search_tiles.py` | One yes/no question per tile; run, resume, and score |
| `waldobench/search_jev.py` | Jev 1.14: one Choice question per scene |
| `waldobench/search_batched.py` | One request per scene with a yes/no question per tile (Jev 1.14) |
| `waldobench/openrouter.py` | Requests, retries, spending caps, answer checks |
| `waldobench/results.py` | Leaderboard, likely ranges, head-to-head, verdict |
| `waldobench/site.py` | Exports data and pictures for the results page |
| `waldobench/models.py` | The models and their providers |
| `waldobench/common.py` | Small shared helpers: hashing, JSON files, images, overlap |
| `site/` | The results page and the "You vs. the models" game |
| `results/waldo-bench-v1/` | The published results and the runs behind them |
| `tests/` | A few offline checks: `uv run python -m unittest` |

## Data and credit

The scenes and labels come from the IVSN dataset: Mengmi Zhang, Jiashi Feng, Keng Teck Ma, Joo Hwee Lim,
Qi Zhao and Gabriel Kreiman, "Finding any Waldo with zero-shot invariant and efficient visual search,"
*Nature Communications* 9, 3730 (2018). The illustrations are from *Where's Wally?* / *Where's Waldo?*
by Martin Handford.

This repository does not include any scenes or illustrations. You download them yourself from the
Kreiman lab, under their license. `waldobench site` copies pictures into `site/assets/`, which is
git-ignored. Do not publish that folder. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

The code is MIT licensed. See [LICENSE](LICENSE). The license covers the code only: the IVSN dataset
and the Where's Waldo illustrations keep their own terms (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

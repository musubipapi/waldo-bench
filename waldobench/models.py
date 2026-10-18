"""The image-input decision models in Waldo Bench, as listed on OpenRouter on 16 October 2026.

Decider V1.1 27B was retired on OpenRouter by 18 October 2026; Decider V1.2 and Decider Flash V1.2 replace it.
Mercury Decide was left out on 16 October (the provider rate-limited every request) and added on 18 October.

Each entry: OpenRouter id, the one provider we pin it to (no fallbacks), and display names.
"""

MODELS = {
    "d1-ultra": {"id": "liquid/d1-ultra", "provider": "liquid", "name": "Liquid d1-ultra", "short": "d1-ultra", "maker": "Liquid"},
    "d1": {"id": "liquid/d1", "provider": "liquid", "name": "Liquid d1", "short": "d1", "maker": "Liquid"},
    "decider-1.2": {"id": "perplexity/pplx-decider-v1.2", "provider": "perplexity", "name": "Decider V1.2", "short": "Decider 1.2", "maker": "Perplexity"},
    "decider-flash-1.2": {"id": "perplexity/pplx-decider-flash-v1.2", "provider": "perplexity", "name": "Decider Flash V1.2", "short": "Decider Flash 1.2", "maker": "Perplexity"},
    "span-02": {"id": "respan/span-02", "provider": "respan", "name": "Respan Span-02", "short": "Span-02", "maker": "Respan"},
    "jev": {"id": "typesafe/jev-1.14", "provider": "typesafe", "name": "Jev 1.14", "short": "Jev 1.14", "maker": "TypeSafe"},
    "clef": {"id": "cloudflare/clef", "provider": "cloudflare", "name": "Clef", "short": "Clef", "maker": "Cloudflare"},
    "clef-flash": {"id": "cloudflare/clef-flash", "provider": "cloudflare", "name": "Clef Flash", "short": "Clef Flash", "maker": "Cloudflare"},
    "clef-omni": {"id": "cloudflare/clef-omni", "provider": "cloudflare", "name": "Clef Omni", "short": "Clef Omni", "maker": "Cloudflare"},
    "luna": {"id": "openai/gpt-6-luna-decisions", "provider": "openai", "name": "GPT-6 Luna Decisions", "short": "Luna Dec.", "maker": "OpenAI"},
    "mercury": {"id": "inception/mercury-decide", "provider": "inception", "name": "Mercury Decide", "short": "Mercury", "maker": "Inception"},
}

# Every model is asked one tile at a time (one yes/no question per tile); see VARIANTS for the whole-scene methods.
TILE_MODELS = list(MODELS)

# Jev 1.14 reads images inside its questions and takes a whole scene's tiles in one request, so it is also asked
# that way: three leaderboard rows. runs.json maps a run's "jev" rows to one of these.
VARIANTS = {
    "jev": {"name": "Jev 1.14 (Choice)", "short": "Jev Choice"},
    "jev-batched": {"of": "jev", "name": "Jev 1.14 (yes/no, batched)", "short": "Jev batched"},
    "jev-tiles": {"of": "jev", "name": "Jev 1.14", "short": "Jev 1.14"},  # 1 request per tile, like every model
}


def display(alias):
    """Names and ids for one leaderboard row: the model's entry, renamed if the row is one of its variants."""
    variant = VARIANTS.get(alias, {})
    return {**MODELS[variant.get("of", alias)], **variant}


def base_model(alias):
    return VARIANTS.get(alias, {}).get("of", alias)

# Other image-input decision models on OpenRouter that day, and why they are not in the benchmark.
NOT_INCLUDED = {
    "scaledown/classify-1": "The endpoint rejects images, although the catalog lists image input.",
}

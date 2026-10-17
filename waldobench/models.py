"""The nine image-input decision models in Waldo Bench, as listed on OpenRouter on 16 October 2026.

Each entry: OpenRouter id, the one provider we pin it to (no fallbacks), and display names.
"""

MODELS = {
    "d1-ultra": {"id": "liquid/d1-ultra", "provider": "liquid", "name": "Liquid d1-ultra", "short": "d1-ultra", "maker": "Liquid"},
    "d1": {"id": "liquid/d1", "provider": "liquid", "name": "Liquid d1", "short": "d1", "maker": "Liquid"},
    "decider": {"id": "perplexity/pplx-decider-v1.1-27b", "provider": "perplexity", "name": "Decider V1.1 27B", "short": "Decider", "maker": "Perplexity"},
    "span-02": {"id": "respan/span-02", "provider": "respan", "name": "Respan Span-02", "short": "Span-02", "maker": "Respan"},
    "jev": {"id": "typesafe/jev-1.14", "provider": "typesafe", "name": "Jev 1.14", "short": "Jev 1.14", "maker": "TypeSafe"},
    "clef": {"id": "cloudflare/clef", "provider": "cloudflare", "name": "Clef", "short": "Clef", "maker": "Cloudflare"},
    "clef-flash": {"id": "cloudflare/clef-flash", "provider": "cloudflare", "name": "Clef Flash", "short": "Clef Flash", "maker": "Cloudflare"},
    "clef-omni": {"id": "cloudflare/clef-omni", "provider": "cloudflare", "name": "Clef Omni", "short": "Clef Omni", "maker": "Cloudflare"},
    "luna": {"id": "openai/gpt-6-luna-decisions", "provider": "openai", "name": "GPT-6 Luna Decisions", "short": "Luna Dec.", "maker": "OpenAI"},
}

# Asked one tile at a time (one yes/no question per tile). Jev is asked with one request per scene instead.
TILE_MODELS = [alias for alias in MODELS if alias != "jev"]

# Other image-input decision models on OpenRouter that day, and why they are not in the benchmark.
NOT_INCLUDED = {
    "inception/mercury-decide": "The provider rate-limited even one request at a time.",
    "scaledown/classify-1": "The endpoint rejects images, although the catalog lists image input.",
}

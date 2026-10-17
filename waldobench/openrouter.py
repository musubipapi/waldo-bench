"""Calling the OpenRouter Decisions API: the request, retries, spending caps and answer checks."""

import json
import math
import os
import threading
import time
from datetime import datetime, timezone

import httpx

from .common import sha
from .models import MODELS

API_URL = "https://openrouter.ai/api/alpha/decisions"


def read_key(env_file) -> str:
    """OPENROUTER_API_KEY from the environment, or from a .env file. Never printed or saved."""
    value = os.getenv("OPENROUTER_API_KEY")
    if value:
        return value
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("OPENROUTER_API_KEY="):
                value = line.strip().split("=", 1)[1].strip().strip("\"'")
                if value:
                    return value
    raise ValueError("Set OPENROUTER_API_KEY or put it in .env")


def pinned(alias: str) -> dict:
    """Model and provider fields for a request: one provider, no fallback to another."""
    model = MODELS[alias]
    return {"model": model["id"], "provider": {"order": [model["provider"]], "allow_fallbacks": False}}


def request(client, payload, key) -> dict:
    """Send one request and return a record of it (status, answer, error, latency). The key is scrubbed."""
    started = time.perf_counter()
    stamp = datetime.now(timezone.utc).isoformat()
    status, body, error = None, None, None
    try:
        response = client.post(API_URL, json=payload, headers={"Authorization": "Bearer " + key})
        status = response.status_code
        text = response.text.replace(key, "[redacted]")
        try:
            body = json.loads(text)
        except ValueError:
            error = f"HTTP {status}: non-JSON response: {text[:1000]}"
        if status != 200:
            error = f"HTTP {status}: {json.dumps(body)[:1600]}" if body is not None else error
        elif isinstance(body, dict) and "error" in body:
            error = "OpenRouter error response: " + json.dumps(body["error"])[:1600]
    except httpx.HTTPError as exception:
        error = str(exception).replace(key, "[redacted]")
    return {"started_at": stamp, "http_status": status, "response": body, "error": error,
            "latency_s": time.perf_counter() - started}


def catalog(client, aliases) -> dict:
    """Save what OpenRouter lists for each model, and refuse models that do not take images."""
    response = client.get("https://openrouter.ai/api/v1/models", params={"output_modalities": "decisions"})
    response.raise_for_status()
    available = {model["id"]: model for model in response.json()["data"]}
    result = {}
    for alias in aliases:
        model = available[MODELS[alias]["id"]]
        if "image" not in model["architecture"]["input_modalities"]:
            raise ValueError(f"{alias} does not advertise image input")
        endpoints = client.get("https://openrouter.ai" + model["links"]["details"])
        endpoints.raise_for_status()
        result[alias] = {"configuration": MODELS[alias], "catalog": model, "endpoints": endpoints.json()["data"]}
    return result


def usage_cost(call):
    """The price OpenRouter billed for one request, or None if it did not say."""
    body = call.get("response")
    cost = body.get("usage", {}).get("cost") if isinstance(body, dict) else None
    return cost if isinstance(cost, (float, int)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0 else None


class Budget:
    """Stops a run at a cap on requests or on known spend, or as soon as the account is refused (401/402/403)."""

    def __init__(self, max_attempts, max_cost, previous_calls=()):
        self.lock = threading.Lock()
        self.max_attempts, self.max_cost = max_attempts, max_cost
        self.attempts = len(previous_calls)
        self.cost = sum(usage_cost(c) or 0 for c in previous_calls)
        self.reason = None

    def acquire(self) -> bool:
        with self.lock:
            if self.reason:
                return False
            if self.attempts >= self.max_attempts:
                self.reason = "HTTP attempt cap reached"
                return False
            if self.cost >= self.max_cost:
                self.reason = "Known-cost cap reached; already in-flight requests may still finish"
                return False
            self.attempts += 1
            return True

    def observe(self, call) -> None:
        with self.lock:
            self.cost += usage_cost(call) or 0
            if call["http_status"] in (401, 402, 403):
                self.reason = f"Authentication, credit, or access failure: HTTP {call['http_status']}"


# Errors caused by our own account or caps, not by the model or its provider. A run stopped by one can be resumed.
HALT_MARKERS = ("HTTP 401", "HTTP 402", "HTTP 403", "Authentication, credit, or access failure",
                "Known-cost cap", "HTTP attempt cap", "No request sent")


def ask(client, key, alias, payload, metadata, budget, meta):
    """Send one question. Retries only rate limits (HTTP 429/529), at most three attempts.

    Returns (response or None, error or None, call records). The answer must come from the
    requested model on the pinned provider.
    """
    digest = sha(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
    calls, error = [], "No request sent"
    for attempt in range(1, 4):
        if not budget.acquire():
            return None, budget.reason, calls
        call = request(client, payload, key)
        call.update(model_alias=alias, attempt=attempt, payload_sha256=digest, **meta)
        budget.observe(call)
        calls.append(call)
        error = call["error"]
        if call["http_status"] in (429, 529) and attempt < 3:
            time.sleep(2 ** (attempt - 1))
            continue
        if error:
            return None, error, calls
        response = call["response"]
        if response.get("model") not in {MODELS[alias]["id"], metadata[alias]["catalog"]["canonical_slug"]}:
            return None, "Unexpected model", calls
        if str(response.get("provider", "")).lower().replace(" ", "") != MODELS[alias]["provider"]:
            return None, "Unexpected provider", calls
        return response, None, calls
    return None, error, calls


def noul_probability(response, question="present") -> float:
    """P(yes) from a Noul (yes/no) answer."""
    value = response["answers"][question]["noul"]
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Invalid Noul probability")
    return value

"""Small helpers used by every step: hashing, JSON files, image encoding and tile geometry."""

import base64
import hashlib
import io
import json
import math
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value) -> None:
    """Write through a temporary file so a crash never leaves half a file behind."""
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def append_json(path: Path, value) -> None:
    with path.open("a") as handle:
        handle.write(json.dumps(value, allow_nan=False) + "\n")


def read_jsonl(path: Path) -> list:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


def jpeg(image) -> bytes:
    """Every scene and tile is saved the same way: JPEG quality 90, no chroma subsampling."""
    stream = io.BytesIO()
    image.save(stream, "JPEG", quality=90, subsampling=0)
    return stream.getvalue()


def png(image) -> bytes:
    stream = io.BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def data_uri(raw: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def overlap(a, b) -> bool:
    """Do two [x0, y0, x1, y1] boxes share any area?"""
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1])) > 0


def tile_starts(length: int, size: int, stride: int) -> list:
    """Left (or top) edges of tiles that cover `length` pixels; the last tile is pushed back to the edge."""
    if length < size or not 0 < stride <= size:
        raise ValueError("The image must fit one tile, and the stride may not leave gaps")
    positions = list(range(0, length - size + 1, stride))
    if positions[-1] != length - size:
        positions.append(length - size)
    return positions


def quantile(values, fraction):
    """Linear-interpolated quantile; None when there are no values."""
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return values[low] * (1 - (position - low)) + values[high] * (position - low)

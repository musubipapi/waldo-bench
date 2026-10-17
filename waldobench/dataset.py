"""The scenes: unpack the IVSN archive, hide the printed text, and cut every scene into tiles.

IVSN (Zhang et al. 2018, Kreiman lab) provides 67 Where's Waldo scenes, each a quarter of a book page,
with a box around Waldo. 13 scenes carry printed text (titles, captions); the dataset includes masks for
it, and we paint those areas grey. Scene 3_1 is left out (see EXCLUDED).

A prepared folder holds one JPEG per scene, one JPEG per tile, and manifest.json listing every tile,
its position in the scene, and whether it overlaps Waldo.
"""

import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath

from PIL import Image, ImageChops, ImageFilter, __version__ as pillow_version

from .common import jpeg, now, overlap, sha, tile_starts, write_json

# Part 1 of the datasets in https://github.com/kreimanlab/VisualSearchZeroShot (Google Drive link in its README).
ARCHIVE_URL = "https://drive.google.com/file/d/1ZvmugJDds-CrwTvhIXmyYVxnniNmx7ce/view?usp=sharing"
ARCHIVE_SHA256 = "01bd5a20e2f20bba5456e8bdabc4a11d00f55f445f061ac232ebd4d2cf380640"
EXCLUDED = {"3_1": "An earlier edition of a scene with several Waldo look-alikes, which was removed from the benchmark."}
MAX_EDGE = 1568        # scenes larger than this are scaled down (none are)
SENT_SIZE = 384        # every tile is sent as a 384 x 384 JPEG; smaller tiles are enlarged to it
MAX_TILE_BYTES = 250_000
GREY = (224, 224, 224)  # fill for masked printed text
DATASET = "waldo-bench-ivsn-v1"


def extract(archive: Path, source: Path) -> int:
    """Copy only the Waldo images out of the IVSN archive, after checking it is the exact expected file."""
    with archive.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError(f"This is not the expected IVSN archive (checksum differs). Download Part 1 from {ARCHIVE_URL}")
    count = 0
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            wanted = (member.isfile() and not path.is_absolute() and ".." not in path.parts and len(path.parts) == 4
                      and path.parts[:2] == ("datasets", "waldo")
                      and path.parts[2] in {"fullImage", "stimuli", "gt", "mask", "target"}
                      and path.suffix.lower() in {".jpg", ".jpeg", ".png"})
            if not wanted:
                continue
            raw = tar.extractfile(member).read()
            destination = source.joinpath(*path.parts[2:])
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() and destination.read_bytes() != raw:
                raise ValueError(f"A different file already exists at {destination}")
            destination.write_bytes(raw)
            count += 1
    return count


def masked_scene(source: Path, identifier: str):
    """One scene with its printed text painted grey, plus Waldo's box (in scene pixels)."""
    stimulus = source / "stimuli" / f"cropped_{identifier}.jpg"
    with Image.open(stimulus) as opened:
        image = opened.convert("RGB")
    with Image.open(source / "gt" / f"gt_{identifier}.jpg") as opened:
        label = opened.convert("L").point(lambda v: 255 if v > 127 else 0)
    if image.size != label.size or not label.getbbox():
        raise ValueError(f"Missing or mismatched label for {identifier}")
    mask_path = source / "mask" / stimulus.name
    if mask_path.exists():
        with Image.open(mask_path) as opened:
            mask = opened.convert("L").resize(image.size, Image.Resampling.NEAREST)
        # Dark mask pixels mark text; grow them by 3 px so no letter edges survive.
        mask = mask.point(lambda v: 255 if v < 128 else 0).filter(ImageFilter.MaxFilter(7))
        if ImageChops.multiply(mask, label).getbbox():
            raise ValueError(f"The text mask would hide Waldo in {identifier}")
        image.paste(GREY, mask=mask)
    source_size = image.size
    scale = min(1, MAX_EDGE / max(image.size))
    size = (round(image.width * scale), round(image.height * scale))
    if size != image.size:
        image = image.resize(size, Image.Resampling.LANCZOS)
    x0, y0, x1, y1 = label.getbbox()
    truth = [x0 * size[0] / source_size[0], y0 * size[1] / source_size[1],
             x1 * size[0] / source_size[0], y1 * size[1] / source_size[1]]
    return image, truth, mask_path.exists(), source_size


def prepare(source: Path, output: Path, tile: int, stride: int) -> dict:
    """Cut every scene into overlapping square tiles of `tile` pixels, one every `stride` pixels."""
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"{output} is not empty")
    (output / "images").mkdir(parents=True)
    (output / "scenes").mkdir()
    stimuli = sorted((source / "stimuli").glob("*.jpg"))
    masks = list((source / "mask").glob("*.jpg"))
    if len(stimuli) != 67 or len(masks) != 13:
        raise ValueError("Expected 67 IVSN Waldo scenes and 13 text masks; run the extract step first")
    pages, cases = [], []
    # Page numbers follow the sorted file list of all 67 scenes, so they stay the same with or without exclusions.
    for number, stimulus in enumerate(stimuli, 1):
        identifier = stimulus.stem.removeprefix("cropped_")
        if identifier in EXCLUDED:
            continue
        image, truth, masked, source_size = masked_scene(source, identifier)
        book, part = map(int, identifier.split("_"))
        [scan] = (source / "fullImage").glob(f"waldo{book}-{part:02}.*")
        scene_raw = jpeg(image)
        (output / "scenes" / f"{identifier}.jpg").write_bytes(scene_raw)
        tiles = []
        for row, y in enumerate(tile_starts(image.height, tile, stride)):
            for column, x in enumerate(tile_starts(image.width, tile, stride)):
                box = [x, y, x + tile, y + tile]
                crop = image.crop(box)
                if tile != SENT_SIZE:
                    crop = crop.resize((SENT_SIZE, SENT_SIZE), Image.Resampling.LANCZOS)
                raw = jpeg(crop)
                if len(raw) > MAX_TILE_BYTES:
                    raise ValueError("A tile is larger than some providers accept")
                (output / "images" / f"{sha(raw)}.jpg").write_bytes(raw)
                tiles.append({"id": f"ivsn-{identifier}-t{tile}-r{row}-c{column}", "page": number, "box_pixels": box,
                              "positive": overlap(box, truth), "image": f"images/{sha(raw)}.jpg", "image_sha256": sha(raw)})
        # A perfect searcher must be able to score: some tile has to hold all of Waldo.
        if not any(t["box_pixels"][0] <= truth[0] and t["box_pixels"][1] <= truth[1] and
                   t["box_pixels"][2] >= truth[2] and t["box_pixels"][3] >= truth[3] for t in tiles):
            raise ValueError(f"No tile holds all of Waldo in {identifier}; use larger tiles")
        pages.append({"page": number, "id": identifier, "scene_group": sha(scan.read_bytes()),
                      "source_size": list(source_size), "size": list(image.size), "truth_boxes_pixels": [truth],
                      "mask_applied": masked, "scene_image": f"scenes/{identifier}.jpg", "scene_sha256": sha(scene_raw),
                      "tiles": len(tiles), "positive_tiles": sum(t["positive"] for t in tiles)})
        cases.extend(tiles)
    manifest = {"dataset": f"{DATASET}-t{tile}", "created_at": now(), "archive_sha256": ARCHIVE_SHA256,
                "excluded": EXCLUDED, "pages": pages, "cases": cases,
                "preprocessing": {"tile_size": tile, "stride": stride, "sent_size": SENT_SIZE, "max_edge": MAX_EDGE,
                                  "mask": "IVSN text masks, grown by 3 px, painted RGB(224, 224, 224)",
                                  "tile_resize": "LANCZOS", "image_format": "JPEG quality 90, no chroma subsampling",
                                  "pillow_version": pillow_version}}
    write_json(output / "manifest.json", manifest)
    return manifest


def reference_picture(source: Path):
    """The portrait of Waldo every model is shown: IVSN's own target picture, scaled to fit 384 px."""
    path = source / "target" / "waldo.JPG"
    with Image.open(path) as opened:
        image = opened.convert("RGB")
    scale = min(1, SENT_SIZE / max(image.size))
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    if min(image.size) < 280:
        raise ValueError("Jev needs every image side to be at least 280 px")
    raw = jpeg(image)
    return raw, {"source_sha256": sha(path.read_bytes()), "sent_sha256": sha(raw), "sent_size": list(image.size)}


def load(manifest_path: Path):
    """A prepared manifest, with every image checked against its recorded hash."""
    manifest = json.loads(manifest_path.read_text())
    if not manifest["dataset"].startswith(DATASET):
        raise ValueError(f"{manifest_path} was not made by `waldobench prepare`")
    for case in manifest["cases"]:
        if sha((manifest_path.parent / case["image"]).read_bytes()) != case["image_sha256"]:
            raise ValueError(f"Tile changed after preparation: {case['image']}")
    return manifest

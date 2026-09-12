#!/usr/bin/env python3
"""Render deterministic Tier 1 framing fixtures with host FFmpeg.

This is a geometry harness, not a vision or Media3 acceptance test. The
source videos contain synthetic geometric subjects. Every fixture row first
runs through the production TypeScript planner in src/lib/t1-framing.ts; the
returned decision is checked against the fixture expectation and then applied
as one static crop per source interval. Outputs are scaled back to the portrait
delivery canvas. The report records the exact pixel crop and the
normalized-to-Media3 projection so a later native run can compare the same
request.

On machines without FFmpeg, run this script with a temporary environment that
contains imageio-ffmpeg, for example:

  python3 -m venv /tmp/one-take-framing-venv
  /tmp/one-take-framing-venv/bin/python -m pip install imageio-ffmpeg
  /tmp/one-take-framing-venv/bin/python tools/render-t1-framing.py

No project dependency is required or modified.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = ROOT / "tools" / "fixtures" / "t1-framing.json"
DEFAULT_SOURCE = ROOT / "tools" / "fixtures" / "t1-portrait.mp4"
DEFAULT_OUT_DIR = ROOT / "docs" / "validation" / "evidence" / "t1-session-3" / "framing"
WIDTH = 360
HEIGHT = 640
FPS = 30


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", help="FFmpeg executable; defaults to PATH or imageio-ffmpeg.")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--regenerate-sources",
        action="store_true",
        help="Regenerate synthetic source MP4s; by default existing sources are preserved.",
    )
    return parser.parse_args()


def resolve_ffmpeg(explicit: str | None) -> str:
    if explicit:
        return explicit
    from_path = shutil.which("ffmpeg")
    if from_path:
        return from_path
    try:
        import imageio_ffmpeg  # type: ignore[import-not-found]
    except ImportError as error:
        raise SystemExit(
            "FFmpeg is unavailable. Install imageio-ffmpeg in an isolated environment "
            "or pass --ffmpeg /path/to/ffmpeg."
        ) from error
    return imageio_ffmpeg.get_ffmpeg_exe()


def run_ffmpeg(ffmpeg: str, args: list[str]) -> None:
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args]
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"FFmpeg failed with exit code {error.returncode}: {' '.join(command)}") from error


def font_path() -> Path | None:
    candidates = [
        Path("/System/Library/Fonts/Helvetica.ttc"),
        Path("/System/Library/Fonts/SFNS.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def source_filter(style: str) -> str:
    if style == "portrait":
        filters = [
            "drawbox=x=105:y=350:w=150:h=250:color=0x2b6470:t=fill",
            "drawbox=x=128:y=172:w=104:h=116:color=0xf0b28c:t=fill",
            "drawbox=x=145:y=204:w=18:h=12:color=0x1b2733:t=fill",
            "drawbox=x=197:y=204:w=18:h=12:color=0x1b2733:t=fill",
            "drawbox=x=161:y=250:w=38:h=8:color=0x8b3c48:t=fill",
        ]
        label = "PORTRAIT SOURCE"
    elif style == "moving":
        filters = [
            "drawbox=x=45+95*sin(2*PI*t/3):y=350:w=150:h=250:color=0x704d79:t=fill",
            "drawbox=x=68+95*sin(2*PI*t/3):y=172:w=104:h=116:color=0xf0b28c:t=fill",
            "drawbox=x=85+95*sin(2*PI*t/3):y=204:w=18:h=12:color=0x1b2733:t=fill",
            "drawbox=x=137+95*sin(2*PI*t/3):y=204:w=18:h=12:color=0x1b2733:t=fill",
        ]
        label = "MOVING SUBJECT SOURCE"
    elif style == "product":
        filters = [
            "drawbox=x=85:y=235:w=190:h=175:color=0xd3a32d:t=fill",
            "drawbox=x=103:y=255:w=154:h=135:color=0x284b77:t=fill",
            "drawbox=x=46:y=410:w=112:h=84:color=0xd99174:t=fill",
            "drawbox=x=204:y=424:w=92:h=72:color=0xd99174:t=fill",
        ]
        label = "PRODUCT DEMO SOURCE"
    else:
        raise ValueError(f"Unknown synthetic source style: {style}")

    font = font_path()
    if font:
        escaped = label.replace("\\", "\\\\").replace(":", "\\:")
        filters.append(
            f"drawtext=fontfile={font}:text='{escaped}':fontsize=18:fontcolor=white:x=14:y=16"
        )
    return ",".join(filters)


def generate_source(ffmpeg: str, destination: Path, style: str, duration: float) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(ffmpeg, [
        "-f", "lavfi",
        "-i", f"color=c=0x111827:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration}",
        "-f", "lavfi",
        "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex", f"[0:v]{source_filter(style)}[video]",
        "-map", "[video]",
        "-map", "1:a",
        "-t", str(duration),
        "-r", str(FPS),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "96k",
        "-movflags", "+faststart",
        str(destination),
    ])


def ensure_source(ffmpeg: str, destination: Path, style: str, duration: float, regenerate: bool) -> None:
    if destination.exists() and not regenerate:
        return
    generate_source(ffmpeg, destination, style, duration)


def validate_crop(crop: dict[str, Any]) -> None:
    values = [crop.get(key) for key in ("x", "y", "width", "height")]
    if not all(isinstance(value, (int, float)) for value in values):
        raise SystemExit(f"Invalid crop in fixture: {crop!r}")
    x, y, width, height = (float(value) for value in values)
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
        raise SystemExit(f"Crop is outside normalized source bounds: {crop!r}")


def pixel_crop(crop: dict[str, Any]) -> dict[str, int]:
    validate_crop(crop)
    x = round(float(crop["x"]) * WIDTH)
    y = round(float(crop["y"]) * HEIGHT)
    width = round(float(crop["width"]) * WIDTH)
    height = round(float(crop["height"]) * HEIGHT)
    if width % 2 or height % 2:
        raise SystemExit(f"Fixture crop does not produce even YUV dimensions: {crop!r}")
    if x + width > WIDTH or y + height > HEIGHT:
        raise SystemExit(f"Pixel crop is outside source bounds: {crop!r}")
    return {"x": x, "y": y, "width": width, "height": height}


def native_crop(crop: dict[str, Any]) -> dict[str, float]:
    return {
        "left": round(float(crop["x"]) * 2 - 1, 6),
        "right": round((float(crop["x"]) + float(crop["width"])) * 2 - 1, 6),
        "bottom": round(1 - (float(crop["y"]) + float(crop["height"])) * 2, 6),
        "top": round(1 - float(crop["y"]) * 2, 6),
    }


def render_segment(
    ffmpeg: str,
    source: Path,
    destination: Path,
    start_sec: float,
    end_sec: float,
    crop: dict[str, Any],
) -> dict[str, Any]:
    geometry = pixel_crop(crop)
    duration = end_sec - start_sec
    destination.parent.mkdir(parents=True, exist_ok=True)
    video_filter = (
        f"crop={geometry['width']}:{geometry['height']}:{geometry['x']}:{geometry['y']},"
        f"scale={WIDTH}:{HEIGHT}:flags=lanczos"
    )
    run_ffmpeg(ffmpeg, [
        "-ss", str(start_sec),
        "-i", str(source),
        "-t", str(duration),
        "-vf", video_filter,
        "-r", str(FPS),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "96k",
        "-movflags", "+faststart",
        str(destination),
    ])
    return {
        "source": str(source),
        "startSec": start_sec,
        "endSec": end_sec,
        "normalizedCrop": crop,
        "pixelCrop": geometry,
        "nativeCrop": native_crop(crop),
        "output": str(destination),
    }


def render_thumbnail(ffmpeg: str, video: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(ffmpeg, [
        "-ss", "0.5",
        "-i", str(video),
        "-frames:v", "1",
        "-vf", "scale=180:320",
        str(destination),
    ])


def load_fixture(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        fixture = json.load(handle)
    if fixture.get("schemaVersion") != 1 or not isinstance(fixture.get("cases"), list):
        raise SystemExit(f"Unsupported framing fixture: {path}")
    return fixture


def fixture_case(fixture: dict[str, Any], case_id: str) -> dict[str, Any]:
    for row in fixture["cases"]:
        if row.get("id") == case_id:
            return row
    raise SystemExit(f"Missing fixture case: {case_id}")


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def run_typescript_planner(fixture_path: Path) -> dict[str, dict[str, Any]]:
    """Run the production planner for every fixture row before rendering."""
    node_program = r'''
import fs from 'node:fs';
import { buildFramingPlan } from './src/lib/t1-framing.ts';

const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = fixture.cases.map((row) => {
  const { expected: _expected, ...input } = row.input;
  const plan = buildFramingPlan(input);
  const decision = plan.cuts[0];
  return {
    id: row.id,
    decision: {
      mode: decision.mode,
      crop: decision.crop,
      nativeCrop: decision.nativeCrop,
      suggestionId: decision.suggestionId,
      fallbackReason: decision.fallbackReason,
      startSec: decision.startSec,
      endSec: decision.endSec,
    },
  };
});
process.stdout.write(JSON.stringify(results));
'''
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", node_program],
        cwd=ROOT,
        input=fixture_path.read_text(encoding="utf-8"),
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    if completed.returncode != 0:
        raise SystemExit(
            "TypeScript framing planner failed before rendering:\n"
            f"{completed.stderr.strip()}"
        )
    try:
        rows = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"TypeScript planner returned invalid JSON: {completed.stdout!r}") from error
    return {row["id"]: row["decision"] for row in rows}


def assert_planner_matches_fixture(
    fixture: dict[str, Any],
    decisions: dict[str, dict[str, Any]],
) -> None:
    for row in fixture["cases"]:
        case_id = row["id"]
        expected = row["input"]["expected"]
        if case_id not in decisions:
            raise SystemExit(f"TypeScript planner did not return fixture case: {case_id}")
        decision = decisions[case_id]
        if decision["mode"] != expected["mode"]:
            raise SystemExit(
                f"Planner mode diverged for {case_id}: expected {expected['mode']!r}, "
                f"got {decision['mode']!r}"
            )
        if "fallbackReason" in expected and decision.get("fallbackReason") != expected["fallbackReason"]:
            raise SystemExit(
                f"Planner fallback diverged for {case_id}: expected {expected['fallbackReason']!r}, "
                f"got {decision.get('fallbackReason')!r}"
            )
        if "crop" in expected and decision.get("crop") != expected["crop"]:
            raise SystemExit(
                f"Planner crop diverged for {case_id}: expected {expected['crop']!r}, "
                f"got {decision.get('crop')!r}"
            )
        if "nativeCrop" in expected and decision.get("nativeCrop") != expected["nativeCrop"]:
            raise SystemExit(
                f"Planner native crop diverged for {case_id}: expected {expected['nativeCrop']!r}, "
                f"got {decision.get('nativeCrop')!r}"
            )


def main() -> None:
    args = parse_args()
    ffmpeg = resolve_ffmpeg(args.ffmpeg)
    fixture = load_fixture(args.fixture)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.source.parent.mkdir(parents=True, exist_ok=True)
    planner_decisions = run_typescript_planner(args.fixture)
    assert_planner_matches_fixture(fixture, planner_decisions)

    ensure_source(ffmpeg, args.source, "portrait", 12, args.regenerate_sources)
    moving_source = args.out_dir / "moving-source.mp4"
    product_source = args.out_dir / "product-source.mp4"
    ensure_source(ffmpeg, moving_source, "moving", 8, args.regenerate_sources)
    ensure_source(ffmpeg, product_source, "product", 10, args.regenerate_sources)

    portrait = fixture_case(fixture, "portrait-ready")
    moving = fixture_case(fixture, "moving-subject-falls-back")
    product = fixture_case(fixture, "product-keeps-product-and-hand")
    portrait_decision = planner_decisions[portrait["id"]]
    moving_decision = planner_decisions[moving["id"]]
    product_decision = planner_decisions[product["id"]]

    renders = [
        render_segment(
            ffmpeg,
            args.source,
            args.out_dir / "portrait-original.mp4",
            2,
            5,
            {"x": 0, "y": 0, "width": 1, "height": 1},
        ),
        render_segment(
            ffmpeg,
            args.source,
            args.out_dir / "portrait-reframed.mp4",
            2,
            5,
            portrait_decision["crop"],
        ),
        render_segment(
            ffmpeg,
            moving_source,
            args.out_dir / "moving-original-fallback.mp4",
            1,
            4,
            moving_decision["crop"],
        ),
        render_segment(
            ffmpeg,
            product_source,
            args.out_dir / "product-reframed.mp4",
            3,
            7,
            product_decision["crop"],
        ),
    ]
    render_cases = [portrait["id"], portrait["id"], moving["id"], product["id"]]
    render_decisions = [
        {"mode": "original", "fallbackReason": "manual comparison baseline", "decision": None},
        portrait_decision,
        moving_decision,
        product_decision,
    ]
    for render, case_id, decision in zip(renders, render_cases, render_decisions):
        render["fixtureCase"] = case_id
        render["plannerMode"] = decision["mode"]
        if decision.get("fallbackReason") is not None:
            render["plannerFallbackReason"] = decision["fallbackReason"]
    for render in renders:
        render_thumbnail(ffmpeg, Path(render["output"]), Path(render["output"]).with_suffix(".png"))

    version = subprocess.run([ffmpeg, "-version"], check=True, capture_output=True, text=True).stdout.splitlines()[0]
    report_renders = [
        {
            **render,
            "source": display_path(Path(render["source"])),
            "output": display_path(Path(render["output"])),
        }
        for render in renders
    ]
    report = {
        "kind": "host-ffmpeg-framing-geometry",
        "fixture": display_path(args.fixture),
        "sourceFixture": display_path(args.source),
        "canvas": {"widthPx": WIDTH, "heightPx": HEIGHT, "fps": FPS},
        "host": {
            "os": platform.platform(),
            "python": sys.version.split()[0],
            "ffmpeg": version,
            "provider": "fixture",
            "processorClaim": "host CPU only; no camera, NPU, or Media3 evidence",
        },
        "nativeParity": {
            "status": "not-run",
            "requirement": "Feed each decision's same source-local start/end and nativeCrop into both NativeCutView and Media3 export after #49 composition integration.",
        },
        "planner": {
            "implementation": "src/lib/t1-framing.ts",
            "command": "node --experimental-strip-types --input-type=module",
            "fixtureCasesValidated": len(planner_decisions),
            "fixtureExpectationsMatched": True,
        },
        "sources": [
            {"style": "portrait", "path": display_path(args.source), "durationSec": 12},
            {"style": "moving", "path": display_path(moving_source), "durationSec": 8},
            {"style": "product", "path": display_path(product_source), "durationSec": 10},
        ],
        "fixtureCases": [portrait["id"], moving["id"], product["id"]],
        "renders": report_renders,
    }
    with (args.out_dir / "render-report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"source": str(args.source), "outDir": str(args.out_dir), "renders": len(renders)}, indent=2))


if __name__ == "__main__":
    main()

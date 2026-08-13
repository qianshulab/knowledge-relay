#!/usr/bin/env python3
"""Read a provider model catalog through Nanobot's official settings helper."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from nanobot.config.loader import set_config_path
from nanobot.webui.settings_api import WebUISettingsError, provider_models_payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--provider", required=True)
    args = parser.parse_args()

    set_config_path(Path(args.config).expanduser().resolve())
    try:
        payload = provider_models_payload({"provider": [args.provider]})
    except WebUISettingsError as error:
        payload = {
            "provider": args.provider,
            "status": "error",
            "models": [],
            "model_count": 0,
            "message": str(error),
        }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

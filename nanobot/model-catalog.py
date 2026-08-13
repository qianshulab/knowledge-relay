#!/usr/bin/env python3
"""Read a provider model catalog through Nanobot's official settings helper."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from nanobot.config.loader import set_config_path
from nanobot.webui.settings_api import WebUISettingsError, provider_models_payload


UNCONFIGURED_PROVIDER_KEY = "__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__"
PROVIDER_CONFIG_KEYS = {
    "openai_codex": "openaiCodex",
}


def provider_is_configured(config_path: Path, provider: str) -> bool:
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        config_key = PROVIDER_CONFIG_KEYS.get(provider, provider)
        api_key = raw.get("providers", {}).get(config_key, {}).get("apiKey")
    except (OSError, ValueError, TypeError):
        return True
    if not isinstance(api_key, str):
        return provider in {"ollama", "vllm", "openai_codex"}
    value = api_key.strip()
    return bool(value and value != UNCONFIGURED_PROVIDER_KEY and not value.startswith("${"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--provider", required=True)
    args = parser.parse_args()

    config_path = Path(args.config).expanduser().resolve()
    if not provider_is_configured(config_path, args.provider):
        print(json.dumps({
            "provider": args.provider,
            "status": "not_configured",
            "models": [],
            "model_count": 0,
            "message": "Provider credentials are not configured.",
        }, ensure_ascii=False, separators=(",", ":")))
        return 0

    set_config_path(config_path)
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

#!/usr/bin/env python3
"""Read a provider model catalog through Nanobot's official settings helper."""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from nanobot.config.loader import set_config_path
from nanobot.webui.settings_api import WebUISettingsError, provider_models_payload


UNCONFIGURED_PROVIDER_KEY = "__KNOWLEDGE_RELAY_PROVIDER_NOT_CONFIGURED__"
PROVIDER_CONFIG_KEYS = {
    "openai_codex": "openaiCodex",
    "kimi_coding": "kimiCoding",
}


def read_raw_config(config_path: Path) -> dict:
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def resolve_secret(value: object) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if text.startswith("${") and text.endswith("}"):
        return os.environ.get(text[2:-1], "").strip()
    return text


def provider_is_configured(config_path: Path, provider: str) -> bool:
    raw = read_raw_config(config_path)
    config_key = PROVIDER_CONFIG_KEYS.get(provider, provider)
    api_key = raw.get("providers", {}).get(config_key, {}).get("apiKey")
    if not isinstance(api_key, str):
        return provider in {"ollama", "vllm", "openai_codex"}
    value = resolve_secret(api_key)
    return bool(value and value != UNCONFIGURED_PROVIDER_KEY and not value.startswith("${"))


def kimi_coding_models_payload(config_path: Path) -> dict:
    """Load Kimi Code's OpenAI-compatible model catalog.

    Nanobot uses Kimi Code's Anthropic-compatible Messages backend for agent
    calls. Kimi also exposes an OpenAI-compatible /models endpoint, so the
    catalog can remain live without changing or bypassing Nanobot's runtime.
    """
    raw = read_raw_config(config_path)
    provider = raw.get("providers", {}).get("kimiCoding", {})
    api_key = resolve_secret(provider.get("apiKey"))
    api_base = str(provider.get("apiBase") or "https://api.kimi.com/coding/v1").rstrip("/")
    request = urllib.request.Request(
        f"{api_base}/models",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "Knowledge-Relay-Nanobot/1.9",
        },
    )
    base_payload = {
        "provider": "kimi_coding",
        "catalog_kind": "official",
        "models": [],
        "model_count": 0,
        "fetched_at": time.time(),
    }
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        return {
            **base_payload,
            "status": "not_configured" if error.code in {401, 403} else "error",
            "message": "Kimi Code rejected the configured credential."
            if error.code in {401, 403}
            else f"Model list request failed with HTTP {error.code}.",
        }
    except (OSError, ValueError, TypeError) as error:
        return {**base_payload, "status": "error", "message": f"Could not load models: {error}"}

    rows = []
    seen = set()
    for item in body.get("data", []) if isinstance(body, dict) else []:
        model_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(model_id, str) or not model_id.strip() or model_id in seen:
            continue
        seen.add(model_id)
        rows.append({
            "id": model_id,
            "owned_by": item.get("owned_by") if isinstance(item.get("owned_by"), str) else "Kimi Code",
            "context_window": item.get("context_window") if isinstance(item.get("context_window"), int) else None,
        })
    return {**base_payload, "status": "available", "models": rows, "model_count": len(rows)}


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
        payload = (
            kimi_coding_models_payload(config_path)
            if args.provider == "kimi_coding"
            else provider_models_payload({"provider": [args.provider]})
        )
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

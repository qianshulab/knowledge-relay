"""Tool-free Nanobot API runtime used only for inbox query planning."""

from __future__ import annotations

import argparse
from pathlib import Path

from aiohttp import web

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.api.server import create_app
from nanobot.bus.queue import MessageBus
from nanobot.config.loader import load_config, set_config_path
from nanobot.session.manager import SessionManager


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start the tool-free inbox search Nanobot runtime")
    parser.add_argument("--config", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8902)
    parser.add_argument("--timeout", type=float, default=45.0)
    return parser.parse_args()


def main() -> None:
    args = arguments()
    config_path = Path(args.config).resolve()
    workspace = Path(args.workspace).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    set_config_path(config_path)
    config = load_config(config_path)
    config.agents.defaults.workspace = str(workspace)
    config.agents.defaults.max_tool_iterations = 2
    config.agents.defaults.disabled_skills = sorted(set([
        *config.agents.defaults.disabled_skills,
        "clawhub", "cron", "github", "image-generation", "memory", "my",
        "skill-creator", "summarize", "tmux", "update-setup", "weather",
    ]))
    bus = MessageBus()
    sessions = SessionManager(workspace)
    agent_loop = AgentLoop.from_config(config, bus, session_manager=sessions)

    # AgentLoop is still the official Nanobot loop/provider stack, but this
    # dedicated endpoint deliberately exposes an empty tool registry.
    agent_loop.tools = ToolRegistry()
    model_name = config.resolve_preset().model
    api_key = config.api.api_key.strip() if config.api.api_key else ""
    app = create_app(
        agent_loop,
        model_name=model_name,
        request_timeout=args.timeout,
        api_key=api_key,
    )

    async def cleanup(_app: web.Application) -> None:
        await agent_loop.close_mcp()

    app.on_cleanup.append(cleanup)
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()

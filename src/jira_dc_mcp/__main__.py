"""Entry point: python -m jira_dc_mcp"""

import argparse
import asyncio
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("jira_dc_mcp")


def main():
    parser = argparse.ArgumentParser(description="Jira DC 10 MCP Server (read-only)")
    parser.add_argument("--transport", choices=["stdio", "sse"], default="stdio")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Watch source files and hot-reload tool modules on change",
    )
    args = parser.parse_args()

    from .server import create_server

    server, client, automation_cache = create_server()

    if args.transport == "stdio":
        from mcp.server.stdio import stdio_server

        async def run_stdio():
            reloader = None
            if args.reload:
                from .reloader import Reloader
                reloader = Reloader()

            await automation_cache.start()
            if reloader:
                await reloader.start()
            try:
                async with stdio_server() as (read_stream, write_stream):
                    await server.run(read_stream, write_stream, server.create_initialization_options())
            finally:
                if reloader:
                    await reloader.stop()
                await automation_cache.stop()
                await client.close()

        asyncio.run(run_stdio())
    else:
        from mcp.server.sse import SseServerTransport
        from starlette.applications import Starlette
        from starlette.routing import Route
        import uvicorn

        sse = SseServerTransport("/messages")

        async def handle_sse(request):
            async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
                await server.run(streams[0], streams[1], server.create_initialization_options())

        async def handle_messages(request):
            await sse.handle_post_message(request.scope, request.receive, request._send)

        reloader = None
        if args.reload:
            from .reloader import Reloader
            reloader = Reloader()

        async def on_startup():
            await automation_cache.start()
            if reloader:
                await reloader.start()

        async def on_shutdown():
            if reloader:
                await reloader.stop()
            await automation_cache.stop()
            await client.close()

        app = Starlette(
            routes=[
                Route("/sse", handle_sse),
                Route("/messages", handle_messages, methods=["POST"]),
            ],
            on_startup=[on_startup],
            on_shutdown=[on_shutdown],
        )
        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()

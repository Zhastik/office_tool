import json
import logging
import os
import re
import sys
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

SERVER_DIR = Path(__file__).resolve().parent
DIST = SERVER_DIR.parent / "dist"
BROWSER_HEADERS = json.loads(
    (SERVER_DIR / "browser-headers.json").read_text(encoding="utf-8")
)
VALID_REQUEST_ID = re.compile(r"[0-9a-f]{32}")
READ_METHODS = {"GET", "HEAD"}
ACCESS_LOG = logging.getLogger("pdfwork.http")
ACCESS_LOG.addHandler(logging.StreamHandler(sys.stdout))
ACCESS_LOG.setLevel(logging.INFO)
ACCESS_LOG.propagate = False


def create_app(
    *,
    serve_frontend: bool = True,
    frontend_root: Path = DIST,
    version: str = "0.1.0",
) -> FastAPI:
    app = FastAPI(
        title="PDFwork",
        version=version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    frontend_available = (frontend_root / "index.html").is_file()

    @app.middleware("http")
    async def read_only_service(request: Request, call_next):
        request_id = request.headers.get("x-request-id", "")
        if not VALID_REQUEST_ID.fullmatch(request_id):
            request_id = uuid4().hex

        started = perf_counter()
        status = 500
        try:
            if request.method not in READ_METHODS:
                response = JSONResponse(
                    {"detail": "Method not allowed"},
                    status_code=405,
                    headers={"Allow": "GET, HEAD"},
                )
            elif request.headers.get("content-length") not in {None, "0"} or (
                "transfer-encoding" in request.headers
            ):
                response = JSONResponse(
                    {"detail": "Request bodies are not accepted"},
                    status_code=400,
                )
            else:
                response = await call_next(request)

            status = response.status_code
            response.headers["X-Request-ID"] = request_id
            is_api = request.url.path.startswith("/api/")
            if serve_frontend:
                response.headers.update(BROWSER_HEADERS)

            if is_api or status >= 400:
                response.headers["Cache-Control"] = "no-store"
            elif request.url.path.startswith("/assets/") and status in {200, 206, 304}:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                response.headers["Cache-Control"] = "no-cache"
            return response
        finally:
            ACCESS_LOG.info(json.dumps({
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "status": status,
                "duration_ms": round((perf_counter() - started) * 1000, 2),
            }, separators=(",", ":")))

    @app.api_route("/api/health", methods=["GET", "HEAD"])
    async def health():
        return {"status": "ok", "file_processing": "browser"}

    @app.api_route("/api/ready", methods=["GET", "HEAD"])
    async def ready():
        if serve_frontend and not frontend_available:
            return JSONResponse(
                {"status": "unavailable", "detail": "Frontend build is missing"},
                status_code=503,
            )
        return {"status": "ready"}

    @app.api_route("/api/v1/info", methods=["GET", "HEAD"])
    async def info():
        return {"name": "pdfwork", "version": app.version, "file_processing": "browser"}

    if serve_frontend:
        if frontend_available:
            app.mount("/", StaticFiles(directory=frontend_root, html=True), name="frontend")
        else:
            @app.get("/")
            async def build_required():
                return JSONResponse(
                    {"detail": "Run npm run build before starting the production server."},
                    status_code=503,
                )

    return app


app = create_app(
    serve_frontend=os.getenv("PDFWORK_SERVE_FRONTEND", "1") == "1",
    version=os.getenv("PDFWORK_VERSION", "0.1.0"),
)



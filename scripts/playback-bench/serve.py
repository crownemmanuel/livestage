#!/usr/bin/env python3
"""Loopback HTTP server with byte-range support, for the WebKit playback bench.
/bench.html is served from this folder; /f/<absolute path> serves any file (ranges honoured)."""
import os, re, sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def do_OPTIONS(self):
        # CORS preflight (a page on another origin reading files with Range, like the app's dev server).
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n)
        with open(os.path.join(HERE, "results.jsonl"), "ab") as f: f.write(body + b"\n")
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Length", "0"); self.end_headers()
    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path.startswith("/f/"):
            fp = "/" + path[3:].lstrip("/")
        else:
            fp = os.path.join(HERE, path.lstrip("/"))
        if not os.path.isfile(fp):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        size = os.path.getsize(fp)
        ctype = "video/mp4" if fp.endswith((".mp4", ".mov", ".m4v")) else "video/webm" if fp.endswith(".webm") else "text/javascript" if fp.endswith((".js", ".mjs")) else "text/html"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                else:
                    start = size - int(m.group(2))
                status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(fp, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    b = f.read(min(left, 1 << 20))
                    if not b:
                        break
                    self.wfile.write(b)
                    left -= len(b)
            except (BrokenPipeError, ConnectionResetError):
                pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

#!/usr/bin/env python3
"""XrnTube sync server: one JSON document per user, behind HTTP Basic auth.

Made to run on a small home server next to Radicale, published under a path
(e.g. /xrntube) by a reverse proxy such as Tailscale Funnel. Standard library
only, plus `bcrypt` to read an htpasswd file (Radicale's works as-is, so the
calendar password is the sync password).

    GET  /state            200, the document; ETag: "<version>"
    PUT  /state            needs If-Match: "<version>" (or "*" to overwrite)
                           200 with the new ETag, or 412 if someone else wrote
                           first — re-read, merge, try again
    GET  /download/<file>  a file from <data>/downloads (the extension's .zip)
    GET  /health           200 "ok", no login (for monitoring)

Any path may carry the mount prefix (/xrntube/state), so it works whether or
not the proxy strips it. Responses allow any origin (CORS): the browser
extension calls it with an Authorization header and no cookies, so it needs
no host permission for the server's address.

    python3 xrntube-sync.py --data ~/xrntube-sync --users ~/.config/radicale/users
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bcrypt

MAX_BODY = 32 * 1024 * 1024
FAIL_DELAY_S = 2  # after a wrong password, as Radicale does
AUTH_CACHE_S = 600  # a bcrypt check costs ~0.3s on a phone; don't pay it per request
PREFIX = "/xrntube"

args = None
lock = threading.Lock()
auth_cache = {}  # sha256(user:password) -> (user, expires, users-file mtime)


def users_mtime():
    try:
        return os.stat(args.users).st_mtime
    except OSError:
        return 0


def check_login(header):
    """The user name for a valid `Authorization: Basic …`, else None."""
    if not header or not header.startswith("Basic "):
        return None
    try:
        user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except Exception:
        return None
    key = hashlib.sha256(f"{user}:{password}".encode()).hexdigest()
    mtime = users_mtime()
    hit = auth_cache.get(key)
    if hit and hit[1] > time.time() and hit[2] == mtime:
        return hit[0]
    try:
        with open(args.users, encoding="utf-8") as f:
            for line in f:
                name, _, hashed = line.strip().partition(":")
                if name == user and hashed and bcrypt.checkpw(password.encode(), hashed.encode()):
                    auth_cache[key] = (user, time.time() + AUTH_CACHE_S, mtime)
                    return user
    except (OSError, ValueError):
        pass
    return None


def state_path(user):
    return os.path.join(args.data, "users", user, "state.json")


def read_state(user):
    try:
        with open(state_path(user), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"version": 0, "data": {}}


def write_state(user, doc):
    path = state_path(user)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    server_version = "xrntube-sync/1"

    def log_message(self, fmt, *a):
        who = self.headers.get("X-Forwarded-For", self.client_address[0]) if self.headers else "-"
        sys.stderr.write(f"{who} {fmt % a}\n")

    def route(self):
        path = self.path.split("?", 1)[0]
        if path == PREFIX or path.startswith(PREFIX + "/"):
            path = path[len(PREFIX):] or "/"
        return path

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode()
        if len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 6)
            headers = {**(headers or {}), "Content-Encoding": "gzip"}
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "ETag")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def login(self):
        user = check_login(self.headers.get("Authorization"))
        if not user:
            time.sleep(FAIL_DELAY_S)
            self.send(401, "login required", headers={"WWW-Authenticate": 'Basic realm="XrnTube"'})
        return user

    def do_OPTIONS(self):  # CORS preflight: no login
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, If-Match, Content-Type, Content-Encoding")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        path = self.route()
        if path == "/health":
            return self.send(200, "ok")
        user = self.login()
        if not user:
            return
        if path == "/state":
            with lock:
                doc = read_state(user)
            body = json.dumps(doc.get("data") or {}, ensure_ascii=False, separators=(",", ":"))
            return self.send(200, body, "application/json; charset=utf-8", {"ETag": f'"{doc["version"]}"'})
        if path.startswith("/download/"):
            name = os.path.basename(path[len("/download/"):])
            file = os.path.join(args.data, "downloads", name)
            if name and os.path.isfile(file):
                with open(file, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip" if name.endswith(".zip") else "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self.send(404, "not found")

    def do_PUT(self):
        path = self.route()
        user = self.login()
        if not user:
            return
        if path != "/state":
            return self.send(404, "not found")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send(413, "body missing or too large")
        raw = self.rfile.read(length)
        if (self.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.decompress(raw)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            return self.send(400, "body must be a JSON object")
        want = (self.headers.get("If-Match") or "").strip()
        if not want:
            return self.send(428, "If-Match required")
        with lock:
            cur = read_state(user)
            if want != "*" and want.strip('"') != str(cur["version"]):
                return self.send(412, "changed since you read it", headers={"ETag": f'"{cur["version"]}"'})
            version = cur["version"] + 1
            write_state(user, {"version": version, "updated": datetime.now(timezone.utc).isoformat(), "data": data})
        self.send(200, '{"ok":true}', "application/json", {"ETag": f'"{version}"'})


def main():
    global args
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5233)
    p.add_argument("--data", required=True, help="where the documents live")
    p.add_argument("--users", required=True, help="htpasswd file with bcrypt hashes")
    args = p.parse_args()
    args.data = os.path.expanduser(args.data)
    args.users = os.path.expanduser(args.users)
    os.makedirs(os.path.join(args.data, "downloads"), exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"xrntube-sync on http://{args.host}:{args.port}, data in {args.data}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
splunk_client.py — Minimal, resilient Splunk search client for log-size analysis.

Stdlib only. Designed around the failure modes that actually break volume analysis:

  * 120s job timeouts on wide raw-event scans   -> SearchTimeout raised, callers shrink windows
  * HTTP 503 under concurrent search load       -> automatic backoff + retry
  * silent zero-results from unquoted dotted    -> caller's problem, but see check_spl_hygiene()
    field names

Configuration (first match wins):
    SPLUNK_TOKEN                        bearer token
    SPLUNK_USERNAME + SPLUNK_PASSWORD   basic auth
    OS keyring                          service 'eclipse-splunk-investigation', key 'SPLUNK_PASSWORD'
    .env file in skill root or CWD       SPLUNK_HOST / SPLUNK_USERNAME
"""

from __future__ import annotations

import base64
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_PORT = 8089
POLL_INTERVAL = 2
DEFAULT_MAX_WAIT = 110          # stay under the usual 120s ceiling
RETRY_STATUSES = (500, 502, 503, 504)
MAX_RETRIES = 4
ENV_KEYS = ("SPLUNK_HOST", "SPLUNK_USERNAME", "SPLUNK_PASSWORD", "SPLUNK_TOKEN")


class SearchTimeout(RuntimeError):
    """Search exceeded max_wait. Caller should retry with a narrower window."""


class SearchFailed(RuntimeError):
    """Splunk reported FAILED/FATAL for the job."""


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _load_env_file() -> None:
    """Load SPLUNK_* keys from a .env file without clobbering real env vars."""
    candidates = [
        Path(__file__).resolve().parent.parent / ".env",
        Path.home() / ".agents/skills/eclipse-log-size-analysis/.env",
        Path.home() / ".claude/skills/eclipse-log-size-analysis/.env",
        Path.home() / ".agents/skills/eclipse-splunk-investigation/.env",
        Path.home() / ".claude/skills/eclipse-splunk-investigation/.env",
        Path.cwd() / ".env",
    ]
    for path in candidates:
        try:
            if not path.is_file():
                continue
        except OSError:
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key in ENV_KEYS and not os.environ.get(key):
                os.environ[key] = value


def _load_keyring_password() -> None:
    if os.environ.get("SPLUNK_PASSWORD") or os.environ.get("SPLUNK_TOKEN"):
        return
    try:
        import keyring  # type: ignore
    except ImportError:
        return
    for service in ("eclipse-splunk-investigation", "eclipse-log-size-analysis"):
        try:
            secret = keyring.get_password(service, "SPLUNK_PASSWORD")
        except Exception:
            continue
        if secret:
            os.environ["SPLUNK_PASSWORD"] = secret
            return


def load_config() -> dict:
    """Resolve connection settings, or exit with actionable guidance."""
    _load_env_file()
    _load_keyring_password()

    host = os.environ.get("SPLUNK_HOST", "").strip()
    host = re.sub(r"^https?://", "", host).rstrip("/")
    if not host:
        sys.exit(
            "[error] SPLUNK_HOST is not set.\n"
            "  Set it in the environment, or create a .env file with:\n"
            "    SPLUNK_HOST=splunk-awsprod.ezesoft.net\n"
            "    SPLUNK_USERNAME=your-username"
        )
    if ":" not in host:
        host = f"{host}:{DEFAULT_PORT}"

    token = os.environ.get("SPLUNK_TOKEN", "").strip()
    username = os.environ.get("SPLUNK_USERNAME", "").strip()
    password = os.environ.get("SPLUNK_PASSWORD", "").strip()

    if not token and not (username and password):
        sys.exit(
            "[error] No Splunk credentials found.\n"
            "  Provide either SPLUNK_TOKEN, or SPLUNK_USERNAME + SPLUNK_PASSWORD.\n"
            "  To store a password in the OS keyring:\n"
            "    python3 -c \"import keyring; keyring.set_password("
            "'eclipse-splunk-investigation', 'SPLUNK_PASSWORD', 'your-password')\""
        )

    return {"base_url": f"https://{host}", "token": token,
            "username": username, "password": password}


# ---------------------------------------------------------------------------
# SPL hygiene
# ---------------------------------------------------------------------------

DOTTED_FIELD = re.compile(r'(?<!["\w.])((?:k8s|kubernetes)(?:\.[a-z_]+)+)(?!["])')


def check_spl_hygiene(spl: str) -> list[str]:
    """Flag constructs that silently return zero results or reliably time out."""
    warnings = []
    for match in DOTTED_FIELD.finditer(spl):
        warnings.append(
            f'dotted field {match.group(1)!r} is not double-quoted — '
            f'Splunk will silently return zero results. Use "{match.group(1)}".'
        )
    # Leading wildcards force a full scan — but only flag them in term/field
    # matches, not in source=/host= paths where a leading * is idiomatic.
    for match in re.finditer(r'(?<![\w*])\*\w', spl):
        prefix = spl[max(0, match.start() - 40):match.start()]
        if re.search(r'\b(source|host|index|punct)\s*=\s*$', prefix):
            continue
        warnings.append(
            "leading wildcard disables the term index and forces a full scan; "
            "prefer an exact term or a trailing wildcard."
        )
        break
    if "transaction" in spl:
        warnings.append("`transaction` does not scale; use stats-based correlation instead.")
    return warnings


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SplunkClient:
    """Serialized Splunk search client. Never issue searches concurrently —
    the search head returns 503 under parallel load from a single user."""

    def __init__(self, config: dict | None = None, verbose: bool = True):
        self.cfg = config or load_config()
        self.verbose = verbose
        self._ctx = ssl.create_default_context()
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE

    # -- plumbing ----------------------------------------------------------

    def _log(self, msg: str) -> None:
        if self.verbose:
            print(msg, file=sys.stderr, flush=True)

    def _auth_header(self) -> tuple[str, str]:
        if self.cfg["token"]:
            return "Authorization", f"Bearer {self.cfg['token']}"
        raw = f"{self.cfg['username']}:{self.cfg['password']}".encode()
        return "Authorization", f"Basic {base64.b64encode(raw).decode()}"

    def _request(self, url: str, method: str = "GET", data: dict | None = None):
        body = urllib.parse.urlencode(data).encode() if data else None
        last_error = None

        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header(*self._auth_header())
            if body:
                req.add_header("Content-Type", "application/x-www-form-urlencoded")
            try:
                with urllib.request.urlopen(req, context=self._ctx, timeout=60) as resp:
                    text = resp.read().decode()
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode(errors="replace")[:400]
                if exc.code in RETRY_STATUSES and attempt < MAX_RETRIES - 1:
                    backoff = 3 * (2 ** attempt)
                    self._log(f"[retry] HTTP {exc.code} from Splunk; "
                              f"sleeping {backoff}s (attempt {attempt + 1}/{MAX_RETRIES})")
                    time.sleep(backoff)
                    last_error = f"HTTP {exc.code}: {detail}"
                    continue
                if exc.code == 401:
                    sys.exit("[error] HTTP 401 Unauthorized — Splunk credentials are invalid "
                             "or expired. Re-check SPLUNK_USERNAME / SPLUNK_PASSWORD.")
                sys.exit(f"[error] HTTP {exc.code} from Splunk: {detail}")
            except urllib.error.URLError as exc:
                if attempt < MAX_RETRIES - 1:
                    backoff = 3 * (2 ** attempt)
                    self._log(f"[retry] connection error ({exc.reason}); sleeping {backoff}s")
                    time.sleep(backoff)
                    last_error = str(exc.reason)
                    continue
                sys.exit(f"[error] Cannot reach Splunk at {self.cfg['base_url']}: {exc.reason}\n"
                         f"  Check VPN connectivity and that port 8089 is reachable.")
        sys.exit(f"[error] Splunk unreachable after {MAX_RETRIES} attempts: {last_error}")

    # -- search ------------------------------------------------------------

    def search(self, spl: str, earliest: str = "-1h", latest: str = "now",
               max_wait: int = DEFAULT_MAX_WAIT, count: int = 500,
               warn_hygiene: bool = True) -> list[dict]:
        """Run a search to completion and return result rows.

        Raises SearchTimeout if the job exceeds max_wait — callers are expected
        to catch this and retry over a narrower time window.
        """
        if warn_hygiene:
            for warning in check_spl_hygiene(spl):
                self._log(f"[warn] SPL hygiene: {warning}")

        search_str = spl if spl.lstrip().startswith(("search ", "|")) else f"search {spl}"
        payload = {"search": search_str, "earliest_time": earliest,
                   "latest_time": latest, "output_mode": "json"}

        created = self._request(f"{self.cfg['base_url']}/services/search/jobs",
                                method="POST", data=payload)
        sid = created.get("sid") if isinstance(created, dict) else None
        if not sid:
            raise SearchFailed(f"Splunk did not return a job SID: {created}")

        try:
            self._wait(sid, max_wait)
            return self._results(sid, count)
        finally:
            # Free search-head slots promptly; a lingering job contributes to 503s.
            try:
                self._request(f"{self.cfg['base_url']}/services/search/jobs/{sid}",
                              method="DELETE")
            except SystemExit:
                pass

    def _wait(self, sid: str, max_wait: int) -> None:
        elapsed = 0
        while elapsed < max_wait:
            info = self._request(
                f"{self.cfg['base_url']}/services/search/jobs/{sid}?output_mode=json")
            content = (info.get("entry") or [{}])[0].get("content", {})
            state = content.get("dispatchState", "")
            if state == "DONE":
                return
            if state in ("FAILED", "FATAL"):
                raise SearchFailed(f"job {sid} failed: {content.get('messages', '')}")
            time.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL
            if elapsed % 20 == 0:
                self._log(f"[...] {state.lower() or 'running'} {elapsed}s")
        raise SearchTimeout(f"job {sid} exceeded {max_wait}s")

    def _results(self, sid: str, count: int) -> list[dict]:
        rows: list[dict] = []
        offset, page = 0, min(count, 1000)
        while offset < count:
            data = self._request(
                f"{self.cfg['base_url']}/services/search/jobs/{sid}/results"
                f"?output_mode=json&count={page}&offset={offset}")
            batch = data.get("results", []) if isinstance(data, dict) else []
            if not batch:
                break
            rows.extend(batch)
            offset += len(batch)
            if len(batch) < page:
                break
        return rows[:count]

    def search_shrinking(self, spl_template: str, latest_epoch: int,
                         window_seconds: int, min_window: int = 10,
                         **kwargs) -> tuple[list[dict], int]:
        """Run a search, halving the window on timeout until it completes.

        spl_template is used as-is; the time bounds are passed as epoch values.
        Returns (rows, window_seconds_actually_used).
        """
        window = window_seconds
        while True:
            earliest = latest_epoch - window
            try:
                rows = self.search(spl_template, earliest=str(earliest),
                                   latest=str(latest_epoch), **kwargs)
                return rows, window
            except SearchTimeout:
                if window <= min_window:
                    raise
                window = max(min_window, window // 2)
                self._log(f"[adapt] timed out; retrying with a {window}s window")

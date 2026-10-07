"""Pull a privacy-filtered running summary from Garmin Connect into Cloudflare KV.

Run by .github/workflows/garmin-sync.yml. The Worker reads the snapshot and puts it
in the persona's system prompt, so everything written here is effectively public.
Only the fields assembled in build_snapshot() leave this script: no GPS, no routes,
no activity names, no start times and no health metrics.

Garmin may rotate the refresh token whenever the access token is refreshed, so the
current tokens are saved back after every run, encrypted, to a KV namespace the
Worker is not bound to. GARMIN_TOKENS (from login.py) is only the starting point;
replacing that secret makes the next run start over from it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, TypeVar
from zoneinfo import ZoneInfo

import requests
from cryptography.fernet import Fernet, InvalidToken
from garminconnect import Garmin

SNAPSHOT_KEY = "running-stats"
TOKENS_KEY = "garmin-tokens"
SNAPSHOT_VERSION = 1
RECENT_RUN_COUNT = 5

# Running typeIds from get_personal_record(); 8 and up are cycling, steps and swimming.
RECORD_NAMES = {
    1: "1K",
    2: "1 mile",
    3: "5K",
    4: "10K",
    5: "Half marathon",
    6: "Marathon",
    7: "Longest run",
}
LONGEST_RUN_RECORD = 7

PREDICTION_FIELDS = (
    ("time5K", "5K"),
    ("time10K", "10K"),
    ("timeHalfMarathon", "Half marathon"),
    ("timeMarathon", "Marathon"),
)

log = logging.getLogger("garmin-sync")
T = TypeVar("T")


class KvStore:
    """Minimal client for one Workers KV namespace via the Cloudflare REST API."""

    def __init__(self, account_id: str, api_token: str, namespace_id: str) -> None:
        self._base = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/storage/kv/namespaces/{namespace_id}/values"
        )
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {api_token}"

    def get(self, key: str) -> str | None:
        response = self._session.get(f"{self._base}/{key}", timeout=30)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.text

    def put(self, key: str, value: str) -> None:
        response = self._session.put(
            f"{self._base}/{key}",
            data=value.encode("utf-8"),
            headers={"Content-Type": "application/octet-stream"},
            timeout=30,
        )
        response.raise_for_status()


# -- Formatting --------------------------------------------------------------


def format_duration(seconds: float) -> str:
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def positive_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return float(value)


# -- Snapshot ----------------------------------------------------------------


def is_run(activity: dict[str, Any]) -> bool:
    activity_type = activity.get("activityType") or {}
    key = str(activity_type.get("typeKey") or "")
    # Trail, treadmill, track and the other running subtypes have parentTypeId 1.
    return (
        key == "running"
        or activity_type.get("parentTypeId") == 1
        or key.endswith(("_running", "_run"))
    )


def normalize_runs(activities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reduce activities to the few numeric fields the snapshot may use."""
    runs = []
    for activity in activities:
        if not isinstance(activity, dict) or not is_run(activity):
            continue
        try:
            day = date.fromisoformat(str(activity.get("startTimeLocal"))[:10])
        except ValueError:
            continue
        distance = positive_number(activity.get("distance"))
        if distance is None:
            continue
        runs.append(
            {
                "date": day,
                "distance_m": distance,
                "duration_s": positive_number(activity.get("duration")) or 0.0,
                "speed": positive_number(activity.get("averageSpeed")),
                "avg_hr": positive_number(activity.get("averageHR")),
            }
        )
    # Garmin returns newest first; a stable sort keeps that order within a day.
    runs.sort(key=lambda run: run["date"], reverse=True)
    return runs


def month_end(day: date) -> date:
    return (day.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def period_ranges(today: date) -> dict[str, tuple[date, date]]:
    week_start = today - timedelta(days=today.weekday())
    month_start = today.replace(day=1)
    last_month_end = month_start - timedelta(days=1)
    return {
        "thisWeek": (week_start, week_start + timedelta(days=6)),
        "lastWeek": (week_start - timedelta(days=7), week_start - timedelta(days=1)),
        "thisMonth": (month_start, month_end(month_start)),
        "lastMonth": (last_month_end.replace(day=1), last_month_end),
        "thisYear": (date(today.year, 1, 1), date(today.year, 12, 31)),
    }


def summarize(runs: list[dict[str, Any]], start: date, end: date) -> dict[str, Any]:
    selected = [run for run in runs if start <= run["date"] <= end]
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "runs": len(selected),
        "distanceKm": round(sum(run["distance_m"] for run in selected) / 1000, 1),
        "duration": format_duration(sum(run["duration_s"] for run in selected)),
        "longestKm": round(max((run["distance_m"] for run in selected), default=0) / 1000, 1),
    }


def recent_run(run: dict[str, Any]) -> dict[str, Any]:
    km = run["distance_m"] / 1000
    seconds_per_km = 1000 / run["speed"] if run["speed"] else run["duration_s"] / km
    return {
        "date": run["date"].isoformat(),
        "distanceKm": round(km, 2),
        "duration": format_duration(run["duration_s"]),
        "pace": f"{format_duration(seconds_per_km)}/km" if seconds_per_km else None,
        "avgHr": round(run["avg_hr"]) if run["avg_hr"] else None,
    }


def record_date(record: dict[str, Any], tz: ZoneInfo) -> str | None:
    timestamp_ms = record.get("prStartTimeGMT")
    if isinstance(timestamp_ms, (int, float)) and not isinstance(timestamp_ms, bool):
        return datetime.fromtimestamp(timestamp_ms / 1000, tz).date().isoformat()
    formatted = record.get("prStartTimeLocalFormatted") or record.get("prStartTimeGmtFormatted")
    if isinstance(formatted, str) and re.match(r"\d{4}-\d{2}-\d{2}", formatted):
        return formatted[:10]
    return None


def personal_records(records: Any, tz: ZoneInfo) -> list[dict[str, Any]]:
    result = []
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict):
            continue
        type_id = record.get("typeId")
        name = RECORD_NAMES.get(type_id)
        value = positive_number(record.get("value"))
        if name is None or value is None:
            continue
        entry: dict[str, Any] = {"name": name, "date": record_date(record, tz)}
        if type_id == LONGEST_RUN_RECORD:
            entry["distanceKm"] = round(value / 1000, 1)
        else:
            entry["time"] = format_duration(value)
        result.append((type_id, entry))
    return [entry for _, entry in sorted(result, key=lambda item: item[0])]


def race_predictions(predictions: Any) -> list[dict[str, str]]:
    if not isinstance(predictions, dict):
        return []
    result = []
    for field, name in PREDICTION_FIELDS:
        seconds = positive_number(predictions.get(field))
        if seconds is not None:
            result.append({"name": name, "time": format_duration(seconds)})
    return result


def training_summary(status: Any) -> tuple[int | None, str | None]:
    """VO2 max and the training status label, e.g. PRODUCTIVE_1 -> "Productive"."""
    status = status if isinstance(status, dict) else {}

    vo2 = (status.get("mostRecentVO2Max") or {}).get("generic") or {}
    vo2_value = positive_number(vo2.get("vo2MaxPreciseValue")) or positive_number(
        vo2.get("vo2MaxValue")
    )

    devices = (status.get("mostRecentTrainingStatus") or {}).get("latestTrainingStatusData") or {}
    device_data = [data for data in devices.values() if isinstance(data, dict)]
    primary = next(
        (data for data in device_data if data.get("primaryTrainingDevice")),
        device_data[0] if device_data else {},
    )
    phrase = primary.get("trainingStatusFeedbackPhrase")
    label = None
    if isinstance(phrase, str):
        # Letters only: this string lands in a system prompt.
        words = re.sub(r"[^A-Za-z ]", "", re.sub(r"_\d+$", "", phrase).replace("_", " "))
        label = words.strip().capitalize() or None

    return (round(vo2_value) if vo2_value else None, label)


def build_snapshot(
    now: datetime,
    activities: list[dict[str, Any]],
    records: Any,
    predictions: Any,
    training_status: Any,
) -> dict[str, Any]:
    tz = now.tzinfo
    if not isinstance(tz, ZoneInfo):
        raise ValueError("now must carry a ZoneInfo timezone")

    runs = normalize_runs(activities)
    vo2_max, status_label = training_summary(training_status)
    return {
        "version": SNAPSHOT_VERSION,
        "generatedAt": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "timezone": tz.key,
        "periods": {
            name: summarize(runs, start, end)
            for name, (start, end) in period_ranges(now.date()).items()
        },
        "recentRuns": [recent_run(run) for run in runs[:RECENT_RUN_COUNT]],
        "personalRecords": personal_records(records, tz),
        "racePredictions": race_predictions(predictions),
        "vo2Max": vo2_max,
        "trainingStatus": status_label,
    }


def optional(label: str, fetch: Callable[[], T], fallback: T) -> T:
    """Fetch a nice-to-have section; a failure drops the section, not the run."""
    try:
        return fetch()
    except Exception as err:  # noqa: BLE001 - any Garmin failure here is non-fatal
        log.warning("Skipping %s: %s", label, type(err).__name__)
        return fallback


def fetch_snapshot(garmin: Garmin, now: datetime) -> dict[str, Any]:
    today = now.date()
    earliest = min(start for start, _ in period_ranges(today).values())
    # No activityType filter: Garmin's "running" filter can miss trail and
    # treadmill runs, so is_run() decides locally.
    activities = garmin.get_activities_by_date(earliest.isoformat(), today.isoformat())

    return build_snapshot(
        now,
        activities,
        optional("personal records", garmin.get_personal_record, None),
        optional("race predictions", garmin.get_race_predictions, None),
        optional(
            "training status", lambda: garmin.get_training_status(today.isoformat()), None
        ),
    )


# -- Tokens ------------------------------------------------------------------

TOKEN_FIELDS = ("di_token", "di_refresh_token", "di_client_id")


def token_hash(tokens: str) -> str:
    """SHA-256 of the token JSON. Its first 12 characters are safe to log as a fingerprint."""
    return hashlib.sha256(tokens.encode("utf-8")).hexdigest()


def token_problem(tokens: str) -> str | None:
    """Why garminconnect would fail to load `tokens`, or None. Never echoes the values.

    Checked up front because garminconnect swallows a failed token load and then
    reports "Username and password are required", which points the wrong way.
    """
    try:
        data = json.loads(tokens)
    except ValueError as err:
        return f"is not valid JSON ({err})"
    if not isinstance(data, dict):
        return "is not a JSON object"
    missing = [field for field in TOKEN_FIELDS if not data.get(field)]
    if missing:
        return f"has no {', '.join(missing)}"
    return None


def load_tokens(store: KvStore, fernet: Fernet, seed: str) -> tuple[str, str, bool]:
    """Return (tokens, seed_hash, came_from_store)."""
    seed_hash = token_hash(seed)
    encrypted = store.get(TOKENS_KEY)
    if encrypted:
        try:
            saved = json.loads(fernet.decrypt(encrypted.encode("utf-8")))
            if saved["seed"] == seed_hash:
                return saved["tokens"], seed_hash, True
            log.info("GARMIN_TOKENS changed since the last run; starting from the new login.")
        except (InvalidToken, ValueError, KeyError, TypeError):
            log.warning("Saved Garmin tokens could not be decrypted; starting from GARMIN_TOKENS.")
    return seed, seed_hash, False


def save_tokens(store: KvStore, fernet: Fernet, seed_hash: str, tokens: str) -> None:
    payload = json.dumps({"seed": seed_hash, "tokens": tokens})
    store.put(TOKENS_KEY, fernet.encrypt(payload.encode("utf-8")).decode("ascii"))


# -- Entry point -------------------------------------------------------------


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable {name}.")
    return value


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    tz = ZoneInfo(os.environ.get("GARMIN_TIMEZONE", "").strip() or "Asia/Jakarta")
    account_id = require_env("CLOUDFLARE_ACCOUNT_ID")
    api_token = require_env("CLOUDFLARE_API_TOKEN")
    stats_store = KvStore(account_id, api_token, require_env("RUNNING_STATS_KV_ID"))
    auth_store = KvStore(account_id, api_token, require_env("GARMIN_AUTH_KV_ID"))
    fernet = Fernet(require_env("GARMIN_TOKEN_KEY"))
    seed = require_env("GARMIN_TOKENS")
    log.info("GARMIN_TOKENS fingerprint: %s", token_hash(seed)[:12])
    problem = token_problem(seed)
    if problem:
        log.error(
            "GARMIN_TOKENS %s. Put the exact contents of garmin_tokens.json in the secret, "
            "copied from the file rather than from terminal output (terminals add line "
            "breaks when they wrap long lines). login.py prints the fingerprint to match.",
            problem,
        )
        return 1

    tokens, seed_hash, from_store = load_tokens(auth_store, fernet, seed)
    last_saved = tokens if from_store else None

    garmin = Garmin()
    try:
        garmin.login(tokens)
    except Exception as err:  # noqa: BLE001 - every login failure has the same fix
        log.error(
            "Garmin login failed (%s: %s). Run scripts/garmin-sync/login.py again "
            "and replace the GARMIN_TOKENS secret.",
            type(err).__name__,
            err,
        )
        return 1

    def persist_tokens() -> None:
        nonlocal last_saved
        current = garmin.client.dumps()
        if current != last_saved:
            save_tokens(auth_store, fernet, seed_hash, current)
            last_saved = current

    # Save straight away: if login rotated the refresh token and this run then
    # crashed, the only valid copy would be lost with the runner.
    persist_tokens()
    try:
        snapshot = fetch_snapshot(garmin, datetime.now(tz))
    finally:
        persist_tokens()

    stats_store.put(SNAPSHOT_KEY, json.dumps(snapshot, ensure_ascii=False))
    week = snapshot["periods"]["thisWeek"]
    log.info(
        "Snapshot saved: %d runs / %.1f km this week, %d recent runs, %d records.",
        week["runs"],
        week["distanceKm"],
        len(snapshot["recentRuns"]),
        len(snapshot["personalRecords"]),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

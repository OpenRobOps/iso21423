from datetime import datetime, timezone


def now_timestamp() -> str:
    """UTC, millisecond precision, `Z` suffix (identical to JS toISOString)."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

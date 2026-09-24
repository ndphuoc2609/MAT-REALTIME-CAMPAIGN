#!/usr/bin/env python3
"""One-off VnExpress API probe. TLS certificate verification is disabled."""

import argparse
from datetime import date, timedelta
import hashlib
import hmac
import json
import os
from pathlib import Path
import ssl
import sys
import time
import urllib.error
import urllib.request


ENDPOINT = "https://news.fptonline.net/api/get-report"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_KEYS = ("SOURCE_VNEXPRESS_USER_NAME", "SOURCE_VNEXPRESS_API_SECRET_KEY")


def settings():
    values = {key: os.environ.get(key, "").strip() for key in ENV_KEYS}
    env_file = PROJECT_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            key = key.strip()
            if separator and key in ENV_KEYS and not values[key]:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key] = value
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise SystemExit("Thiếu cấu hình: " + ", ".join(missing) + " (đặt trong .env hoặc environment).")
    return values


def parse_args():
    today = date.today()
    month_start = today.replace(day=1)
    next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
    month_end = next_month - timedelta(days=1)
    parser = argparse.ArgumentParser(description="Gọi thử API VnExpress, bỏ xác minh chứng chỉ TLS.")
    parser.add_argument("from_date", nargs="?", default=month_start.isoformat(), help="YYYY-MM-DD (mặc định: đầu tháng hiện tại)")
    parser.add_argument("to_date", nargs="?", default=month_end.isoformat(), help="YYYY-MM-DD (mặc định: cuối tháng hiện tại)")
    args = parser.parse_args()
    try:
        start, end = date.fromisoformat(args.from_date), date.fromisoformat(args.to_date)
    except ValueError:
        parser.error("Ngày phải có định dạng YYYY-MM-DD.")
    if start.isoformat() != args.from_date or end.isoformat() != args.to_date or start > end:
        parser.error("Khoảng ngày không hợp lệ.")
    return args


class RejectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    args = parse_args()
    config = settings()
    fields = {
        "user_name": config["SOURCE_VNEXPRESS_USER_NAME"],
        "from_date": args.from_date,
        "to_date": args.to_date,
        "timestamp": int(time.time()),
    }
    message = "|".join(str(fields[key]) for key in sorted(fields))
    signature = hmac.new(
        config["SOURCE_VNEXPRESS_API_SECRET_KEY"].encode(),
        message.encode(),
        hashlib.sha256,
    ).hexdigest()
    body = json.dumps({**fields, "signature": signature}).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )

    # Diagnostic only: accept an untrusted certificate for this one request.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(
        RejectRedirect(), urllib.request.HTTPSHandler(context=context)
    )
    print(f"POST {ENDPOINT} · {args.from_date} → {args.to_date} · timeout 60s")
    print("TLS certificate verification: disabled for this probe")
    print("Mỗi lần chạy gửi một request trực tiếp; script không cập nhật bộ đếm quota PostgreSQL của ứng dụng.")
    try:
        with opener.open(request, timeout=60) as response:
            raw = response.read()
            print(f"HTTP {response.status} · {response.headers.get('content-type', 'unknown content type')}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        print(f"HTTP {error.code}", file=sys.stderr)
        if raw:
            try:
                print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
            except (json.JSONDecodeError, UnicodeDecodeError):
                print(raw.decode("utf-8", errors="replace"))
        return 1
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        print(f"Request failed: {reason}", file=sys.stderr)
        return 1

    try:
        print(json.dumps(json.loads(raw), ensure_ascii=False, indent=2))
    except (json.JSONDecodeError, UnicodeDecodeError):
        print(raw.decode("utf-8", errors="replace"))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

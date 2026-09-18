# ADR 0001: PostgreSQL for production application storage

- Status: Accepted
- Date: 2026-09-15

## Context

The application previously stored report data and account state in two local
SQLite files. Production is moving to the configured Neon PostgreSQL database.
The owner does not require the existing SQLite contents to be retained.

## Decision

`DATABASE_URL` is required and PostgreSQL is the sole store for links, snapshots,
jobs, schedule metadata, users, sessions, and report grants. The app creates
its schema at startup and does not import, read, or delete old SQLite records.
The app and operational database commands fail clearly when the URL is missing
or invalid. Tests inject isolated in-memory stores and never fall back to local
SQLite or use a configured production database.

Playwright browser profiles remain files under `DATA_DIR/sessions`; they are
credentials and are not moved into PostgreSQL. The service remains single
instance because crawl queue coordination is process-local.

## Consequences

- A fresh PostgreSQL database starts without old users, links, reports, or jobs.
  Create the first administrator and add source links after deployment.
- PostgreSQL connectivity and schema creation are required before the app starts.
- Back up database contents with the PostgreSQL provider and back up browser
  profiles separately with restricted access.
- Existing SQLite files are left untouched and never read by the application.

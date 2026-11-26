# MIC backend

This backend is deliberately separate from the legacy `server.js`. It uses only the
`mic2` PostgreSQL schema and does not run or modify the legacy `public` schema.

## Environment

Set these variables in the MIC Render service:

- `DATABASE_URL`: the **Internal Database URL** of the dedicated MIC development database.
- `JWT_SECRET`: a random secret with at least 32 bytes.
- `JWT_EXPIRES_IN`: optional token lifetime (defaults to `8h`).
- `CORS_ORIGIN`: exact comma-separated frontend origins.

Do not commit `.env` files or paste database credentials into source code.

## Database migrations

The service starts with `node mic2-migrate.js && node mic2-server.js`.
The migration runner applies SQL files `001` through `007` in order, records
checksums in `mic2.schema_migrations`, uses a PostgreSQL advisory lock, and
runs each migration transactionally. Already-applied migrations are skipped;
a changed migration checksum causes startup to stop rather than silently
changing an applied schema.

Migration `007` is aligned with the canonical correction table and view from
migration `005`. The `mic2` schema is separate from legacy `public` tables.

## Create the first administrator

After migrations have been applied, set `MIC2_ADMIN_LOGIN`,
`MIC2_ADMIN_PASSWORD` (at least 12 characters), and optionally
`MIC2_ADMIN_NAME` as temporary environment variables. Run once from the
backend directory:

```bash
node mic2-create-admin.js
```

The script stores a bcrypt password hash. Remove the bootstrap credentials
from the environment after use.

## API

- `GET /api/health`
- `POST /api/auth/login` with JSON `{ "login": "...", "password": "..." }`
- `GET /api/auth/me` with `Authorization: Bearer <token>`

This is the initial authentication foundation. Business endpoints and role-based
authorization policies will be added as MIC modules are implemented.

# MIC 2.0 backend (isolated)

This backend is deliberately separate from the legacy `server.js`. It uses only the
`mic2` PostgreSQL schema and does not run or modify the legacy `public` schema.

## Environment

Copy `.env.mic2.example` to a private `.env` (do not commit it) and set:

- `DATABASE_URL`: connection string for the dedicated MIC 2.0 database.
- `JWT_SECRET`: random secret with at least 32 bytes.
- `CORS_ORIGIN`: exact comma-separated frontend origins.
- `PORT`: optional HTTP port (defaults to 3001).

The existing backend dependencies already include `pg`, `bcrypt`, `jsonwebtoken`,
`express`, `cors`, and `dotenv`.

## Database

Apply migrations `001` through `007` in numeric order to a dedicated MIC 2.0
database. Migration `007` has been aligned with the correction table and view
created by migration `005`; it must not be applied to the legacy database.

## Create the first administrator

After migrations have been applied, set `MIC2_ADMIN_LOGIN`,
`MIC2_ADMIN_PASSWORD` (at least 12 characters), and optionally
`MIC2_ADMIN_NAME` in the environment. Run once:

```bash
node mic2-create-admin.js
```

The script stores a bcrypt password hash and refuses to create an account if
the login already exists. Remove the bootstrap credentials from the environment
after use.

## Run

From the `backend` directory:

```bash
node mic2-server.js
```

Endpoints:

- `GET /api/health`
- `POST /api/auth/login` with JSON `{ "login": "...", "password": "..." }`
- `GET /api/auth/me` with `Authorization: Bearer <token>`

This is the initial authentication foundation. Business endpoints and role-based
authorization policies will be added as MIC 2.0 modules are implemented.

# AssurAssistance Backend

Node.js + Express + MySQL backend powering the AssurAssistance travel
insurance platform.

## Quick links

- **API documentation** → [`docs/INTEGRATION_GUIDE.md`](./docs/INTEGRATION_GUIDE.md) — start here as a 3rd-party integrator.
- **Endpoint reference** → [`docs/API.md`](./docs/API.md).
- **Security model** → [`docs/SECURITY.md`](./docs/SECURITY.md).
- **OpenAPI 3.1 spec** → [`docs/openapi.yaml`](./docs/openapi.yaml) (also served at `/api/openapi.json`).
- **Swagger UI** → `https://<your-deploy>/api/docs`.
- **Postman collection** → [`docs/postman_collection.json`](./docs/postman_collection.json).
- **Deploy guide** → [`docs/DEPLOY_HOSTINGER_VPS.md`](./docs/DEPLOY_HOSTINGER_VPS.md).
- **DB remote access** → [`docs/MYSQL_REMOTE_ACCESS_ISPCONFIG.md`](./docs/MYSQL_REMOTE_ACCESS_ISPCONFIG.md).

## Local development

```bash
cp .env.example .env       # fill in DB + JWT + email credentials
npm install
npm run dev                # nodemon server.js
```

Apply the latest schema:

```bash
mysql -u $DB_USER -p $DB_NAME < database_dump.sql           # fresh install
mysql -u $DB_USER -p $DB_NAME < migrations/add_api_keys.sql # incremental
```

## Running tests / linting

The project does not yet ship with a test suite. Use `node --check` for
syntax verification and the existing `npm run dev` to smoke-test changes.

## Environment

See `.env.example`. Production must set at minimum:

- `JWT_SECRET` (≥ 32 chars)
- `BCRYPT_ROUNDS` (default 12)
- `RATE_LIMIT_*` (per-IP window + max)
- `API_KEY_DEFAULT_RPM` (per-key default — `120` is sane)
- `CORS_ORIGINS` (CSV)

## Architecture in 30 seconds

| Layer | What |
|---|---|
| `routes/` | Express routers; one per resource family. |
| `controllers/` | Request handling (validation, role/scope checks, response shaping). |
| `models/` | SQL access via `mysql2` (parameterised). |
| `middlewares/` | `authMiddleware` (JWT only), `apiKeyMiddleware` (JWT *or* API key + scope), `roleMiddleware`. |
| `utils/` | PDF generation, email, helpers. |
| `migrations/` | Incremental SQL applied on top of `database_dump.sql`. |
| `docs/` | Public-facing documentation. |

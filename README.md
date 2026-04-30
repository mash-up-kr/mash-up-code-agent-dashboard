# Mash-Up Code Agent Dashboard

## Docker Compose deployment

The production bundle runs the community/chat backend and MySQL on the same server.

1. Create `.env.production` on the server.
2. Fill the production values:
   - `MYSQL_ROOT_PASSWORD`
   - `MYSQL_PASSWORD`
   - `SESSION_SECRET`
   - `CORS_ORIGIN` if the local dashboard calls this backend from another origin
   - `COOKIE_SECURE=true` when serving over HTTPS cross-origin
3. Run `docker compose --env-file .env.production up -d --build`.

For GitHub Actions deployment, add these repository secrets:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_PATH`
- `DEPLOY_PORT` optional, defaults to `22`

The workflow preserves the server-side `.env.production` file and rebuilds the app with Docker Compose.

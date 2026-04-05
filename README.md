# Job Visualizer

A small Node-based dashboard for Japanese engineering job tracking.

## Features

- Incremental sync by URL
- Duplicate jobs update in place
- Removed jobs drop out of the current dashboard on the next sync instead of moving to an expired bucket
- Sorting and filtering by recruitment timing fields such as `source_date` and `first_posted_at`
- One-click full-site crawl that discovers fresh URLs from supported listing pages, re-verifies every configured job URL, rewrites canonical `jobs.json`, and syncs MongoDB
- Built-in daily fresh-crawl scheduler that discovers newly listed jobs once per day and syncs them into MongoDB
- Built-in daily validation scheduler that re-checks every current card's job URL on a fixed time each day and closes jobs that are no longer open
- File storage by default for direct local runs
- MongoDB repository included and ready via `STORE_MODE=mongo`

## Run

1. `npm install`
2. `npm run dev`
3. Open `http://localhost:3000`

## Docker

1. Make sure Docker Desktop is running.
2. Start everything with `npm run docker:up`
3. Open `http://localhost:11301` for the direct app port, or `http://jobviz.home.arpa` after local DNS / hosts mapping is in place.

Useful follow-ups:

- `npm run docker:prepare`: sync the latest local skill output into the Docker bundle before build/export
- `npm run docker:logs`: follow the app logs
- `npm run docker:down`: stop the app and MongoDB containers
- `npm run docker:pack`: build an importable Docker image archive at `../job-visualizer-images.tar`

The Compose stack starts two services:

- `job-visualizer-app`: the Express dashboard on port `3000`
- `job-visualizer-mongo`: the MongoDB backing store on the internal Docker network
- `job-visualizer-nginx`: the LAN reverse proxy that serves your custom local domain on port `80`

Notes:

- Docker mode forces `STORE_MODE=mongo` and uses `mongodb://mongo:27017/jphr_jobs`, so it does not rely on `127.0.0.1` inside the container.
- `./data` and `./tmp` are mounted into the app container to keep snapshots, storage, and logs accessible on the host.
- The app image now bundles the latest `skills/jphr/outputs/japan-frontend-jobs/<date>/jobs.json` into the image, then seeds a writable runtime directory on container startup.
- Docker Compose persists that writable skill-output runtime directory in its own Docker volume, so `sync latest` and follow-up crawls can keep working after deployment.
- The app is published on `${HOST_BIND_IP}:${APP_HOST_PORT}` and defaults to `0.0.0.0:11301`, so `http://192.168.0.107:11301/` still works when your LAN IP is `192.168.0.107`.
- Nginx reverse-proxies `http://${LOCAL_DOMAIN}:${DOMAIN_HTTP_PORT}` to the configured upstream. By default that is `http://jobviz.home.arpa` on port `80` and proxies to `app:3000`.
- To make the domain resolve inside your LAN, add a router DNS override or a hosts entry like `192.168.0.107 jobviz.home.arpa`.
- Set `HOST_BIND_IP` if you want Docker to listen only on a specific host IP instead of all interfaces.
- Set `APP_HOST_PORT`, `LOCAL_DOMAIN`, `DOMAIN_HTTP_PORT`, `NGINX_UPSTREAM_HOST`, and `NGINX_UPSTREAM_PORT` in `.env` to change the direct URL, domain URL, or proxy target without editing Compose files.
- Set `LAUNCHER_DOCKER_OPEN_URL` if you want the desktop launcher to open a specific Docker URL instead of auto-deriving one from `.env`.
- The earlier `job-visualizer-docker.tar` file is only a source bundle for extraction, not a Docker image archive for `docker load` or GUI import tools.
- If you import images on another machine, use [docker-compose.portable.yml](/F:/workspace/job-visualizer/docker-compose.portable.yml) together with [portable/.env.example](/F:/workspace/job-visualizer/portable/.env.example). The exported tar now includes `job-visualizer-app:portable`, `mongo:7`, and `job-visualizer-proxy:portable`, so the target machine does not need a separate Nginx config file.

## Maintenance scripts

- `npm run sync:latest`: sync the current canonical `jobs.json` into the active store
- `npm run crawl:all`: re-crawl every configured source URL from canonical data, rewrite `jobs.json`, then sync the results

## Daily validation

- The backend can automatically re-check every current job card once per day without discovering new jobs.
- Configure it with:
  - `DAILY_VALIDATION_ENABLED=true`
  - `DAILY_VALIDATION_HOUR=3`
  - `DAILY_VALIDATION_MINUTE=0`
  - `DAILY_VALIDATION_MAX_DURATION_MS=55000`
  - `DAILY_VALIDATION_CONCURRENCY=4`
  - `DAILY_VALIDATION_INTER_CHUNK_DELAY_MS=250`
- The scheduler state is available at `GET /api/validation/status`.
- This scheduler runs inside the Node app process, so it works as long as the service stays online.
- The validator uses source-aware round-robin balancing, so different job sites are checked more evenly instead of bursting one source at a time.

## Daily fresh crawl

- The backend can automatically discover and import fresh jobs once per day before the validation pass.
- Configure it with:
  - `DAILY_CRAWL_ENABLED=true`
  - `DAILY_CRAWL_HOUR=2`
  - `DAILY_CRAWL_MINUTE=0`
  - `DAILY_CRAWL_MAX_DURATION_MS=55000`
  - `DAILY_CRAWL_CONCURRENCY=4`
  - `DAILY_CRAWL_INTER_CHUNK_DELAY_MS=250`
- The scheduler state is available at `GET /api/discovery/status`.
- This scheduler also uses source-aware round-robin balancing and respects the same global concurrency cap and pacing.
- By default it runs at `02:00`, and the daily validation runs at `03:00`, so the two tasks stay staggered.

## Desktop launcher

- Double-click `Start-Project-Launcher.exe` for the cleanest desktop-style launch experience.
- Double-click `Start-Project-Launcher.vbs` to open the desktop launch panel without a console window.
- If you want a normal visible entry point, use `Start-Project-Launcher.bat`.
- The launcher config is in `launcher/LauncherConfig.json`. Future local or Docker tasks can be added there and will show up as new cards in the panel.
- Use the `LAN Settings` button in the launcher to visually edit `HOST_BIND_IP`, `APP_HOST_PORT`, `LOCAL_DOMAIN`, `DOMAIN_HTTP_PORT`, and the launcher-specific Docker URL override.
- The launcher includes a `Pack Tar` button for Docker tasks, so you can generate the importable `job-visualizer-images.tar` archive with one click.
- If you ever need to rebuild the EXE wrapper, run `powershell -ExecutionPolicy Bypass -File launcher/Build-LauncherExe.ps1`.
- Logs are written to `tmp/launcher`.

## MongoDB mode

1. Start MongoDB locally
2. Set `STORE_MODE=mongo`
3. Optionally set `MONGODB_URI`
4. Run `npm run dev`

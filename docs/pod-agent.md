# POD Agent

Scope: Mockup + Ideas/Design. Etsy, orders, Printify and Merchize are intentionally excluded.

## Configure

The Agent is disabled until MongoDB and its image encryption key are configured. Existing image APIs keep their current behavior.

```dotenv
AGENT_ENABLED=true
MONGODB_URI=mongodb://lcgmedia_agent:ENCODED_PASSWORD@pod-mongodb:27017/lcgmedia?authSource=lcgmedia
MONGODB_DATABASE=lcgmedia
AGENT_ASSET_ENCRYPTION_KEY=YOUR_64_HEX_CHARACTER_KEY
AGENT_WORKER_ENABLED=true
AGENT_CONCURRENCY=3
AGENT_SESSION_HOURS=24
```

Generate the key once with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Store it securely outside Git. All instances must use the same key. Back up this key with the MongoDB database: changing or losing it makes stored Agent images unreadable. Future key rotation must retain the previous key until images are re-encrypted.

Use a MongoDB user restricted to the chosen application database. The connection needs normal read/write and index creation permissions. Keep the database private. MongoDB sessions have a TTL index; authorization also checks expiry immediately. For local development, replace `pod-mongodb` with your local MongoDB address; this hostname is Docker-internal on the production server.

Create the first account from an interactive terminal, with `.env` configured:

```sh
npm run agent:user -- admin@example.com admin
```

The password prompt does not echo input. Minimum length: 12 characters. For non-interactive automation, provide `AGENT_BOOTSTRAP_PASSWORD` in that process environment only. Do not put passwords in command arguments or commit them. In the production container the equivalent command is `node scripts/agent-user.cjs admin@example.com admin`.

Open the app's **POD Agent** tab, sign in and create a job. Accounts see only their own conversations, files, templates and results. Admin accounts can create additional users through `POST /api/agent/auth/users`; the CLI can also create designer accounts.

## MongoDB on the EziHubb server

Production uses the current EziHubb server. `deploy/compose.agent-mongodb.yml` defines a separate MongoDB container, named volume, database and application user. It does not use EziHubb's MongoDB credentials or data volume. No host port is published; the API reaches `pod-mongodb` on the existing `gemini-tools_default` Docker network. The database stack is independent of app/API releases and rollbacks.

`scripts/setup-server.sh` installs the database Compose/init files alongside the existing deployment files without starting services. The following activation steps are for the next authorized deployment; preparing this code does not activate the Agent on production.

On the server, create the database-only secret file once (do not overwrite it on later deployments):

```sh
cd /home/ubuntu/gemini-tools
umask 077
if [ ! -e .env.agent-mongodb ]; then
  (
    set -e
    set -o noclobber
    root_password="$(openssl rand -hex 32)"
    app_password="$(openssl rand -hex 32)"
    printf 'MONGO_INITDB_ROOT_USERNAME=lcgmedia_root\nMONGO_INITDB_ROOT_PASSWORD=%s\nMONGO_INITDB_DATABASE=lcgmedia\nMONGODB_APP_USER=lcgmedia_agent\nMONGODB_APP_PASSWORD=%s\n' "$root_password" "$app_password" > .env.agent-mongodb
  )
fi
chmod 600 .env.agent-mongodb
export DEPLOY_PATH=/home/ubuntu/gemini-tools
docker network inspect gemini-tools_default >/dev/null
docker compose -f deploy/compose.agent-mongodb.yml config --quiet
docker compose -f deploy/compose.agent-mongodb.yml up -d --wait --wait-timeout 180
```

Set the API's private `.env` to the configuration above using the application password from `.env.agent-mongodb` and one persistent encryption key. Generated passwords are hexadecimal and need no extra URI escaping. Keep the root password only in the database secret file. Then deploy the API and frontend through the existing release pipeline and create the first Agent account with an interactive `docker compose ... exec api node scripts/agent-user.cjs EMAIL admin` command. Do not put either password in shell arguments or print the secret files.

The server currently has about 4 GB RAM. The separate MongoDB container is limited to 768 MB with a 0.256 GB WiredTiger cache; start with `AGENT_CONCURRENCY=2` and monitor memory, swap, database disk usage and provider rate limits before increasing concurrency. The cache limit leaves room for other MongoDB allocations; it is not a total memory limit. See the [MongoDB cache documentation](https://www.mongodb.com/docs/v7.0/reference/program/mongod/#std-option-mongod.--wiredTigerCacheSizeGB). Initialization and authentication follow the [official Mongo container documentation](https://github.com/docker-library/docs/tree/master/mongo#initializing-a-fresh-instance).

Back up the Agent database, its encryption key and both private environment files to protected storage outside this server. Keep the named volume across releases; never run `down -v` or remove it to fix a login/configuration issue. Mongo's initialization scripts run only on an empty volume; editing the environment file does not rotate existing database passwords. Use authenticated database commands for later account changes.

This first server deployment is a single MongoDB node: API/worker replicas can share it, but it does not provide database failover. Introduce a replica set or managed MongoDB when availability requires it. No MongoDB service, production environment or application release has been changed as part of local implementation.

## Workflows

1. **Auto:** Agent chooses one of the allowed workflows from the conversation and attachments. Missing roles/files produce questions before any image generation.
2. **Mockup AI:** Assign source product/design and reference photos. Backend creates the source/reference combinations, capped at 20 results. Image 1 is the reference canvas, image 2 is the source. Images are analyzed in contact sheets of at most six panels before planning.
3. **Template:** Upload a base photo up to 4 MP. Configure four convex corners clockwise from top-left, opacity and blend. Optional grayscale mask uses white=visible and black=hidden; an optional transparent foreground restores occlusions. Designs fit the area while preserving aspect ratio, then undergo a projective transform. Pixel work runs in a worker thread. Saving edited settings creates a new template; running jobs retain their template snapshot. Curved fabric is handled through the AI workflow, not an automatic cloth simulation.
4. **Ideas/Design:** Supply keywords, product group, optional research and source URLs. The Agent generates distinct ideas and complete prompts. An optional source image makes variants; otherwise images are generated from scratch. No live trend/search-volume connector is included: source URLs are recorded, not fetched, and the interface states this.

After planning, inspect and edit each final prompt. Mandatory image-role/no-new-watermark instructions are visible in saved prompts. Save edits before starting. The worker uses the saved prompt verbatim and does not change the selected image provider/model. Text uses existing VyceAI health routing with ShopAIKey fallback; image analysis uses the configured vision provider.

Each image has technical validation, optional AI visual comparison, human review and download. AI comparison is a screening aid, not a guarantee about exact pixels, text or watermark detection. A failed comparison request preserves the generated image for manual review. Review marks approved/changes requested. New variants link to their parent asset. ZIP export includes category/review folders and a manifest; a failed file download aborts export instead of hiding missing images.

## Durable execution and scaling

MongoDB stores conversations, runs, steps, users, hashed sessions, templates and asset metadata in `agent_records`. Images are AES-256-GCM encrypted before R2 storage under `R2_KEY_PREFIX/agent/<owner>/<asset>.bin`. Owner and asset ID are authenticated encryption metadata. Source and result bytes are returned only by authenticated owner-scoped endpoints; no plaintext Agent image URL is exposed in the public bucket. If R2 is unavailable during a save, the encrypted image is retained in MongoDB GridFS (`agent_image_backups`) and remains readable through the same authenticated API. This avoids regenerating a paid image to retry storage. Backups are retained; monitor database capacity and migrate them to R2 when needed. There is no automatic destructive cleanup of these files.

Queue claims and prompt-version changes use atomic conditional updates. Workers share a MongoDB slot limit (`AGENT_CONCURRENCY`, identical on every instance). A step has a 90-second lease renewed every 15 seconds. A missing/expired worker is marked interrupted, **never automatically resubmitted to an image provider**. This avoids retrying a paid request whose outcome is unknown; it does not claim exactly-once execution across third-party services. Queued steps survive restart. Stable step IDs repair gaps between storing a run and enqueuing its steps without creating duplicates.

To scale API replicas without running image work on them, set `AGENT_WORKER_ENABLED=false`; run one or more instances with workers enabled against the same database and R2 configuration. Existing legacy `ImageJobsService` endpoints still use their original in-memory jobs and should remain on one API instance until migrated. Agent state/storage itself does not depend on local files.

Cancel stops work not yet submitted. Requests already submitted may finish and incur charges. Retry is explicit: selected completed/failed/interrupted images become a new draft for inspection. No automatic paid repair loops are enabled. Maximum 20 image tasks per run and three active runs per account are application bounds, not billing estimates.

Every step has a request ID, run ID and step ID in the existing private audit journal. Actual provider billing is not inferred if usage is unavailable. Replica deployments need centralized log collection or access to each instance's journal. The old diagnostic archive retains its existing retention/access rules.

## API

- `GET /api/agent/auth/status`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET|POST /api/agent/conversations`, `GET /conversations/:id`, `POST /conversations/:id/messages`
- `GET /api/agent/runs`, `PATCH /runs/:id/plan`, `POST /runs/:id/start|cancel|retry`
- `GET|POST /api/agent/assets`, `GET /assets/:id/content`, `PATCH /assets/:id/review`
- `GET|POST /api/agent/templates`

Protected routes require `Authorization: Bearer <session-token>`. Browser tokens live in session storage and expire after the configured session duration. Legacy routes retain their existing access policy; this release does not add authentication to the old tools.

## Verification

```sh
npm run build
npm run lint:check
npm test -- --runInBand
npm run test:e2e -- --runInBand
node --test test/agent-mongodb.test.cjs
```

Agent integration tests start a real temporary MongoDB process using `mongodb-memory-server`, then mock image providers and R2. They do not call paid APIs or use production data. The first test run downloads the MongoDB binary; CI needs network access or a cached binary.

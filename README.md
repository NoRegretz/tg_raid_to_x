# VibeVibe raid notifier

A hosted Telegram bot that watches Raidar in one group/topic and posts your notification to a selected X account when a new raid starts while watching is ON. “Raid Started!” triggers once; “Raid Tweet” refreshes and edits do not trigger another post. Only the configured owner can operate the bot.

## Hosted setup: Railway or a Linux VPS

**Choose one hosting path below. No local bot installation or local Node.js is required.** Both paths use the included Dockerfile, which installs Node.js and dependencies and includes the setup helpers. The bot runs as a continuous background worker using outbound Telegram polling: it needs no website, inbound port, public domain, or webhook.

1. [Create the Telegram bot](#1-create-the-telegram-bot).
2. Deploy in dry run using [Railway](#2a-railway) **or** [VPS with Docker Compose](#2b-linux-vps-with-docker-compose).
3. [Discover and save the Telegram IDs](#3-configure-the-group-and-raidar).
4. [Set text and test detection](#4-set-text-and-test-without-x-charges).
5. [Configure X and test one live post](#5-connect-x-and-go-live).

Once the bot responds, open **Controls → 📖 Setup & usage guide** or DM `/guide` for owner usage instructions. Installation belongs in this README; the in-bot guide covers operating an already hosted bot.

Keep credentials in Railway Variables or the VPS `.env`, never in GitHub or Telegram. Hosting may cost money even in dry run; dry run avoids X calls during ordinary bot operation.

## 1. Create the Telegram bot

1. Open [@BotFather](https://t.me/BotFather), create a bot and save its token privately.
2. Enable **Bot-to-Bot Communication Mode** for the new notifier bot.
3. Add it to the group where Raidar operates.
4. Make the notifier an admin, or disable Group Privacy in BotFather. Re-add the bot if Telegram requires this for the privacy change to take effect.
5. Obtain your own numeric Telegram user ID using a trusted account-ID tool. This is `OWNER_TELEGRAM_ID`, not an @username or phone number.

Receiving another bot's ordinary group messages requires bot-to-bot reception plus appropriate group visibility. Confirm an actual Raidar message arrives during dry run. See [Telegram's bot-to-bot documentation](https://core.telegram.org/bots/features#bot-to-bot-communication).

The notifier authorizes its owner by numeric ID. Group admins, creators and ordinary users gain no control rights. `/where` is the only setup command the owner uses in the group; its reply is sent privately.

## 2A. Railway

Use this section for a Railway service deployed from this GitHub repository. Railway is a managed hosting service; commands for a Linux VPS's Docker Compose are not Railway commands.

1. Create a Railway project/service from [NoRegretz/tg_raid_to_x](https://github.com/NoRegretz/tg_raid_to_x). Use the repository-root **Dockerfile**. Leave the start-command override empty to use `node src/main.js` from the image. Do not use a cron job.
2. Attach a persistent **Volume** to this same service at **`/app/data`** before running the bot.
3. Add the following in the service's **Variables**, using your real token and owner ID. These values are entered directly, without wrapping quotes:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
OWNER_TELEGRAM_ID=your_numeric_telegram_user_id
DRY_RUN=true
WATCH_MODE=manual
DATABASE_PATH=/app/data/raid-notifier.sqlite
RAILWAY_RUN_UID=0
```

`RAILWAY_RUN_UID=0` is Railway's documented workaround for its root-owned volume mounts with a non-root image. It runs this container as root on Railway. The image normally runs as `node` on Docker Compose; do not add this Railway-specific variable to other platforms. See [Railway volume permissions](https://docs.railway.com/volumes#permissions).

4. Initially leave `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID` and `RAIDAR_BOT_ID` unset. Leave X credentials unset until step 5. Other settings use code defaults; `.env.example` is a reference, not a file Railway needs from GitHub. In the Variables UI, leave custom regexes unset unless needed; do not copy shell quote characters around regex values.
5. Keep **one replica**, disable Serverless/App Sleeping for this continuous worker, and configure a restart policy suitable for a continuously running process under your Railway plan. Leave the HTTP healthcheck path unset: this bot has no HTTP health endpoint. A public domain is unnecessary. See [Railway Dockerfile builds](https://docs.railway.com/builds/dockerfiles) and [Serverless behavior](https://docs.railway.com/deployments/serverless).
6. Deploy and read the deployment logs. Expect `DRY RUN`, `Watching: OFF`, and a listening message. Missing group IDs are expected during discovery in dry run. DM `/start` from the owner's account, then continue to step 3.

Changing Variables requires applying/deploying the changes. Keep the same volume attached on every redeploy. Do not put database-dependent helpers in build or pre-deploy commands: Railway volumes are available at runtime, not during those phases. [Railway volume availability](https://docs.railway.com/volumes#volume-availability).

### Railway remote helper commands

Use [Railway SSH](https://docs.railway.com/cli/ssh) to enter the **running service container** with its Variables and mounted volume. You need Railway CLI/SSH access from an operator's terminal; no local Node.js bot process is needed. Select the intended project, environment and service:

```sh
railway ssh
```

Inside the remote shell:

```sh
cd /app
node src/main.js --check
node scripts/doctor.js
```

The first command validates configuration without network calls. The doctor checks Telegram access without consuming updates or calling X. Do not run another `node src/main.js` without `--check` inside this shell; the service already runs the poller.

For SSH without a public domain, Railway documents connecting by **Service Instance ID**. Follow its SSH page if your CLI cannot select the instance. Do not substitute `railway run`: that runs a command locally with Railway variables, not against the deployed volume.

## 2B. Linux VPS with Docker Compose

Use this section for your own Linux server. Install [Docker Engine](https://docs.docker.com/engine/install/) and the [Compose plugin](https://docs.docker.com/compose/install/linux/) on that server. Connect to it using SSH. All commands below run **on the VPS**, not in a local Windows bot folder.

Put [this repository](https://github.com/NoRegretz/tg_raid_to_x) in a stable server folder, such as `/opt/raid-notifier`, and use that folder for future deployments. For a fresh installation, clone it with an account that can write to the chosen folder:

```sh
git clone https://github.com/NoRegretz/tg_raid_to_x.git /opt/raid-notifier
```

If the repository is already present, use its existing folder instead. Replace the example path if you use another location:

```sh
cd /opt/raid-notifier
test -f .env || cp .env.example .env
chmod 600 .env
nano .env
```

Set `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_ID`. Keep `DRY_RUN=true`, `WATCH_MODE=manual`, group/topic/Raidar IDs blank, and X credentials blank during discovery. Save the file, then run:

```sh
docker compose build
docker compose run --rm raid-notifier node src/main.js --check
docker compose up -d
docker compose logs -f raid-notifier
```

The Compose file injects `.env` into the container and explicitly sets `DATABASE_PATH=/app/data/raid-notifier.sqlite`. It mounts the named `raid-data` volume at `/app/data` and uses `restart: unless-stopped`. No host port is exposed. Ctrl+C exits log-following; the detached bot keeps running after you disconnect from SSH.

Expect a dry-run listening message. DM `/start` as owner and continue below. For a fresh Telegram access check inside the running container:

```sh
docker compose exec raid-notifier node scripts/doctor.js
```

After changing the VPS `.env`, apply it by recreating the container:

```sh
docker compose up -d --build --force-recreate
```

`docker compose restart` alone does not apply changed environment variables. Use `docker compose stop` to stop the hosted process, and `docker compose up -d` to bring it back. Do not use `docker compose down -v`: it deletes persistent state.

## 3. Configure the group and Raidar

With the hosted dry-run bot responding to owner DMs, go to the intended raid group/topic. **Reply to a real Raidar message** with:

```text
/where@YourNotifierBotUsername
```

The bot privately reports:

| Reported field | Deployment variable |
| --- | --- |
| Chat ID | `TELEGRAM_CHAT_ID` — use the exact negative ID |
| Topic ID | `TELEGRAM_TOPIC_ID` |
| Replied sender ID | `RAIDAR_BOT_ID` — confirm “sender is bot” is true |

For a group without topics, leave `TELEGRAM_TOPIC_ID` empty/unset. For a forum, set the specific raid topic ID. Blank does not mean all topics. Never invent an ID prefix or identify Raidar by display name alone.

**Railway:** save these values in service Variables and deploy the changes. **VPS:** edit the server `.env`, then run `docker compose up -d --build --force-recreate` from the project folder. Keep `DRY_RUN=true`.

Open owner **Health** and inspect startup access and last Raidar activity. Health reports observations and cached/startup checks; it does not recheck every permission live. Use the remote doctor commands above for a fresh Telegram access check.

## 4. Set text and test without X charges

1. Open owner **Controls → Edit text** and send the full notification as one message. No command prefix is needed. Example — replace the group link:

```text
🚨 A raid just started!

Join us: https://t.me/your_group
Target: {raid_url}
Started: {started_at}
```

2. Tap **Preview text**. Spaces, line breaks and normal emojis are preserved as received. Maximum: 280 X weighted characters. Telegram bold/italic and animated custom emojis do not become X formatting. `{raid_url}` and `{started_at}` are optional; preview shows the template and a dry run shows its expanded output.
3. Confirm the main panel says **DRY RUN**. Tap **Watching OFF · Start**, wait for ON confirmation and until the next second, then start a new raid through Raidar.
4. Expect one owner DM announcing detection and a second with the proposed X text. Refreshes should add no notification. Check **Recent raids**.
5. Tap **Stop**, start another raid while watching is OFF, then turn watching ON. That old raid must not be announced. Only a separate new start after the new ON cutoff can notify. Tap Stop when finished.

Ordinary dry-run operation makes no X calls. The `x-account` helper below is explicitly different: it may perform a billable account lookup even while `DRY_RUN=true`.

## 5. Connect X and go live

Create/select an app in the [X Developer Console](https://developer.x.com/). Enable OAuth 1.0a user authentication with **Read and write** permissions. If asked for app type, select **Web App, Automated App or Bot** and complete the required registration fields. This notifier uses user tokens; it does not serve a login callback website.

In **Keys & Tokens → OAuth 1.0 Keys**, obtain the credentials for the account that should publish. Labels can vary:

| X credential | Railway Variable / VPS `.env` key |
| --- | --- |
| Consumer Key / API Key | `X_API_KEY` |
| Consumer Secret / API Key Secret | `X_API_SECRET` |
| OAuth 1.0 Access Token | `X_ACCESS_TOKEN` |
| OAuth 1.0 Access Token Secret | `X_ACCESS_TOKEN_SECRET` |

Do not substitute an app-only bearer token or OAuth 2.0 Client ID/Secret. If user tokens were generated before write permissions were enabled, regenerate them after saving permissions. Verify the account name shown beside the token; another account requires authorizing as that account. Regenerating credentials invalidates their old values. See [X's OAuth user-token documentation](https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens).

### Discover the X account ID on the host

Keep watching **OFF** and `DRY_RUN=true`. Save the four X credentials in Railway Variables or the VPS `.env`, and deploy/recreate so the running container receives them. Then run the helper in the deployed container:

**Railway:** enter the remote shell using `railway ssh`, then:

```sh
cd /app
node scripts/x-account.js
```

**VPS:** from the server's Compose project folder:

```sh
docker compose exec raid-notifier node scripts/x-account.js
```

The helper prints the authenticated account name and `X_EXPECTED_USER_ID=...`. Verify the name, then save that numeric ID as another deployment variable. It never posts; an uncached lookup uses one X request reservation. Running it in the hosted container keeps the identity cache and request budget in the same persistent database as the bot.

### One live test

1. Confirm watching is **OFF** in the owner's panel.
2. Set `DRY_RUN=false` in Railway Variables and deploy, or in the VPS `.env` and recreate the container. No PowerShell/local bot process is involved.
3. Check deployment logs. Live startup refuses an X account-ID mismatch. Open Controls and confirm **LIVE**, the intended account, and saved text.
4. Tap **Start**, wait for ON confirmation and until the next second, then start one new Raidar raid. Expect one X post and a DM with its link. Refreshes must not add posts.
5. Tap **Stop** when finished, or deliberately select **Always on** for continuous watching.

An X posting error pauses further attempts. Fix the cause and inspect the account before using **Clear posting pause**. Old attempts never retry automatically. X may reject repeated identical text. The bot creates a normal post; X decides whether followers receive push notifications.

## Owner controls after deployment

| Button | What it does |
| --- | --- |
| Watching OFF · Start | Enable future raid notifications; does not start Raidar or publish immediately |
| Watching ON · Stop | Disable watching and discard queued unsent notifications |
| Manual / Always on | Show the selected mode; Manual stops watching, Always on enables it |
| Edit text / Preview text | Save or inspect notification text without posting to X |
| Health | Show local blockers, polling, startup checks and recent activity; no X probes |
| Usage & limits | Show actual configured caps and request counters |
| Recent raids | Show detection and delivery outcomes |
| Pause posting / Clear posting pause | Separate posting/error control; does not reset usage |
| Setup & usage guide | Four owner-only help pages with Previous/Next navigation |
| Refresh | Update the timestamped panel snapshot |

Use the persistent **🎛 Controls** button or `/start` to reopen the panel. Old panels expire after 15 minutes or a restart; they open fresh controls without executing the old action. Text editing expires after ten minutes or a restart. Saved text remains intact.

Owner command shortcuts remain available: `/watch`, `/unwatch`, `/mode manual`, `/mode always`, `/text <message>`, `/preview`, `/status`, `/limits`, `/pause`, `/resume`, `/diagnose`, `/guide`, `/menu`. All controls require the numeric owner in private chat. Only owner `/where` works in a group, replying privately.

## Persistence, updates and missed raids

| Item | Railway | VPS Compose |
| --- | --- | --- |
| Secrets and environment settings | Service Variables | Server `.env` injected by Compose |
| Persistent files | Volume mounted at `/app/data` | Named `raid-data` volume at `/app/data` |
| Database path inside container | `/app/data/raid-notifier.sqlite` | `/app/data/raid-notifier.sqlite` |
| Apply configuration/code changes | Deploy service changes | `docker compose up -d --build --force-recreate` |

Retaining the same database preserves saved text, mode, watching ON/OFF, posting pauses, usage counts and raid identities. Manual ON resumes ON; OFF stays OFF. Saved owner choices override the `WATCH_MODE` environment fallback. Keep one service/replica per bot token, including during migrations; never run a second poller from a remote shell or laptop.

Every restart and OFF → ON activation sets a fresh timestamp cutoff. Starts from downtime or the OFF period, delayed old messages, and same-second activation starts are skipped. Restart discards previous unsent work. An X request dispatched before Stop was processed can still finish afterward. A temporary network outage without a process restart retains the current session's `MAX_EVENT_AGE_SECONDS` freshness window (default 300 seconds).

A rebuild retains settings only if the same volume remains attached. Keep the same Compose project name/path on a VPS; deleting a Railway service/volume or creating a fresh volume does not migrate settings. Back up the database through the hosting platform or with the writer stopped. Stop source and destination writers when transferring SQLite state; retain any WAL sidecar alongside the database and restore compatible file ownership. Restoring an older backup also rolls back usage counters. Never delete the database to bypass caps.

On other managed hosts, explicitly configure a continuous worker, one instance, runtime secrets, a writable persistent mount and the database path within that mount. Do not assume Railway's UID variable, Compose's `.env` loading or restart policy applies there. Serverless functions and ephemeral filesystems alone do not fit this bot.

## Costs and limits

Defaults, configurable in Railway Variables or the VPS `.env`:

```dotenv
X_MAX_POSTS_24H=100
X_MAX_REQUESTS_24H=120
X_MAX_REQUESTS_TOTAL=10000
X_MIN_POST_INTERVAL_SECONDS=0
```

These are request-attempt caps, not dollar budgets. Total requests include account lookups; failed, uncertain and crashed reservations count. Rolling limits use the previous 24 hours. The cumulative cap never automatically renews. Blocked raids are skipped instead of queued for later. Switching watching or restarting does not reset counters. There is no default cooldown between separate new starts.

Configure an X-side spending limit and disable automatic recharge to provide an independent billing backstop. X sets prices and can charge for API use; local counts cannot guarantee zero charges or protect credentials used outside this code. See [X pricing and billing controls](https://docs.x.com/x-api/getting-started/pricing). Hosting and storage have their own charges.

## Troubleshooting on the host

| Symptom | Action |
| --- | --- |
| No owner DM/button response | Check deployment is running, token and numeric owner ID. Other users/admins are intentionally denied. |
| No Raidar activity | Check bot-to-bot mode, group membership, admin/privacy settings and exact group/topic/sender IDs. Run the remote doctor helper. |
| SQLite permission denied on Railway | Check `/app/data` volume, `DATABASE_PATH` and the Railway UID setting documented above. |
| Settings lost after redeploy | Verify the same volume and path. A container filesystem outside the mount is not durable state. |
| HTTP healthcheck failure / website does not respond | Remove the HTTP healthcheck requirement. This worker has no web server; use logs and owner Health. |
| Dry-run DMs but no X post | Expected in dry run. Follow step 5 on the hosting platform. |
| Posting paused / X error | Inspect the X account, permissions, credits and duplicate text. Fix the cause before Clear posting pause. |
| Limit reached | Inspect Usage & limits; wait for rolling usage to expire or increase the configured cap on the host and redeploy. |
| Telegram HTTP 409 | Stop another poller using the same token. Check other services, old deployments and local copies. |
| Changed VPS `.env` has no effect | Recreate the container; a plain restart keeps its previous environment. |

Health uses observations and startup/cache results. It does not verify current X credentials, balance or availability, and an offline bot cannot answer it.

## Optional local development only

This is separate from hosted setup. If developing on a computer, install Node.js 24.13 or newer and run `npm ci`, `npm test`, and `npm run demo` from the repository. On Windows PowerShell use `npm.cmd` instead of `npm` if script execution is restricted. Tests/demo use mocks and make no live Telegram or X requests.

A local bot uses its own `.env` and database (`./data/raid-notifier.sqlite` by default). It does not share hosted settings unless explicitly migrated. Do not run it with the production token while the hosted service is running.

For lifecycle matching, fast refresh handling, custom run IDs and delivery failure details, see [Detection and delivery reference](docs/REFERENCE.md). For remaining security assumptions, see [SECURITY.md](SECURITY.md).

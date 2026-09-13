# Security and credit review

Reviewed for the Raidar-to-X workflow on 2026-09-13. This is a code review and automated test record, not a guarantee against every failure or compromise.

## Findings addressed

| Previously possible | Current protection |
| --- | --- |
| An authorized Raidar operator repeatedly starts raids and causes repeated X requests | Owner-controlled watch windows, persistent lifetime and rolling request caps, post cap; no default cooldown |
| X rejects posts but every subsequent raid attempts another paid request | First posting error pauses later posts; owner resume required |
| A 429 results in additional automatic attempts | Automatic posting retries removed |
| Restart loops repeatedly request the X account identity | Credential-specific cache; uncached lookups count toward the same lifetime and rolling caps |
| Repeated use of the account-ID helper performs unlimited account reads | Helper shares the persistent cache and budget |
| A crash/failed response resets apparent spending | Reservations commit before requests and are never refunded; interrupted delivery pauses posting |
| A paused or blocked raid is later sent as stale work | Blocked starts are skipped; resume admits only future starts |

## Existing protections verified

- Button actions require the numeric owner ID and matching private chat, a random current-process panel token, the exact panel message ID, and an action actually offered on that panel. Tokens are single-use, expire after 15 minutes, and never survive restart. Forwarded, inline, non-owner and group callbacks cannot change settings or disclose owner data. Admin status grants no access.
- Button-based text entry is owner-private-only, preserves exact text, validates it before saving, and expires after ten minutes/restart. Health, preview and usage buttons make no X requests. Health distinguishes runtime observations from cached/startup checks.
- Raidar's numeric sender ID, bot flag, exact chat ID and selected topic are checked before lifecycle text. A display name, forwarded message, reply, human message or different bot cannot confer Raidar's identity.
- The first nonempty line must match the configured start header. Quoted X post content cannot trigger a start. Known refresh headers and edits do not create new notifications.
- Owner commands require the numeric owner ID. Watch, mode, text, pause, resume, and usage commands additionally require a direct private chat; forwarded commands and edited messages are excluded.
- Message content is treated as text. There is no shell execution, evaluation of messages, or fetch of arbitrary URLs embedded in messages. The process exposes no inbound webhook endpoint.
- The X client permits only its two required API operations. It refuses network access without the request-budget gate. Both startup and the X-account helper use that gate.
- X responses, errors and token-bearing Telegram request URLs are not dumped into normal logs. Secrets and SQLite data are ignored by Git and excluded from the Docker build context. The Docker image defaults to the non-root node user. The documented Railway volume-permission workaround overrides this with RAILWAY_RUN_UID=0, so that deployment runs as root; other platforms keep the image default unless explicitly overridden.
- SQLite identities, offsets and request counts survive a normal restart. Atomic reservations share a cap across connections using the same database.
- `npm audit --omit=dev` reported zero known vulnerabilities at review time; that result does not establish that dependencies have no undiscovered flaws.

## Boundaries and remaining risks

1. **Raids are indirect authority.** Anyone allowed to make the real Raidar bot start raids can cause genuine source messages. Restrict who can start raids through Raidar. The receiver cannot infer which human caused a Raidar message from the supplied screenshots. Manual mode reduces exposure to owner-enabled watch windows; its last ON/OFF choice is restored on restart, with a fresh cutoff that excludes downtime raids. While watching, limits bound requests but cannot establish that each permitted raid is desirable.
2. **Raidar's format and account remain trusted.** A bug or compromise causing new “Raid Started!” messages is indistinguishable from new starts to this parser. A unique run-ID pattern can deduplicate a repeated run when available; caps still apply.
3. **Credentials can be used outside this code.** Stolen X keys, a compromised VPS, compromised owner account, or locally modified source/configuration can bypass intended behavior. Use X-side spending limits, disable auto-recharge, protect credentials, and revoke exposed tokens.
4. **The database is part of the security boundary.** Deleting, replacing, rolling back or cloning it changes counters. Separate deployments/databases do not share a limit. Run one service, retain its database, and keep provider billing limits as the independent backstop.
5. **Request caps are not billing estimates.** Failed attempts consume local reservations whether X bills them or not. Prices and charging rules belong to X. Usage predating this version is not reconstructed. A new database with defaults allows at most 10,000 reserved X requests through this application's guarded paths before the lifetime cap is reached.
6. **Timing and ambiguous delivery remain external.** An already-dispatched request cannot be unsent. Telegram/X outages, clock skew, and network loss can lose notifications. Downtime starts are skipped on process restart; a suspended process or temporary disconnection without restart is still the same session and retains the configured freshness window.
7. **Availability can be attacked without spending X credits.** Large volumes of incoming messages can consume CPU, logs or database space and disrupt service. Source filters and credit caps prevent ordinary non-Raidar messages from using X, but this code does not promise general denial-of-service immunity.

## Verification

Tests cover forged/copycat senders, group/DM restrictions, downtime and refresh suppression, concurrent budget reservations, shared-database caps, failed requests, clock rollback, rolling limits, lifetime exhaustion, cache reuse, credential changes, and persistent pause/resume semantics, watch activation cutoffs, manual restart behavior, owner-only watch controls, and immediate separate starts without a default cooldown. X responses in the suite are simulated; no live X request is made by `npm test` or `npm run demo`.

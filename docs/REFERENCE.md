# Detection and delivery reference

For Railway or VPS installation, follow the [README](../README.md). This reference explains runtime behavior.

### Fast refreshes and reception

The service consumes Telegram's **update queue**, rather than checking the latest visible message at intervals. Its `getUpdates` request waits up to 25 seconds while idle and returns when updates become available; 25 seconds is not a scheduled delay between checks. It immediately opens the next request after processing the returned batch. Telegram documents that [incoming updates are queued for up to 24 hours](https://core.telegram.org/bots/api#getting-updates).

When a batch contains “Raid Started!” followed immediately by an edit or new “Raid Tweet” message, the service processes every update in order. It saves an eligible start and the next Telegram offset in one SQLite transaction. The refresh cannot erase that queued notification. The separate X worker may run later in the same session without needing the original message to remain visible. Tests cover this burst and confirm that a restart before posting skips the old notification.

This verifies our handling of delivered updates, not an absolute guarantee of Telegram delivery. Run one instance continuously with bot-to-bot reception enabled, and test an actual Raidar start followed by its quickest refresh in dry run. Confirm the saved start in `/status`.

### Owner-controlled watching

The default is `WATCH_MODE=manual`. Keep the VPS process running, DM `/watch` before a raid session, and DM `/unwatch` when finished. Only the configured numeric owner can use these controls in a private DM. `/status` shows watching ON/OFF, watch mode, and any separate posting pause. `/start` opens the owner panel; it does not enable watching.

Manual mode starts OFF only when there is no saved choice. The owner's last ON/OFF choice survives process and VPS restarts: ON resumes watching for new starts, and OFF stays off. For continuous watching, DM `/mode always`; it enables watching now and after future restarts. `/mode manual` selects manual mode and stops watching. `/unwatch` also selects manual mode, so an automatic restart cannot undo your stop. Mode and ON/OFF choices are saved together in SQLite and override the `WATCH_MODE` environment fallback.

Enabling watching accepts only start timestamps strictly after the activation cutoff; wait until the next second before starting your first raid. Repeating `/watch` while already watching leaves the cutoff unchanged. Starts received while off, delayed starts from before activation, and queued notifications discarded when stopping are never replayed. Offline/old activation commands cannot turn watching on after a restart; resend the command after startup. Already-dispatched X requests cannot be recalled.

Watching and the X error pause are separate. `/watch` never clears an error pause; fix its cause and use `/resume`. `/resume` does not enable watching if it is off. No watch command resets request counters. While watching is ON, any genuine start from the configured Raidar bot can qualify, regardless of which human started it in Raidar.

### Restarts and downtime

After startup checks, the service records a new cutoff before listening. Only Telegram start-message timestamps **strictly later** than that cutoff are eligible. This cutoff resets on every process restart and appears in `/status` as “Accepting starts after”. A raid from downtime is skipped even if it is only one second old. Telegram timestamps have whole-second precision, so starts in the same second as startup are also skipped. Keep the server's clock synchronized.

Unsent notifications left in SQLite from a previous session are marked `skipped` at startup. Attempts interrupted during an X request become `uncertain`, pause further posting, and are never automatically retried. Saved text, prior results, and deduplication records are retained. Queued owner text/settings commands still work, but old watch activation commands are rejected; the bot does not indiscriminately discard the entire Telegram update queue.

To test for free: set `DRY_RUN=true`, stop the bot, start a raid with Raidar, then restart the bot within five minutes. That downtime raid must produce no dry-run notification. DM `/watch`, wait for its confirmation and until the next second, and start another raid; only this new raid should notify. Check `/status` for skipped and dry-run outcomes.

The separate `MAX_EVENT_AGE_SECONDS=300` limit caps delivery delays **within a running session**. It never overrides the startup cutoff. A temporary network outage or suspended process that resumes without restarting remains the same session; eligible messages may still arrive within this age limit.

The default start pattern matches your screenshots:

- `RAID_START_PATTERN` matches the complete first nonempty line “Raid Started!”, allowing leading emojis, whitespace, and an optional exclamation mark. “Raid Tweet” does not match.
- Only the first nonempty line controls the lifecycle. “Raid Started!” appearing inside quoted post content cannot trigger a notification.
- `RAID_END_PATTERN` recognizes common headers such as “Raid completed” and “Raid ended”. These completion formats are provisional because the supplied screenshots show only a start and refresh. Completion takes precedence over a start match.
- Target links can come from message text, photo/video captions, Telegram URL entities, hidden text links, or inline keyboard URL buttons. Standard X/Twitter status URLs and like/repost intent links are supported. Shortened or other redirect links are not fetched.
- Without a run-ID pattern, exactly one distinct X target must be found; ambiguous messages are ignored.

The screenshot fixtures use target post `2096332571554595311`. The visible target URL is sufficient; the unknown button URLs and link preview are not needed. **Confirm one actual start and multiple refreshes in dry run before going live** to verify Telegram delivery and actual message metadata. Screenshots do not supply numeric group/topic/sender IDs; discover those with `/where` as above.

If you already copied an earlier `.env.example`, clear `RAID_START_PATTERN` in the deployment environment to use the new default, or copy its updated value from `.env.example`. Do not keep the earlier broad `raid` matcher: start-message deduplication relies on distinguishing starts from refreshes.

### Identity behavior

By default, the identity is **group + topic + original “Raid Started!” message ID**. Deduplication has no cooldown or expiry. “Raid Tweet” refreshes never become identities, regardless of their Telegram message IDs. A later explicit “Raid Started!” in a new message counts as a new raid, even if it targets the same X post. Re-delivery or edits of the original start remain suppressed.

If Raidar includes a stable, unique raid-run identifier in its text or a button URL, configure `RAID_ID_PATTERN`. Its **first capture group** must contain the identifier shared by every refresh of that raid and different for the next run. Example, only if your actual messages contain this format:

```dotenv
RAID_ID_PATTERN='Raid ID:\s*([A-Za-z0-9_-]+)'
```

When configured, messages without that capture are ignored instead of falling back to a different identity. Do not use a progress count, refresh time, or another value that changes within a raid. A run-ID pattern is optional for the supplied screenshot format. Do not change identity patterns during an active raid: that can make an existing raid appear new.

Starting the service midway through a raid does not announce a “Raid Tweet” refresh, even with an empty database. A first observation that is an edit, completion, or old start is skipped. If an initial start was missed, the bot waits for the next explicit start instead of announcing the ongoing raid late. This depends on Raidar continuing to distinguish starts and refreshes as shown; a new message retaining “Raid Started!” would count as another start unless a shared run ID is configured.

Dry-run identities remain suppressed when switching to live, so your test raid will not suddenly post. The next genuine start in a new Telegram message can notify, including for the same target. Keep the database intact. Records from the initial target-keyed implementation still suppress their recorded original start message without permanently blocking new starts of that target.


## Failure behavior

| Outcome | Behavior |
| --- | --- |
| `posted` | X returned a post ID; saved permanently before owner notification |
| `dry_run` | Matched once and previewed; no X request |
| `pending` | Eligible notification queued for its first attempt in the current session |
| `failed` | Missing/invalid text, unresolved placeholder, or definitive X rejection; X errors pause posting |
| `uncertain` | Timeout, server error, unreadable success, or crash during delivery; inspect X manually, posting pauses |
| `skipped` | Watching off, before activation/startup, previous-session pending work, old/edit/completion event, expired delivery, mode change, paused posting, cooldown, or request cap |

SQLite commits identity and Telegram update offset together. An atomic database claim and a separate atomic budget reservation precede each X request. There are no automatic X POST retries, including after 429 responses. X errors pause later posts. Ordinary refreshes never act as retries.

**External posting cannot guarantee both zero duplicates and zero lost notifications after an ambiguous network failure.** This implementation prioritizes avoiding duplicate posts: it holds uncertain attempts permanently, including after restart. It does not expose a “retry all” command. Inspect the account and send a missed notification manually if needed. Do not delete dedup records to resolve an ambiguous result.

Within the current session, old events and queued notifications expire after 300 seconds by default. Events from before this session and pending work from a previous session are always skipped, regardless of age. Skipped identities remain in the database. A missed initial message followed only by edits or “Raid Tweet” refreshes is intentionally skipped.

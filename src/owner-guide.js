import { DEFAULT_X_LIMITS } from './x-budget.js';

// Owner-facing help for an already running bot. Installation belongs in README.
export const OWNER_GUIDE = [
  { id: 'guide', title: 'Start here', text: `📖 Owner guide · 1/4

Your bot is running. Everything here is controlled from your private chat. Group admins and other users cannot operate it.

FIRST USE
1. Open Controls → Edit text. Send the full notification as one message.
2. Use Preview text to check it, then Health to inspect the bot's status.
3. Check Delivery on the main panel: DRY RUN previews in DM; LIVE publishes to the configured X account.
4. Tap Watching OFF · Start. Wait for ON confirmation and until the next second before starting a raid through Raidar.
5. After your raids, tap Watching ON · Stop.

Starting watching does not start a Raidar raid or immediately publish to X. Only a matching new Raidar start can trigger a notification.

Use 🎛 Controls beside the message box to return to the panel. If it is hidden, send /start. Refresh updates the displayed state.

Reading this guide changes no settings and makes no X requests.` },
  { id: 'guidewatch', title: 'Watching & restarts', text: `📖 Owner guide · 2/4

WATCHING AND MODES
• Start enables watching for future raids. Stop disables it and discards queued, unsent notifications.
• Manual is for sessions you start and stop yourself. Selecting Manual stops watching. Your later ON/OFF choices are remembered.
• Always on enables continuous watching, including after a restart. Stop switches back to Manual.
• Both the mode and last ON/OFF choice survive VPS/Railway restarts and redeploys when the same persistent database volume is retained. Replacing the volume starts a new bot state.

NO CATCH-UP POSTS
Raids started while OFF or before a process restart are skipped, even if their messages arrive later. Turning ON never replays them. Refreshes (“Raid Tweet”) and edits never create another notification. A separate new “Raid Started!” message can notify again, even for the same target.

After turning ON, wait until the next second before starting the raid. An X request already dispatched before Stop is processed can still finish afterward.

While ON, any genuine start from the configured Raidar bot can qualify. The notifier cannot tell which person started it.

Old buttons expire after 15 minutes or restart. Tapping one opens fresh controls without executing the old action; tap the fresh button to act.` },
  { id: 'guidetext', title: 'Notification text', text: `📖 Owner guide · 3/4

EDIT YOUR NOTIFICATION
Tap Edit text, then send your complete notification as one text message within 10 minutes. No command prefix is needed. Cancel keeps the existing text. Navigating away, using a command or restarting also cancels unfinished editing.

Spaces, blank lines and standard emojis are preserved as received. The bot validates the 280 weighted-character X limit. If rejected, shorten the text and send it again. Your old text remains saved until a valid replacement is accepted.

Use plain text, ordinary emojis and visible URLs. Telegram bold, italic and animated custom emojis are not converted to X formatting.

OPTIONAL PLACEHOLDERS
{raid_url} → the target X post link
{started_at} → the raid start time in UTC

Example:
🚨 A raid just started!

Join us: https://t.me/your_group
Target: {raid_url}
Started: {started_at}

Replace the example group link with yours. Nothing is appended automatically. Preview text shows the saved template; a dry-run notification shows expanded values. Saving or previewing never publishes to X.

A saved change applies to future raid detections. X may reject repeated identical posts; any posting error pauses further attempts.` },
  { id: 'guidehealth', title: 'Health & troubleshooting', text: `📖 Owner guide · 4/4

HEALTH AND USAGE
Health shows uptime, recent Telegram polling, startup access checks, last Raidar activity and local posting blockers. It uses observations and cached X account information; it does not verify current X balance or credentials and makes no X requests. An offline bot cannot answer buttons.

Usage & limits shows your actual configured caps. Defaults: ${DEFAULT_X_LIMITS.maxPosts24h} post attempts and ${DEFAULT_X_LIMITS.maxRequests24h} total X requests per rolling 24 hours, ${DEFAULT_X_LIMITS.maxRequestsTotal.toLocaleString('en-US')} cumulative requests, no posting cooldown. Failed/uncertain requests count. Watching changes and restarts never reset usage. Limits are changed in the deployment configuration, not through buttons.

IF NO NOTIFICATION APPEARS
1. Refresh Controls: confirm Watching ON, saved text, the intended X account and Delivery mode.
2. Check Health and Recent raids. “None received” means Raidar reception is unconfirmed; ask whoever maintains the bot to check group/topic/sender IDs and Telegram access using the README.
3. If posting is paused, inspect the X account and fix the reported cause first. Then tap Clear posting pause. If watching is OFF, also tap Start. Only new raids can notify; old attempts are not retried.
4. If a limit was reached, skipped raids will not be sent later. Wait for rolling usage to expire or have the configured cap raised in Railway Variables or the VPS deployment environment, then redeploy.

No response at all? Check the hosting service's deployment logs and that you are using the configured owner's Telegram account. Stop watching keeps the hosted process running; stopping the hosting service prevents button replies. The README has separate Railway and VPS setup paths. Never paste API keys into the bot.` },
];

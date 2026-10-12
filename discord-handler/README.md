# Cloudflare Discord approval handler

This Worker handles Assign and Dismiss buttons posted by the action. Deploy it
separately from the action; GitHub Actions sends the message, and Discord sends
clicks to the Worker's public `/interactions` endpoint.

## Create the Discord application

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy its application ID and public key. Create/reset the bot token on its Bot page.
3. Install the bot in your server using the `bot` OAuth2 scope. Give it **View Channel**,
   **Send Messages**, **Embed Links**, and **Read Message History** in the target channel.
4. Enable Discord Developer Mode and copy the server, channel, and approver user IDs
   or approver role IDs. Approval permissions use these IDs, not GitHub usernames.

## Configure Cloudflare

Install the fork's dependencies with `bun install --frozen-lockfile`.
Edit `discord-handler/wrangler.jsonc`:

| Variable | Value |
| --- | --- |
| `GITHUB_REPOSITORY` | Repository containing the issues, exactly matching the action's owner/name casing. One repository per deployment. |
| `DISCORD_APPLICATION_ID` | Discord application ID. |
| `DISCORD_GUILD_ID` | Discord server ID. |
| `DISCORD_CHANNEL_ID` | Same channel ID used by the action. |
| `DISCORD_APPROVER_USER_IDS` | Comma-separated Discord user IDs allowed to approve/dismiss. |
| `DISCORD_APPROVER_ROLE_IDS` | Comma-separated Discord role IDs allowed to approve/dismiss. |
| `GITHUB_REQUIRED_LABEL` | Optional label that must still be present at approval time; match the action's `required_label`. |

Configure at least one approver user or role. No approvers means all clicks are denied.
A matching user **or** role grants approval within the configured server/channel.

Generate a shared random secret, for example with `openssl rand -hex 32`. Store the
same value in the Worker's `DISCORD_BUTTON_SECRET` and the repository's Actions
secret `DISCORD_BUTTON_SECRET`.

Use a GitHub fine-grained personal access token restricted to the target repository
with **Issues: read and write**. The Worker's `GITHUB_TOKEN` is a separate credential;
the short-lived Actions `GITHUB_TOKEN` cannot serve this hosted handler.

Authenticate Wrangler and configure secrets (commands run from the repository root):

```sh
bunx wrangler login
bunx wrangler secret put DISCORD_PUBLIC_KEY --config discord-handler/wrangler.jsonc
bunx wrangler secret put DISCORD_BOT_TOKEN --config discord-handler/wrangler.jsonc
bunx wrangler secret put DISCORD_BUTTON_SECRET --config discord-handler/wrangler.jsonc
bunx wrangler secret put GITHUB_TOKEN --config discord-handler/wrangler.jsonc
bun run handler:deploy
```

Set the Discord application's **Interactions Endpoint URL** to the deployed URL,
for example `https://issue-assignment-approvals.<account>.workers.dev/interactions`.
Discord verifies the endpoint by sending a signed ping. The Worker verifies
Ed25519 signatures over the original request body and rejects stale timestamps.
No gateway connection, slash command registration, or privileged intents are needed.

## Enable the action

In the repository containing the issues, add Actions secrets `DISCORD_BOT_TOKEN`
and `DISCORD_BUTTON_SECRET`, and an Actions variable `DISCORD_CHANNEL_ID`.
Use the workflow example under [Optional Discord approval buttons](../README.md#optional-discord-approval-buttons).
Commit/push the action and pin `uses:` to that built commit.

The bot token, channel ID, and signing secret must match the Worker. The webhook
input is ignored when `discord_buttons_enabled` is true. Enabling buttons also
activates approval mode, so requests do not assign themselves automatically.

## Click behavior and state

- Authorized clicks receive a private deferred response immediately while processing
  continues. Other users get a private permission error and cannot change GitHub.
- Button signatures bind the action, repository, issue, comment ID, requester, and
  original comment body. Editing a comment or changing the requester invalidates its
  old buttons; post a new request. The comment must belong to the configured issue.
- Assign refreshes GitHub data and checks that the issue is open, still has any
  required label, and has no different assignee. It assigns the original commenter,
  verifies GitHub accepted the assignment, and updates the Discord message.
- Dismiss records the decision and updates Discord without changing GitHub.
- Completed messages have their controls removed. The original comment remains linked.
- SQLite-backed Durable Objects serialize decisions per repository/issue and store
  each comment's result, preventing repeated or simultaneous clicks from assigning
  twice or changing an earlier dismissal into approval. State survives Worker restarts.
- If a Discord update fails after assignment, the stored decision lets a retry update
  the message without repeating assignment. If GitHub delivery is uncertain, the
  next click checks whether the commenter was already assigned before writing.

The action checks its normal eligibility rules before posting. Clicking Assign is
an explicit maintainer approval: the handler rechecks the current issue, comment,
and configured required label; it does not rerun workload limits or add assignment
labels/comments. GitHub changes outside this handler are not serialized with its
Durable Object, so maintainers should avoid assigning the same issue simultaneously
through another interface. Existing maintainer commands remain available.

Request notifications are still sent once per action run. A rerun can create a
second Discord message, but the same comment's approval decision remains final.
To request reconsideration after dismissal, post a new comment. Rotating the signing
secret invalidates existing buttons. Retain the Durable Object namespace/migration
when redeploying to preserve decisions.

## Development and verification

```sh
bun run test
bun run test:unit
bun run handler:build
bun run handler:dev
```

`handler:build` runs Wrangler with `--dry-run`; it does not deploy. `handler:dev`
uses local Durable Object state. Use local `.dev.vars` files for development secrets;
they are ignored by Git. A public HTTPS endpoint is required for real Discord clicks.

Wrangler and `@cloudflare/workers-types` are development dependencies. The handler
uses built-in crypto/fetch APIs with Cloudflare's `nodejs_compat` flag; it adds no
runtime npm dependencies. Cloudflare Workers and SQLite-backed Durable Objects are
required only when buttons are enabled. Configure billing and storage for your own
Cloudflare account as needed.

References: [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding),
[Cloudflare Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).

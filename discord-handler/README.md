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
the short-lived Actions `GITHUB_TOKEN` cannot serve this hosted handler. Alternatively,
use the optional GitHub App setup below.

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
- Dismiss records the denial without assigning the requester.
- Both decisions post a GitHub issue comment mentioning the requester and stating
  whether their request was approved or denied. The comment is posted by the
  account owning the Worker's GitHub token. Stored state and a hidden comment marker
  prevent duplicate notifications on retries, including a lost create-comment response.
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
assignment labels or welcome comments; it posts the decision comment described above. GitHub changes outside this handler are not serialized with its
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

## Optional: post as a GitHub App

This is optional. The default workflow posts request receipts as `github-actions[bot]`,
and the Worker posts decisions as the account owning its personal `GITHUB_TOKEN`.
For a branded identity, configure both components to use a GitHub App installation.
An organization cannot author comments directly; an App uses `<app-slug>[bot]`.

1. In the organization settings, open **Developer settings → GitHub Apps → New GitHub App**.
   Set a unique name and homepage URL, disable webhooks, grant **Repository permissions →
   Issues: read and write**, and restrict installation to your account.
2. In the App registration, open **Credentials → Key pairs → New key** and save the
   PEM privately. Older GitHub layouts show **General → Private keys** instead.
   This is a private key, not an OAuth client secret.
3. Use **Install App** to install it on only the repository receiving requests.
   Record the App ID and the installation ID (from the installation settings URL).
4. Add the complete PEM as repository Actions secret `ASSIGNMENT_APP_PRIVATE_KEY`,
   and add Actions variable `ASSIGNMENT_APP_ID` containing the App ID.
5. Add the following step before the assignment action, then pass its token to the
   action's existing `github_token` input:

```yaml
- name: Create optional App token
  if: vars.ASSIGNMENT_APP_ID != ''
  id: app-token
  uses: actions/create-github-app-token@v3
  with:
    app-id: ${{ vars.ASSIGNMENT_APP_ID }}
    private-key: ${{ secrets.ASSIGNMENT_APP_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
    repositories: ${{ github.event.repository.name }}
    permission-issues: write
- uses: scoobs-mystery-bytes/assign-issue-action@<built-commit-sha>
  with:
    github_token: ${{ steps.app-token.outputs.token || github.token }}
    discord_buttons_enabled: "true"
    discord_bot_token: ${{ secrets.DISCORD_BOT_TOKEN }}
    discord_channel_id: ${{ vars.DISCORD_CHANNEL_ID }}
    discord_button_secret: ${{ secrets.DISCORD_BUTTON_SECRET }}
```

A complete workflow is available in [examples/assignment-requests.yml](../examples/assignment-requests.yml).

Keep the existing `issue_comment` trigger, issue-write permission, job condition,
assignment limits, and required label. Use a built commit containing receipt support.
The token action accepts App IDs; its current recommendation is to use `client-id`
instead if you choose to store the App's client ID.

For the Worker, add these non-secret variables to `discord-handler/wrangler.jsonc`:

```json
"GITHUB_APP_ID": "<app-id>",
"GITHUB_APP_INSTALLATION_ID": "<installation-id>"
```

Upload the same complete PEM file directly from your terminal:

```sh
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --config discord-handler/wrangler.jsonc < /absolute/path/to/app.private-key.pem
bun run handler:deploy
```

The Worker generates a fresh short-lived installation token for each approval,
restricted to the configured repository and Issues write permission. Complete App
configuration overrides `GITHUB_TOKEN`; partial App settings fail rather than
silently posting under a personal identity. Keep the personal token while verifying
migration, then revoke it if it is no longer needed elsewhere. To return to personal
mode, remove both App variables and the App private-key secret, retaining `GITHUB_TOKEN`.

Do not commit PEM files or put private keys in `wrangler.jsonc`. A downloaded PEM
is a secret; store it in a password manager or another secure location. App-generated
comments trigger GitHub Actions events, but this action ignores bot comments.

Test a new request after updating the workflow on the default branch: its receipt
should use the App identity. Approve or dismiss it and confirm that the decision
comment uses the same identity. Existing comments retain their original authors.

References: [GitHub App workflow authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow),
[installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

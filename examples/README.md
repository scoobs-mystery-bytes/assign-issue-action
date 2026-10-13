# Setup and deployment for this fork

These examples use `scoobs-mystery-bytes/assign-issue-action`. Copy workflows into
`.github/workflows/` in the repository containing your issues, on its default branch.
Replace every `REPLACE_WITH_BUILT_COMMIT_SHA` with a pushed fork commit that includes
`dist/index.mjs`. Do not use the upstream action reference for this fork's features.

## Choose a workflow

| Flow | Complete example | Additional setup |
| --- | --- | --- |
| GitHub approval outputs | [github-review.yml](github-review.yml) | No Discord or Cloudflare. Review requests manually or connect another approval integration. |
| Discord webhook notifications | [discord-webhook.yml](discord-webhook.yml) | Discord incoming webhook. No bot, buttons, or Worker. |
| Discord buttons with shared tracking | [assignment-requests.yml](assignment-requests.yml) | Custom Discord bot and Cloudflare approval handler. Follow steps 1–6 below. |
| Direct Discord buttons | [assignment-requests.yml](assignment-requests.yml), omitting `discord_handler_url` | Same bot and Worker; requests are not tracked together. |

All examples require the label `ready for development`. Create and apply that label,
change it to your own, or remove the workflow's `required_label` and set the Worker's
`GITHUB_REQUIRED_LABEL` to an empty string. The buttons example sets a maximum of 10
open assignments per contributor; customize `max_assignments` for your project.
Recognized contribution phrases use substring matching; they are not an AI classifier.

For original assignment-only commands and scheduled maintenance, prefer the
[upstream action](https://github.com/takanome-dev/assign-issue-action).
The fork also supports the [basic automatic-assignment workflow](../README.md#basic-automatic-assignment).

## GitHub review without Discord

Copy [github-review.yml](github-review.yml), replace its action commit, and save it
on the default branch. Eligible `/assign-me` comments emit request outputs and write
a review link to the workflow log. The example does not assign anyone, store a queue,
or post receipt/decision comments. A maintainer must assign through GitHub, or your
own integration must consume the outputs and recheck eligibility before assignment.
No hosted handler, custom GitHub token, or Discord credentials are needed.

## Discord webhook notifications without buttons

1. In the target Discord channel, open **Edit Channel → Integrations → Webhooks**.
   Create an incoming webhook and copy its URL.
2. In the issue repository, open **Settings → Secrets and variables → Actions → Secrets**.
   Add repository secret `DISCORD_ASSIGNMENT_WEBHOOK_URL` with that URL.
3. Copy [discord-webhook.yml](discord-webhook.yml), replace the action commit, and save
   it on the default branch.
4. On an open, unassigned issue with the required label, comment `/assign-me`.
   Check the Actions run and Discord notification. Assignment remains manual.

This flow has no approval buttons or receipt/decision comments. Repeated requests
and workflow reruns can create duplicate notifications. A webhook URL is a secret;
it is not the Discord application's Interactions Endpoint URL.

## Discord buttons and shared tracking

### 1. Prepare the fork locally

Install Bun, Git, and a Cloudflare account with access to Workers and Durable Objects.
Clone the fork and install its dependencies:

```sh
git clone https://github.com/scoobs-mystery-bytes/assign-issue-action.git
cd assign-issue-action
bun install --frozen-lockfile
```

Cloudflare hosts the handler; your computer is only needed for configuration and
deployment. GitHub Actions runs the request detector separately. No continuously
running local process is required.

### 2. Create and install a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and create an application, or select an application you own.
2. On **General Information**, record its **Application ID** and **Public Key**.
3. On **Bot**, obtain its bot token. The token is separate from the public key,
   application ID, and OAuth client secret. Resetting it invalidates the old token
   everywhere it is used.
4. Under **Installation**, enable **Guild Install**, select the `bot` scope, and
   request **View Channels**, **Read Message History**, **Send Messages**, and
   **Embed Links**. Open the install link and authorize it in your server.
5. For a private notification channel, explicitly grant the bot those permissions
   under **Edit Channel → Permissions**. Server membership alone is insufficient.
6. Enable Discord **User Settings → Advanced → Developer Mode**. Copy the server
   ID (also called guild ID), channel ID, and the numeric user IDs or role IDs of
   approvers. Role names such as “Moderator” are not valid IDs.

An existing bot is usable only if you control its application and token. A shared
third-party bot such as MEE6 does not supply an identity for this integration.
The handler supports assignment interactions only. Setting an existing application's
Interactions Endpoint URL also routes its other interactions here, so use a separate
application if it already serves unrelated slash commands or buttons.

### 3. Configure and deploy the Cloudflare Discord approval handler

For a new deployment, copy the generic configuration into the handler directory:

```sh
cp examples/wrangler.jsonc discord-handler/wrangler.jsonc
```

For an existing deployment, edit its current config instead: preserve its Worker
name, Durable Object binding, and migration history so stored decisions survive.
Do not deploy the example config directly from `examples/`; its `main` path is
intended for `discord-handler/wrangler.jsonc` after copying.

Replace all `YOUR_...` placeholders. Set `GITHUB_REPOSITORY` to the exact issue
repository owner/name, set the Discord IDs from step 2, and configure at least one
approver user ID or role ID. Comma-separate multiple IDs. Match `GITHUB_REQUIRED_LABEL`
to the workflow label. Leave unused approver lists empty.

For the default GitHub authentication, create a fine-grained token restricted to
that repository with **Issues: read and write**. Choose the repository owner as
resource owner and complete any organization approval. The hosted Worker cannot use
GitHub Actions' temporary token. Optional App authentication is covered below.

Generate a signing secret locally:

```sh
openssl rand -hex 32
```

Save it securely; GitHub and Cloudflare must receive the same value. Authenticate
Wrangler and upload each secret when prompted, using raw values without quotes or
a `Bot ` prefix:

```sh
bunx wrangler login
bunx wrangler secret put DISCORD_PUBLIC_KEY --config discord-handler/wrangler.jsonc
bunx wrangler secret put DISCORD_BOT_TOKEN --config discord-handler/wrangler.jsonc
bunx wrangler secret put DISCORD_BUTTON_SECRET --config discord-handler/wrangler.jsonc
bunx wrangler secret put GITHUB_TOKEN --config discord-handler/wrangler.jsonc
bun run handler:deploy
```

Record the deployed URL printed by Wrangler. If deployment reports that a
`workers.dev` subdomain is missing, open Cloudflare **Workers & Pages** and configure
the account's free `workers.dev` subdomain, then deploy again. No purchased domain
or DNS changes are required for a `workers.dev` URL.

`handler:deploy` uploads the Worker code and configuration; it does not push the
GitHub Action or add a repository workflow. `wrangler secret put` updates the deployed
Worker secret without a separate code redeployment. Inspect secret names with:

```sh
bunx wrangler secret list --config discord-handler/wrangler.jsonc
```

### 4. Connect Discord interactions

In the same Discord application's **General Information**, save the Interactions
Endpoint URL as `https://YOUR_WORKER.workers.dev/interactions`, using the actual
base URL printed by Wrangler. Discord must verify it successfully before proceeding.
A verification failure usually requires checking the Worker's `DISCORD_PUBLIC_KEY`
against this application. Also match `DISCORD_APPLICATION_ID` to the same application.

The public key and bot token must both belong to the bot installed in your server.
No slash-command registration, privileged intents, or Gateway connection is needed.

### 5. Configure the issue repository's workflow

In **Settings → Secrets and variables → Actions**, create repository settings:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `DISCORD_BOT_TOKEN` | Same bot token as Cloudflare; used for direct-delivery mode. |
| Secret | `DISCORD_BUTTON_SECRET` | Same signing secret as Cloudflare. |
| Variable | `DISCORD_CHANNEL_ID` | Target channel's numeric ID; used for direct-delivery mode. |
| Variable | `DISCORD_HANDLER_URL` | Full deployed Worker base URL, without `/interactions`. Required for the shared-tracking example. |

Copy [assignment-requests.yml](assignment-requests.yml) into
`.github/workflows/assignment-requests.yml`, replace the action commit placeholder,
and save on the default branch. GitHub supplies the default workflow token; do not
create a repository secret named `GITHUB_TOKEN`. No checkout of contributor code
is needed in the issue-comment workflow.

The optional `ASSIGNMENT_APP_ID` variable and `ASSIGNMENT_APP_PRIVATE_KEY` secret can
remain unset. For direct bot delivery, remove `discord_handler_url` and retain the
bot token/channel inputs. This disables cross-request tracking while keeping buttons.

### 6. Verify the complete flow

1. Open an unassigned issue with the required label. Use a contributor who has not
   reached the assignment limit. Post a new `/assign-me` comment.
2. Confirm the Actions run succeeds, Discord displays **Assign** and **Dismiss**,
   and GitHub mentions the requester with a receipt comment.
3. Click **Assign** with an authorized Discord account. Confirm GitHub assigns that
   commenter, a decision comment appears, and Discord removes the buttons.
4. On another eligible issue, test **Dismiss**: it posts a denial and leaves the
   issue unassigned.
5. With shared tracking enabled, have two different contributors request the same
   issue. Approve one. Confirm the other's message closes and their GitHub comment
   explains that the issue went to another contributor. Repeat requests by the same
   contributor should reuse the existing pending message and receipt.

A successful workflow run alone does not prove a request was sent: eligibility
checks can skip requests. Test with a fresh comment after configuration changes.

## Optional: branded comments from a GitHub App

This is optional. Without an App, direct receipts use `github-actions[bot]`, and
Worker comments use the owner of its personal token. In shared-tracking mode the
Worker posts both receipts and decisions, so configuring App authentication on the
Worker is sufficient to brand both. The workflow can still use its default token.

Follow the [complete App creation and installation instructions](../discord-handler/README.md#optional-post-as-a-github-app).
Install it on the issue repository with **Issues: read and write** and save the
complete PEM privately. Under the App's **Credentials → Key pairs → New key**,
create the PEM; do not use an OAuth client secret.

Add `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` to the Worker's `vars`, then:

```sh
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --config discord-handler/wrangler.jsonc < /absolute/path/to/app.private-key.pem
bun run handler:deploy
```

The path is a local upload source; the file does not need hosting. Complete App
settings override the Worker's personal token. Remove all App settings to return
to personal-token mode. Partial App configuration fails instead of silently changing
identity. Keep PEMs out of Git and chat.

For direct-delivery receipt comments to use the App too, add Actions variable
`ASSIGNMENT_APP_ID` and secret `ASSIGNMENT_APP_PRIVATE_KEY` (the complete PEM).
The workflow example already creates and passes an optional App installation token.
App configuration in GitHub and Cloudflare is separate; updating one does not update
the other. Check the author of a new receipt and decision comment after migration.

## Updates and deployment boundaries

| Change | Required action |
| --- | --- |
| Worker code or `wrangler.jsonc` variables | Run `bun run handler:deploy`. |
| Worker secret | Run `wrangler secret put` for that secret. |
| Action implementation | Build, push the fork commit including `dist/index.mjs`, then update the workflow's pinned SHA. |
| Workflow YAML | Save it on the issue repository's default branch. |
| GitHub Actions secret/variable | Save the setting and trigger a fresh request. |

When building action changes, run `bun run test`, `bun run test:unit`,
`bun run tsdown`, and `bun run build`. For an existing deployment, update the Worker
before enabling new action features. Keep the existing Durable Object migration.
Old Discord messages are not retroactively added to shared tracking.

## Troubleshooting

Start with **GitHub → Actions → Assignment requests → notify** for request delivery.
For button processing and shared-tracking registration, use Worker logs:

```sh
bunx wrangler tail --config discord-handler/wrangler.jsonc --format pretty
```

| Symptom | Check |
| --- | --- |
| Run succeeds but no notification | Required label, open/unassigned state, ignored users, author restrictions, and assignment limits in the action log. |
| Discord HTTP 401 | Bot token is valid, raw, and belongs to the installed bot. Update GitHub and Cloudflare after a reset. |
| Discord HTTP 403 / Missing Access | Bot is installed and has explicit access to the private channel and required permissions. |
| Button does not respond and Worker receives no request | Correct application's saved `/interactions` endpoint and successful Discord verification. |
| GitHub HTTP 401/403 in Worker | Worker token or App credentials, repository installation/access, Issues write permission, and organization approval. |
| Registration HTTP 401 | Matching signing secrets in GitHub and Cloudflare. |
| Registration HTTP 502 | Check Worker logs for upstream errors or a request whose eligibility changed; correct the problem and rerun the job. |
| Receipt still uses `github-actions[bot]` | In direct mode, ensure App-token step runs and `github_token` receives its output. In tracked mode, configure the Worker's App credentials. |
| Duplicate messages after upgrade | Confirm `DISCORD_HANDLER_URL` is populated and `discord_handler_url` is passed; older messages remain untracked. |

Cleanup failures retry automatically. Initial request-registration failures fail the
workflow and require rerunning it after the error is corrected. See the handler's
[multiple-request behavior and limitations](../discord-handler/README.md#multiple-requests-for-one-issue)
for details. Do not include tokens, private keys, or webhook URLs in shared logs.

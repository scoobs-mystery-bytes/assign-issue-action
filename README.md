<h2 align="center">Assign Issue Action — Automation &amp; Approvals</h2>

<p align="center">Issue assignment commands and scheduled maintenance, extended with optional Discord notifications and approval workflows.</p>


#### This is a maintained fork of [takanome-dev/assign-issue-action](https://github.com/takanome-dev/assign-issue-action), with assignment approval requests, Discord notifications and buttons, shared pending requests, and optional GitHub App identity. Original assignment commands and scheduled maintenance remain available.

If you only need issue assignment commands and scheduled maintenance, without Discord integration, approval requests, or requester messaging, use the original
[takanome-dev/assign-issue-action](https://github.com/takanome-dev/assign-issue-action).

This fork focuses on assignment automation with notifications and maintainer approval so that you do not miss a contributor that would like to work on an issue and has requested to do so.

The original functionality remains part of this fork: contributors can self-assign
and unassign, maintainers can assign other users, and scheduled jobs can send
reminders and release inactive assignments. Assignment limits, labels, and welcome
messages remain configurable. Discord integration and approval workflows are
optional additions; they are not required to use these features.

**Start here:**
[Complete setup and deployment](examples/README.md) ·
[Assignment request workflow](examples/assignment-requests.yml) ·
[Discord and Cloudflare setup](discord-handler/README.md) ·
[Optional GitHub App identity](discord-handler/README.md#optional-post-as-a-github-app)

## Getting started

Choose the flow you need:

| Flow | Configuration | Hosting |
| --- | --- | --- |
| Automatic assignment only | Prefer the [original action](https://github.com/takanome-dev/assign-issue-action). The basic workflow below remains supported in this fork. | GitHub Actions only. |
| Requests for GitHub review | Set `require_approval: "true"` and consume the request outputs. | GitHub Actions only; your review integration performs approval. |
| Discord notifications | Set `require_approval: "true"` and `discord_webhook_url`. | GitHub Actions and a Discord webhook. |
| Discord approval buttons | Set `discord_buttons_enabled: "true"`. Add `discord_handler_url` for shared tracking and automatic closure of competing requests. | GitHub Actions, a Discord bot, and a Cloudflare Worker. |

For Discord approval buttons, follow the [setup guide](discord-handler/README.md)
and copy the [complete workflow example](examples/assignment-requests.yml) into the
repository containing your issues. The example includes optional App authentication;
leave `ASSIGNMENT_APP_ID` unset to use the workflow's default GitHub token.

Deploy the Worker first, configure matching credentials, then enable the workflow
on the issue repository's default branch. Replace the action commit placeholder
with a pushed commit from **this fork** that includes the built `dist/index.mjs`.
The example's `DISCORD_HANDLER_URL` variable must contain your Worker base URL to
enable shared tracking. Its sample required label and assignment limit can be adjusted.

## Features

- Assignment requests from `/assign-me` and recognized contribution phrases, with maintainer approval before assignment.
- Discord webhook notifications or interactive **Assign**, **Dismiss**, and **View request** controls.
- GitHub comments confirming receipt and reporting approval or denial, mentioning the requester.
- Shared pending requests per issue, repeat-request deduplication, and automatic closure of competing requests after approval.
- Durable retries for failed closure notifications.
- Optional GitHub App authentication for a branded comment author; personal tokens remain supported.

Original assignment features remain supported. Approval mode changes contributor
self-assignment into a request; maintainer commands and scheduled maintenance retain
their existing behavior:


- 📝 Self-assign issues using `/assign-me` command (default)
- 🗑️ Self-unassign from issues using `/unassign-me` command (default)
- 👥 Maintainer-controlled assignments using `/assign @<user>` and `/unassign @<user>` commands
- 🎉 Different welcome messages for first-time contributors vs returning contributors
- ⏰ Automatic unassignment of inactive issues after configurable period (default: 7 days)
- 🛡️ Block self-reassignment after unassignment (requires maintainer approval)
- 🚫 Prevent issue authors from self-assigning their own issues (optional, for roadmap control)
- 🔔 Send reminder notifications before automatic unassignment occurs
- 🔢 Limit the maximum number of issues a user can be assigned to simultaneously (default: 3)
- 🎯 Per-label assignment limits to encourage progression from beginner to advanced issues (e.g., limit "good first issue" to 2 assignments)

## Basic automatic assignment

For automatic assignment without approval or Discord, create
`.github/workflows/assign.yml` in the repository containing your issues:

```yaml
name: Assign Issue

on:
  schedule:
    - cron: 0 0 * * *
  issue_comment:
    types: [created]
  workflow_dispatch:

jobs:
  assign:
    permissions:
      issues: write
    runs-on: ubuntu-latest
    steps:
      - name: Assign the user or unassign stale assignments
        uses: scoobs-mystery-bytes/assign-issue-action@<built-commit-sha>
        with:
          github_token: ${{ github.token }}
          maintainers: ''
```

Replace `<built-commit-sha>` with a built commit from this fork. Set `maintainers`
to a comma-separated list of GitHub usernames if maintainer commands are needed.
For approval requests instead of automatic assignment, use the flows below.

## Inputs

Various inputs are defined in action.yml to let you configure the action:

| Name                              | Description                                                                                                                                                                                                 | Default                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `github_token`                    | GitHub API token. Defaults to the workflow token; optionally supply a personal or App installation token.                                                                         | `${{ github.token }}`                                                            |
| `self_assign_cmd`                 | The command that assigns the issue to the one who triggered it                                                                                                                                              | `/assign-me`                                                                     |
| `self_unassign_cmd`               | The command that unassigns the issue from the user who triggered it, if they are already assigned.                                                                                                          | `/unassign-me`                                                                   |
| `assign_user_cmd`                 | The command that assigns the user to the issue                                                                                                                                                              | `/assign @<user>`                                                                |
| `unassign_user_cmd`               | The command that unassigns the user from the issue, if they are assigned.                                                                                                                                   | `/unassign @<user>`                                                              |
| `maintainers`                     | A list of maintainers authorized to use `/assign` and `/unassign` commands. List the usernames with comma separated (i.e: 'takanome-dev,octokit'). If not set, the usage of those commands will be ignored. | `''`                                                                             |
| `discord_webhook_url` | Optional Discord webhook URL for eligible requests when approval mode is enabled. Supply an Actions secret. | `''` |
| `require_approval` | Emit eligible contributor requests for approval instead of assigning or posting suggestions. Maintainer commands and scheduled unassignments are unaffected. | `false` |
| `enable_auto_suggestion`          | A boolean input that controls whether the action should automatically check user comments for phrases signaling interest in issue assignment. Set to true by default.                                       | **`true`**                                                                       |
| `allow_self_assign_author`        | Whether to allow the issue author to self-assign their own issue. Set to `false` to prevent users from creating issues and immediately assigning themselves, giving maintainers control over the roadmap.   | `true`                                                                           |
| `assigned_label`                  | A label that is added to issues when they're assigned, to track which issues were assigned by this action.                                                                                                  | `📍 Assigned`                                                                    |
| `required_label`                  | If set, the issue must have this label to be assigned.                                                                                                                                                      | `''`                                                                             |
| `days_until_unassign`             | The span of time between a user assigning themselves to the issue being unassigned automatically by the action.                                                                                             | `7`                                                                              |
| `pin_label`                       | A label that prevents the user from being unassigned, typically for issues that are expected to take a long time.                                                                                           | `📌 Pinned`                                                                      |
| `assigned_text`                   | The comment posted after a returning contributor (has opened a PR before) has assigned themselves to an issue.                                                                                              | Customizable                                                                     |
| `assigned_newcomer_text`          | The comment posted after a first-time contributor (has never opened a PR) has assigned themselves to an issue. Provides a welcoming message with helpful resources for new contributors.                    | Customizable welcome message                                                     |
| `already_assigned_text`           | The comment posted when a user tries to assign themselves to an issue that is already assigned                                                                                                              | Customizable in the workflow file you're going to create.                        |
| `already_assigned_pinned_text`    | The comment posted when a user tries to assign themselves to a pinned issue that is already assigned                                                                                                        | Customizable message for pinned issues that won't be auto-unassigned.            |
| `unassigned_text`                 | The comment posted after a user is unassigned from an issue (by maintainer or due to inactivity).                                                                                                           | Customizable in the workflow file you're going to create.                        |
| `self_unassigned_text`            | The comment posted after a user unassigns themselves from an issue. If not set, defaults to `unassigned_text`.                                                                                              | Customizable in the workflow file you're going to create.                        |
| `assignment_suggestion_text`      | The comment posted when someone shows interest in being assigned to an issue without using the assignment commands.                                                                                         | Customizable in the workflow file you're going to create.                        |
| `block_assignment`                | Whether to block self-assignment after a user was previously unassigned.                                                                                                                                    | `true`                                                                           |
| `block_assignment_text`           | The comment posted when a user tries to re-assign themselves after being unassigned.                                                                                                                        | Customizable message explaining that a maintainer needs to approve reassignment. |
| `enable_reminder`                 | Whether to send a reminder before automatic unassignment occurs.                                                                                                                                            | `true`                                                                           |
| `reminder_days`                   | How many days after assignment the reminder should be sent. Set to 'auto' to calculate halfway point (days_until_unassign / 2)                                                                              | `auto`                                                                           |
| `reminder_text`                   | The comment posted as a reminder before automatic unassignment.                                                                                                                                             | Customizable message warning about upcoming unassignment.                        |
| `max_assignments`                 | The maximum number of issues a user can be assigned to at once.                                                                                                                                             | `3`                                                                              |
| `max_assignments_text`            | The message posted when a user has reached their maximum assignments.                                                                                                                                       | Customizable message explaining the limit and options for managing assignments.  |
| `max_overall_assignment_labels`   | A comma-separated list of labels that share a per-label assignment limit (e.g., to limit "good first issue" assignments separately from "good second issue").                                               | `good first issue,good second issue`                                             |
| `max_overall_assignment_count`    | The maximum number of issues a user can be assigned for each label in `max_overall_assignment_labels`. Each label has its own independent limit.                                                            | `2`                                                                              |
| `max_overall_assignment_text`     | The message posted when a user has reached the per-label assignment limit.                                                                                                                                  | Customizable message encouraging progression to more advanced issues.            |
| `self_assign_author_blocked_text` | The message posted when an issue author tries to self-assign their own issue but `allow_self_assign_author` is `false`.                                                                                     | Customizable message explaining maintainer approval is needed.                   |
| `ignored_users`                   | A comma-separated list of usernames that are ignored from using `/assign-me`. These users will not be able to self-assign issues.                                                                          | `''`                                                                             |
| `ignored_text`                    | The message posted when an ignored user tries to use `/assign-me`.                                                                                                                                          | Customizable message explaining they cannot self-assign and to contact maintainers. |
| `closed_issue_assignment_text`    | The message posted when a user tries to assign themselves to a closed issue.                                                                                                                                 | Customizable message explaining assignment is only available for open issues.    |

**Note:** The old input names (e.g., `assigned_comment`, `unassigned_comment`, etc.) are still supported for backward compatibility but are deprecated. Please migrate to the new `_text` suffix names. A deprecation warning will be shown in the action logs if you use the old names.

## Approval mode

Set `require_approval: "true"` to turn `/assign-me` comments and recognized
contribution phrases into requests for maintainer review. Phrase detection uses
case-insensitive substring matching against `CONTRIBUTION_PHRASES` in
`commands/command-parser.ts`; it does not understand arbitrary wording or negation.
Keep `enable_auto_suggestion: "true"` to detect these phrases.

Approval mode applies the existing assignment eligibility checks, including
closed or assigned issues, required labels, ignored users, author restrictions,
reassignment blocks, and assignment limits. Pull request comments and bot comments
are ignored. Eligible requests emit outputs without assigning, changing labels,
or posting a comment. Requests rejected by these checks emit no request details.
Maintainer `/assign` and `/unassign` commands and scheduled unassignments retain
their existing behavior. Approval mode does not store pending requests or perform
approval; a subsequent workflow step or external service must handle that.

```yaml
name: Review assignment requests
on:
  issue_comment:
    types: [created, edited]
permissions:
  issues: read
jobs:
  detect:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: scoobs-mystery-bytes/assign-issue-action@<commit-sha>
        id: request
        with:
          require_approval: "true"
          enable_auto_suggestion: "true"
      - if: steps.request.outputs.assignment_requested == 'yes'
        env:
          REQUESTER: ${{ steps.request.outputs.requester }}
          ISSUE_NUMBER: ${{ steps.request.outputs.issue_number }}
          COMMENT_URL: ${{ steps.request.outputs.comment_url }}
        run: |
          printf 'Review assignment of issue %s to %s: %s\n' "$ISSUE_NUMBER" "$REQUESTER" "$COMMENT_URL"
```

Replace `<commit-sha>` with a built commit from this fork. Detection needs only
issue-read permission; maintainer mutation commands need issue-write permission.
Use `comment_id` to deduplicate edited comments in the approval integration, and
recheck issue state and assignees before assigning after approval.

## Discord assignment request notifications

Set `discord_webhook_url` alongside `require_approval: "true"` to notify a Discord
channel when an eligible contributor requests assignment. The message says
**Assignment requested — awaiting maintainer approval** and includes the repository,
issue title and number, requester, original comment excerpt, and a link to review it.
It does not assign the contributor or provide interactive approval buttons.

1. Create an incoming webhook in your Discord channel's integration settings.
2. Store its URL as the repository Actions secret `DISCORD_ASSIGNMENT_WEBHOOK_URL`.
3. Call the action from a workflow in the repository containing the issues:

```yaml
name: Notify assignment requests
on:
  issue_comment:
    types: [created]
permissions:
  issues: read
jobs:
  notify:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: scoobs-mystery-bytes/assign-issue-action@<commit-sha>
        with:
          require_approval: "true"
          enable_auto_suggestion: "true"
          discord_webhook_url: ${{ secrets.DISCORD_ASSIGNMENT_WEBHOOK_URL }}
```

Replace `<commit-sha>` with a built commit from this fork. An empty webhook input
skips notification and retains request outputs. Requests rejected by eligibility
checks, unrelated comments, and maintainer commands do not send notifications.
Only HTTPS `discord.com/api/webhooks/...` URLs (including versioned API paths)
are accepted. A `thread_id` query parameter can target an existing Discord thread.

The webhook URL is masked in action logs, and mentions are disabled in messages.
Discord delivery errors fail the action with a status or sanitized network error;
`discord_notified` remains `no`, while the request outputs remain available.
Requests time out after 15 seconds. Delivery is confirmed using Discord's
[`wait=true` option](https://docs.discord.com/developers/resources/webhook#execute-webhook).

Each eligible comment sends one message per workflow run. Rerunning the workflow,
repeating the request, or enabling edited-comment events can send duplicates;
this action does not persist notification state or automatically retry delivery.
Interactive approval and assignment from Discord are available through the
optional button mode below, using a separately hosted Discord application handler.

## Optional Discord approval buttons

Set `discord_buttons_enabled: "true"` to replace the default webhook notification
with a bot message containing **Assign**, **Dismiss**, and **View request** controls.
Button mode automatically enables approval mode, even if `require_approval` is
false, and takes precedence over `discord_webhook_url`. It never falls back to a
webhook if button credentials are missing or delivery fails. With buttons disabled,
the existing webhook notification and GitHub review flow remain available.

```yaml
name: Review assignment requests in Discord
on:
  issue_comment:
    types: [created]
permissions:
  issues: write
jobs:
  notify:
    if: ${{ !github.event.issue.pull_request }}
    runs-on: ubuntu-latest
    steps:
      - uses: scoobs-mystery-bytes/assign-issue-action@<commit-sha>
        with:
          discord_buttons_enabled: "true"
          discord_bot_token: ${{ secrets.DISCORD_BOT_TOKEN }}
          discord_channel_id: ${{ vars.DISCORD_CHANNEL_ID }}
          discord_button_secret: ${{ secrets.DISCORD_BUTTON_SECRET }}
```

| Input | Default | Purpose |
| --- | --- | --- |
| `discord_buttons_enabled` | `false` | Use bot messages and approval buttons instead of webhooks. |
| `discord_handler_url` | Empty | Worker HTTPS base URL enabling shared pending requests and automatic closure. |
| `discord_bot_token` | Empty | Bot token stored as an Actions secret. |
| `discord_channel_id` | Empty | Channel where the bot posts requests. |
| `discord_button_secret` | Empty | Shared signing secret, at least 32 characters, stored as an Actions secret. |

Buttons require the separately deployed Cloudflare Worker in
[`discord-handler`](discord-handler/README.md). Follow its setup guide before
enabling button mode. No additional hosting is needed for webhook-only mode.

### Request receipt in button mode

After Discord accepts an eligible request, button mode posts a GitHub issue comment
mentioning the requester and confirming that maintainers will review it. Failed
Discord deliveries do not post a receipt. A hidden marker avoids duplicate receipts
when rerunning the same request. The workflow needs `issues: write` permission.
Detection-only and webhook modes retain their existing behavior.

### Optional GitHub App comment identity

A GitHub App is optional. With direct bot delivery, request confirmations use the
workflow token (`github-actions[bot]` by default), while decision comments use the
Worker's GitHub credential. With `discord_handler_url`, the Worker posts both types
of comments using its GitHub credential.
To post both as your own branded App, see [the GitHub App setup](discord-handler/README.md#optional-post-as-a-github-app).
Configure App authentication where comments are posted: the Worker for shared
tracking, and both GitHub Actions and the Worker for direct bot delivery. The
existing token-based setup remains supported.

### Shared pending requests

With Discord buttons enabled, optionally set `discord_handler_url` to your deployed
Worker's HTTPS base URL. Requests from different contributors are tracked per issue;
repeat requests reuse an existing pending message. Approving one contributor closes
other pending requests and mentions each requester on GitHub, explaining that the
issue was assigned to someone else. Failed cleanup notifications retry automatically.

Deploy the updated Worker before enabling the input, then update the workflow to a
built commit from this fork. See [multiple-request setup and upgrade instructions](discord-handler/README.md#multiple-requests-for-one-issue).
Existing messages are not retroactively registered. Direct bot/webhook delivery
remains supported when this input is omitted.

## Outputs

The action provides the following outputs that can be used in subsequent workflow steps:

| Name                | Description                                                                      |
| ------------------- | -------------------------------------------------------------------------------- |
| `discord_notified` | 'yes' after successful Discord delivery, otherwise 'no' on issue comments |
| `assignment_requested` | 'yes' for an eligible request in approval mode, otherwise 'no' on issue comments |
| `requester` | Requester's GitHub login, otherwise empty |
| `issue_number` | Requested issue number, otherwise empty |
| `comment_url` | Original request comment URL, otherwise empty |
| `comment_id` | Original comment ID for deduplication, otherwise empty |
| `assigned`          | Returns 'yes' if an issue was successfully assigned, 'no' otherwise              |
| `unassigned`        | Returns 'yes' if an issue was successfully unassigned, 'no' otherwise            |
| `unassigned_issues` | An array containing the issue numbers that were unassigned during the action run |

## ✏️ Contributing

We would love you to contribute to this project, pull requests are welcome! If you have requests, we are happy to look at integrating them to work with other applications for integrations. Submit a request https://github.com/scoobs-mystery-bytes/assign-issue-action .

## Upstream resources and attribution

This fork builds on [takanome-dev/assign-issue-action](https://github.com/takanome-dev/assign-issue-action).
Original authorship and the MIT license are preserved.


## ⚖️ LICENSE

The scripts and documentation in this project are released under the [MIT License](LICENSE)

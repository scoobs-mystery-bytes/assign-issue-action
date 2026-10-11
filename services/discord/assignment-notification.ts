import * as core from '@actions/core'

export interface DiscordAssignmentRequest {
  repository: string
  issueNumber: number
  issueTitle: string
  requester: string
  commentUrl: string
  commentBody: string
  commentId: number
}

export async function sendDiscordAssignmentRequest(
  webhookUrl: string,
  request: DiscordAssignmentRequest,
): Promise<void> {
  core.setSecret(webhookUrl)

  let url: URL
  try {
    url = new URL(webhookUrl)
  } catch {
    throw new Error(
      'Invalid discord_webhook_url: expected a Discord webhook URL',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname)
  ) {
    throw new Error(
      'Invalid discord_webhook_url: expected a Discord webhook URL',
    )
  }
  url.searchParams.set('wait', 'true')

  const payload = {
    content: 'Assignment requested — awaiting maintainer approval.',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `#${request.issueNumber}: ${request.issueTitle}`.slice(0, 256),
        url: request.commentUrl,
        author: { name: request.repository.slice(0, 256) },
        description: request.commentBody.slice(0, 3500),
        fields: [
          {
            name: 'Requested by',
            value: `@${request.requester}`,
            inline: true,
          },
          {
            name: 'Status',
            value: 'Awaiting maintainer approval',
            inline: true,
          },
          {
            name: 'Original comment',
            value: `[View request](${request.commentUrl})`,
          },
        ],
        footer: { text: `Comment ID: ${request.commentId}` },
        color: 0xf0b232,
      },
    ],
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    })
  } catch {
    throw new Error(
      'Discord assignment notification failed: network error or timeout',
    )
  }
  if (!response.ok) {
    throw new Error(
      `Discord assignment notification failed (HTTP ${response.status})`,
    )
  }
}

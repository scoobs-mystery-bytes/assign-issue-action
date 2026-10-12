import * as core from '@actions/core'
import { createButtonId } from './button-protocol'

export interface DiscordAssignmentRequest {
  repository: string
  issueNumber: number
  issueTitle: string
  requester: string
  commentUrl: string
  commentBody: string
  commentId: number
}

export interface DiscordButtonOptions {
  botToken: string
  channelId: string
  secret: string
}

export async function sendDiscordAssignmentRequest(
  webhookUrl: string,
  request: DiscordAssignmentRequest,
  buttons?: DiscordButtonOptions,
): Promise<void> {
  let url: URL
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (buttons) {
    if (buttons.botToken) core.setSecret(buttons.botToken)
    if (buttons.secret) core.setSecret(buttons.secret)
    if (
      !buttons.botToken ||
      !/^\d{1,20}$/.test(buttons.channelId) ||
      buttons.secret.length < 32
    ) {
      throw new Error(
        'Button mode requires discord_bot_token, discord_channel_id, and a discord_button_secret of at least 32 characters',
      )
    }
    url = new URL(
      `https://discord.com/api/v10/channels/${buttons.channelId}/messages`,
    )
    headers.Authorization = `Bot ${buttons.botToken}`
  } else {
    core.setSecret(webhookUrl)
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
  }

  const payload = {
    content: 'Assignment requested — awaiting maintainer approval.',
    allowed_mentions: { parse: [] },
    ...(buttons
      ? {
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  label: 'Assign',
                  custom_id: createButtonId('assign', request, buttons.secret),
                },
                {
                  type: 2,
                  style: 2,
                  label: 'Dismiss',
                  custom_id: createButtonId('dismiss', request, buttons.secret),
                },
                {
                  type: 2,
                  style: 5,
                  label: 'View request',
                  url: request.commentUrl,
                },
              ],
            },
          ],
        }
      : {}),
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
      headers,
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

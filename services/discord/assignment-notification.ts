import * as core from '@actions/core'
import { assignmentMessage } from './message-payload'
import { requestSignature } from './request-protocol'

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
  handlerUrl?: string
}

export async function sendDiscordAssignmentRequest(
  webhookUrl: string,
  request: DiscordAssignmentRequest,
  buttons?: DiscordButtonOptions,
): Promise<
  | { commentId: number; completed?: boolean; receiptPosted?: boolean }
  | undefined
> {
  if (buttons?.handlerUrl) {
    core.setSecret(buttons.secret)
    if (buttons.secret.length < 32)
      throw new Error('Button signing secret must have at least 32 characters')
    const url = new URL(buttons.handlerUrl)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/', '/requests'].includes(url.pathname)
    ) {
      throw new Error(
        'discord_handler_url must be an HTTPS Worker URL or /requests endpoint',
      )
    }
    url.pathname = '/requests'
    const body = JSON.stringify(request)
    const timestamp = String(Math.floor(Date.now() / 1000))
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Assignment-Timestamp': timestamp,
          'X-Assignment-Signature': requestSignature(
            body,
            timestamp,
            buttons.secret,
          ),
        },
        body,
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      })
    } catch {
      throw new Error(
        'Assignment request handler failed: network error or timeout',
      )
    }
    if (!response.ok)
      throw new Error(
        `Assignment request handler failed (HTTP ${response.status})`,
      )
    const result = (await response.json()) as {
      commentId: number
      completed?: boolean
      receiptPosted?: boolean
    }
    if (!Number.isSafeInteger(result.commentId) || result.commentId < 1)
      throw new Error('Invalid assignment request handler response')
    return result
  }
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

  const payload = assignmentMessage(request, buttons?.secret)

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
  return undefined
}

import { api, ApiError } from './api'
import {
  completeOtherRequests,
  type TrackedRequest,
  type Selection,
} from './pending-requests'
import {
  getGitHubToken,
  hasGitHubAuth,
  type GitHubAuthConfig,
} from './github-auth'
import { createPublicKey, verify } from 'node:crypto'
import {
  parseButtonId,
  verifyButton,
} from '../services/discord/button-protocol'

export interface HandlerConfig extends GitHubAuthConfig {
  DISCORD_PUBLIC_KEY: string
  DISCORD_APPLICATION_ID: string
  DISCORD_GUILD_ID: string
  DISCORD_CHANNEL_ID: string
  DISCORD_BOT_TOKEN: string
  DISCORD_BUTTON_SECRET: string
  DISCORD_APPROVER_USER_IDS?: string
  DISCORD_APPROVER_ROLE_IDS?: string
  GITHUB_REQUIRED_LABEL?: string
}

export interface Interaction {
  type: number
  application_id: string
  guild_id?: string
  channel_id?: string
  token: string
  data?: { custom_id?: string }
  member?: { user?: { id: string }; roles?: string[] }
  message?: { id: string }
}

export interface Resolution {
  status: 'assigned' | 'dismissed' | 'unavailable'
  requester: string
  approver: string
  notified?: boolean
  selectedRequester?: string
  competingCommentIds?: number[]
}

export interface ResolutionStorage {
  get(key: string): Promise<Resolution | undefined>
  put(key: string, value: Resolution): Promise<void>
  listRequests?(): Promise<TrackedRequest[]>
  putRequest?(request: TrackedRequest): Promise<void>
  clearSelection?(): Promise<void>
  markSelection?(selection: Selection): Promise<void>
}

function list(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function reply(content: string): Response {
  return Response.json({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  })
}

export function verifyDiscordSignature(
  body: string,
  timestamp: string,
  signature: string,
  publicKey: string,
): boolean {
  if (
    !/^\d+$/.test(timestamp) ||
    !/^[a-fA-F0-9]{128}$/.test(signature) ||
    !/^[a-fA-F0-9]{64}$/.test(publicKey) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    return false
  try {
    const key = createPublicKey({
      key: Buffer.from(`302a300506032b6570032100${publicKey}`, 'hex'),
      format: 'der',
      type: 'spki',
    })
    return verify(
      null,
      Buffer.from(timestamp + body),
      key,
      Buffer.from(signature, 'hex'),
    )
  } catch {
    return false
  }
}

export async function handleInteraction(
  request: Request,
  config: HandlerConfig,
  enqueue: (interaction: Interaction) => void,
): Promise<Response> {
  if (new URL(request.url).pathname !== '/interactions')
    return new Response('Not found', { status: 404 })
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405 })
  const reader = request.body?.getReader()
  if (!reader) return new Response('Missing body', { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 65536) {
      await reader.cancel()
      return new Response('Body too large', { status: 413 })
    }
    chunks.push(value)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (
    !verifyDiscordSignature(
      body,
      request.headers.get('x-signature-timestamp') ?? '',
      request.headers.get('x-signature-ed25519') ?? '',
      config.DISCORD_PUBLIC_KEY,
    )
  ) {
    return new Response('Invalid signature', { status: 401 })
  }
  let interaction: Interaction
  try {
    interaction = JSON.parse(body) as Interaction
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }
  if (interaction.type === 1) return Response.json({ type: 1 })
  if (
    interaction.application_id !== config.DISCORD_APPLICATION_ID ||
    interaction.guild_id !== config.DISCORD_GUILD_ID ||
    interaction.channel_id !== config.DISCORD_CHANNEL_ID
  )
    return reply('This approval is not configured for this server or channel.')
  const userId = interaction.member?.user?.id
  const authorized =
    !!userId &&
    (list(config.DISCORD_APPROVER_USER_IDS).includes(userId) ||
      (interaction.member?.roles ?? []).some((role) =>
        list(config.DISCORD_APPROVER_ROLE_IDS).includes(role),
      ))
  if (!authorized)
    return reply('You are not authorized to approve assignment requests.')
  if (
    interaction.type !== 3 ||
    typeof interaction.data?.custom_id !== 'string' ||
    !parseButtonId(interaction.data.custom_id) ||
    !/^\d+$/.test(interaction.message?.id ?? '') ||
    !interaction.token
  )
    return reply('Unsupported assignment request.')
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(config.GITHUB_REPOSITORY) ||
    !hasGitHubAuth(config) ||
    !config.DISCORD_BOT_TOKEN ||
    !config.DISCORD_BUTTON_SECRET ||
    config.DISCORD_BUTTON_SECRET.length < 32
  ) {
    return reply('The approval handler is not fully configured.')
  }
  enqueue(interaction)
  return Response.json({ type: 5, data: { flags: 64 } })
}

interface Issue {
  title: string
  state: string
  pull_request?: unknown
  assignees: Array<{ login: string }>
  labels: Array<{ name: string }>
}
interface Comment {
  id: number
  body: string
  html_url: string
  issue_url: string
  user: { login: string; type: string }
}
interface Message {
  embeds?: Array<{
    fields?: Array<{ name: string; value: string; inline?: boolean }>
  }>
  components?: Array<{ components: Array<{ custom_id?: string }> }>
}

export async function resolveAssignment(
  config: HandlerConfig,
  interaction: Interaction,
  storage: ResolutionStorage,
): Promise<string> {
  const button = parseButtonId(interaction.data?.custom_id ?? '')
  if (!button) throw new Error('Invalid assignment button.')
  const githubBase = `https://api.github.com/repos/${config.GITHUB_REPOSITORY}`
  const githubToken = await getGitHubToken(config)
  const githubHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'assign-issue-action',
  }
  const discordHeaders = { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` }
  const messageUrl = `https://discord.com/api/v10/channels/${config.DISCORD_CHANNEL_ID}/messages/${interaction.message?.id}`
  const [comment, issue, message] = await Promise.all([
    api<Comment>(
      `${githubBase}/issues/comments/${button.commentId}`,
      githubHeaders,
    ),
    api<Issue>(`${githubBase}/issues/${button.issueNumber}`, githubHeaders),
    api<Message>(messageUrl, discordHeaders),
  ])
  if (
    comment.issue_url.toLowerCase() !==
      `${githubBase}/issues/${button.issueNumber}`.toLowerCase() ||
    comment.user.type === 'Bot' ||
    !verifyButton(
      button,
      {
        repository: config.GITHUB_REPOSITORY,
        issueNumber: button.issueNumber,
        issueTitle: issue.title,
        requester: comment.user.login,
        commentId: comment.id,
        commentUrl: comment.html_url,
        commentBody: comment.body ?? '',
      },
      config.DISCORD_BUTTON_SECRET,
    )
  ) {
    throw new Error(
      'This request changed or its button is invalid. Ask for a new assignment request.',
    )
  }
  const key = String(button.commentId)
  let resolution = await storage.get(key)
  if (!resolution) {
    if (
      !message.components?.some((row) =>
        row.components.some(
          (item) => item.custom_id === interaction.data?.custom_id,
        ),
      )
    ) {
      throw new Error('This request no longer has active approval buttons.')
    }
    if (button.action === 'assign') {
      if (issue.state !== 'open' || issue.pull_request)
        throw new Error('This issue is no longer open for assignment.')
      if (
        config.GITHUB_REQUIRED_LABEL &&
        !issue.labels.some(
          (label) => label.name === config.GITHUB_REQUIRED_LABEL,
        )
      ) {
        throw new Error('This issue no longer has the required approval label.')
      }
      if (
        issue.assignees.some(
          (assignee) =>
            assignee.login.toLowerCase() !== comment.user.login.toLowerCase(),
        )
      ) {
        throw new Error(
          'This issue is already assigned to someone else. Review it on GitHub.',
        )
      }
      if (!issue.assignees.length) {
        const assigned = await api<Issue>(
          `${githubBase}/issues/${button.issueNumber}/assignees`,
          githubHeaders,
          'POST',
          { assignees: [comment.user.login] },
        )
        if (
          !assigned.assignees.some(
            (assignee) =>
              assignee.login.toLowerCase() === comment.user.login.toLowerCase(),
          )
        ) {
          throw new Error(
            'GitHub did not assign the requested contributor. Review their eligibility on GitHub.',
          )
        }
      }
    }
    resolution = {
      status: button.action === 'assign' ? 'assigned' : 'dismissed',
      requester: comment.user.login,
      approver: interaction.member?.user?.id ?? '',
      competingCommentIds:
        button.action === 'assign'
          ? ((await storage.listRequests?.()) ?? [])
              .filter((entry) => !entry.complete)
              .map((entry) => entry.request.commentId)
          : undefined,
    }
    await storage.put(key, resolution)
  }
  if (resolution.status === 'assigned') {
    const selection = {
      issueNumber: button.issueNumber,
      commentId: button.commentId,
      requester: resolution.requester,
      approver: resolution.approver,
      commentIds: resolution.competingCommentIds ?? [],
    }
    await storage.markSelection?.(selection)
    await completeOtherRequests(config, selection, storage, githubHeaders)
    await storage.clearSelection?.()
    resolution = (await storage.get(key)) ?? resolution
    if (
      (await storage.listRequests?.())?.some(
        (entry) =>
          entry.request.commentId === button.commentId && entry.complete,
      )
    )
      return resolutionStatus(resolution)
  }
  const result = await finalizeResolution(
    config,
    button.issueNumber,
    button.commentId,
    resolution,
    storage,
    githubHeaders,
    interaction.message!.id,
    message,
  )
  if (storage.listRequests && storage.putRequest) {
    const entry = (await storage.listRequests()).find(
      (item) => item.request.commentId === button.commentId,
    )
    if (entry) await storage.putRequest({ ...entry, complete: true })
  }
  return result
}

function resolutionStatus(resolution: Resolution): string {
  return resolution.status === 'assigned'
    ? `Assigned to @${resolution.requester}`
    : resolution.status === 'unavailable'
      ? `Request closed: issue assigned to @${resolution.selectedRequester}`
      : `Assignment request from @${resolution.requester} dismissed`
}

export async function finalizeResolution(
  config: HandlerConfig,
  issueNumber: number,
  commentId: number,
  initialResolution: Resolution,
  storage: ResolutionStorage,
  githubHeaders: Record<string, string>,
  messageId?: string,
  existingMessage?: Message,
): Promise<string> {
  let resolution = initialResolution
  const githubBase = `https://api.github.com/repos/${config.GITHUB_REPOSITORY}`
  const discordHeaders = { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` }
  const messageUrl = `https://discord.com/api/v10/channels/${config.DISCORD_CHANNEL_ID}/messages/${messageId}`
  let message = existingMessage ?? {}
  if (!existingMessage && messageId) {
    try {
      message = await api<Message>(messageUrl, discordHeaders)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        messageId = undefined
      else throw error
    }
  }
  if (!resolution.notified) {
    const commentsUrl = `${githubBase}/issues/${issueNumber}/comments`
    const marker = `<!-- assignment-decision:${commentId}:${resolution.status} -->`
    const body =
      resolution.status === 'assigned'
        ? `@${resolution.requester}, your assignment request was approved. You have been assigned to this issue.`
        : resolution.status === 'unavailable'
          ? `@${resolution.requester}, this issue has been assigned to another contributor. Thank you for offering to help!`
          : `@${resolution.requester}, your assignment request was denied. You have not been assigned through this request.`
    const notification = `${body}\n\n${marker}`
    let found = false
    for (let page = 1; ; page++) {
      const comments = await api<Array<{ body: string }>>(
        `${commentsUrl}?per_page=100&page=${page}`,
        githubHeaders,
      )
      if (comments.some((item) => item.body === notification)) {
        found = true
        break
      }
      if (comments.length < 100) break
    }
    if (!found)
      await api(commentsUrl, githubHeaders, 'POST', { body: notification })
    resolution = { ...resolution, notified: true }
    await storage.put(String(commentId), resolution)
  }
  const status = resolutionStatus(resolution)
  if (messageId)
    await api(messageUrl, discordHeaders, 'PATCH', {
      content: status,
      allowed_mentions: { parse: [] },
      components: [],
      embeds: (message.embeds ?? []).map((embed) => ({
        ...embed,
        fields: embed.fields?.map((field) =>
          field.name === 'Status' ? { ...field, value: status } : field,
        ),
      })),
    })
  return status
}

export async function finishInteraction(
  config: HandlerConfig,
  interaction: Interaction,
  content: string,
): Promise<void> {
  await api(
    `https://discord.com/api/v10/webhooks/${config.DISCORD_APPLICATION_ID}/${encodeURIComponent(interaction.token)}/messages/@original`,
    {},
    'PATCH',
    { content, allowed_mentions: { parse: [] } },
  )
}

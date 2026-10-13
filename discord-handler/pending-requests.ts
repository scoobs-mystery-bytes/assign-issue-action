import type { DiscordAssignmentRequest } from '../services/discord/assignment-notification'
import { assignmentMessage } from '../services/discord/message-payload'
import { api, ApiError } from './api'
import { getGitHubToken } from './github-auth'
import {
  finalizeResolution,
  type HandlerConfig,
  type ResolutionStorage,
} from './handler'

export interface TrackedRequest {
  request: DiscordAssignmentRequest
  messageId?: string
  receiptPosted?: boolean
  complete?: boolean
}
export interface Selection {
  issueNumber: number
  commentId: number
  requester: string
  approver: string
  commentIds: number[]
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'assign-issue-action',
  }
}

export async function registerRequest(
  config: HandlerConfig,
  request: DiscordAssignmentRequest,
  storage: ResolutionStorage,
): Promise<{
  commentId: number
  completed?: boolean
  receiptPosted?: boolean
}> {
  if (!storage.listRequests || !storage.putRequest)
    throw new Error('Pending request storage is unavailable.')
  if (
    request.repository !== config.GITHUB_REPOSITORY ||
    !Number.isSafeInteger(request.issueNumber) ||
    request.issueNumber < 1 ||
    !Number.isSafeInteger(request.commentId) ||
    request.commentId < 1 ||
    typeof request.requester !== 'string' ||
    typeof request.commentBody !== 'string'
  )
    throw new Error('Invalid assignment request.')
  const completed = await storage.get(String(request.commentId))
  if (completed) return { commentId: request.commentId, completed: true }
  const entries = await storage.listRequests()
  let entry = entries.find(
    (item) =>
      !item.complete &&
      item.request.requester.toLowerCase() === request.requester.toLowerCase(),
  )
  const headers = githubHeaders(await getGitHubToken(config))
  const base = `https://api.github.com/repos/${config.GITHUB_REPOSITORY}`
  const [comment, issue] = await Promise.all([
    api<{
      user: { login: string; type: string }
      body: string
      issue_url: string
      html_url: string
    }>(`${base}/issues/comments/${request.commentId}`, headers),
    api<{
      title: string
      state: string
      pull_request?: unknown
      assignees: Array<{ login: string }>
      labels: Array<{ name: string }>
    }>(`${base}/issues/${request.issueNumber}`, headers),
  ])
  if (
    comment.user.type === 'Bot' ||
    comment.user.login !== request.requester ||
    comment.body !== request.commentBody ||
    comment.issue_url.toLowerCase() !==
      `${base}/issues/${request.issueNumber}`.toLowerCase()
  )
    throw new Error('The assignment request changed. Post a new request.')
  if (
    issue.state !== 'open' ||
    issue.pull_request ||
    issue.assignees.length ||
    (config.GITHUB_REQUIRED_LABEL &&
      !issue.labels.some(
        (label) => label.name === config.GITHUB_REQUIRED_LABEL,
      ))
  )
    throw new Error(
      'This issue is no longer available for assignment requests.',
    )
  if (entry) {
    let original: { body: string } | undefined
    try {
      original =
        entry.request.commentId === request.commentId
          ? comment
          : await api<{ body: string }>(
              `${base}/issues/comments/${entry.request.commentId}`,
              headers,
            )
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error
    }
    if (original?.body !== entry.request.commentBody) {
      if (entry.request.commentId === request.commentId)
        throw new Error(
          'The original request changed. Post a new comment to request assignment.',
        )
      if (entry.messageId) {
        try {
          await api(
            `https://discord.com/api/v10/channels/${config.DISCORD_CHANNEL_ID}/messages/${entry.messageId}`,
            { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
            'PATCH',
            {
              content:
                'Request replaced after its original comment changed or was deleted.',
              components: [],
              allowed_mentions: { parse: [] },
            },
          )
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
        }
      }
      await storage.putRequest({ ...entry, complete: true })
      entry = undefined
    }
  }

  if (!entry) {
    entry = {
      request: {
        ...request,
        issueTitle: issue.title,
        commentUrl: comment.html_url,
      },
    }
    await storage.putRequest(entry)
  }
  if (!entry.messageId) {
    const message = await api<{ id: string }>(
      `https://discord.com/api/v10/channels/${config.DISCORD_CHANNEL_ID}/messages`,
      { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` },
      'POST',
      {
        ...assignmentMessage(entry.request, config.DISCORD_BUTTON_SECRET),
        nonce: String(entry.request.commentId),
        enforce_nonce: true,
      },
    )
    if (!/^\d+$/.test(message.id))
      throw new Error('Discord did not return a message ID.')
    entry.messageId = message.id
    await storage.putRequest(entry)
  }
  if (!entry.receiptPosted) {
    const body = `@${entry.request.requester}, your assignment request has been sent to the maintainers for review. We'll let you know here once it has been approved or denied.\n\n<!-- assignment-request-received:${entry.request.commentId} -->`
    let found = false
    for (let page = 1; ; page++) {
      const comments = await api<Array<{ body: string }>>(
        `${base}/issues/${request.issueNumber}/comments?per_page=100&page=${page}`,
        headers,
      )
      if (comments.some((item) => item.body === body)) {
        found = true
        break
      }
      if (comments.length < 100) break
    }
    if (!found)
      await api(
        `${base}/issues/${request.issueNumber}/comments`,
        headers,
        'POST',
        { body },
      )
    entry.receiptPosted = true
    await storage.putRequest(entry)
  }
  return { commentId: entry.request.commentId, receiptPosted: true }
}

export async function completeOtherRequests(
  config: HandlerConfig,
  selection: Selection,
  storage: ResolutionStorage,
  headers?: Record<string, string>,
): Promise<void> {
  if (!storage.listRequests || !storage.putRequest) return
  const github = headers ?? githubHeaders(await getGitHubToken(config))
  const entries = (await storage.listRequests()).filter(
    (entry) =>
      entry.request.commentId === selection.commentId ||
      selection.commentIds.includes(entry.request.commentId),
  )
  // Persist every competing decision before attempting notifications.
  for (const entry of entries) {
    if (entry.complete || entry.request.commentId === selection.commentId)
      continue
    const key = String(entry.request.commentId)
    if (!(await storage.get(key)))
      await storage.put(key, {
        status:
          entry.request.requester.toLowerCase() ===
          selection.requester.toLowerCase()
            ? 'assigned'
            : 'unavailable',
        requester: entry.request.requester,
        approver: selection.approver,
        selectedRequester: selection.requester,
      })
  }
  let failed = false
  for (const entry of entries) {
    if (entry.complete) continue
    const resolution = await storage.get(String(entry.request.commentId))
    if (!resolution) continue
    try {
      await finalizeResolution(
        config,
        selection.issueNumber,
        entry.request.commentId,
        resolution,
        storage,
        github,
        entry.messageId,
      )
      await storage.putRequest({ ...entry, complete: true })
    } catch {
      failed = true
      console.error('Pending assignment notification failed', {
        issueNumber: selection.issueNumber,
        commentId: entry.request.commentId,
      })
    }
  }
  if (failed)
    throw new Error(
      'The assignment was approved, but some notifications are pending. Automatic retries are scheduled.',
    )
}

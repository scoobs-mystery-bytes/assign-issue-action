import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DiscordAssignmentRequest } from './assignment-notification'

export type ButtonAction = 'assign' | 'dismiss'

export interface AssignmentButton {
  action: ButtonAction
  issueNumber: number
  commentId: number
  signature: string
}

function signature(
  action: ButtonAction,
  request: DiscordAssignmentRequest,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(
      JSON.stringify([
        action,
        request.repository,
        request.issueNumber,
        request.commentId,
        request.requester,
        request.commentBody,
      ]),
    )
    .digest('base64url')
}

export function createButtonId(
  action: ButtonAction,
  request: DiscordAssignmentRequest,
  secret: string,
): string {
  const id = `ar1:${action}:${request.issueNumber}:${request.commentId}:${signature(action, request, secret)}`
  if (id.length > 100)
    throw new Error('Assignment button exceeds Discord custom_id limit')
  return id
}

export function parseButtonId(id: string): AssignmentButton | null {
  const match =
    /^ar1:(assign|dismiss):([1-9]\d*):([1-9]\d*):([A-Za-z0-9_-]{43})$/.exec(id)
  if (!match || id.length > 100) return null
  const issueNumber = Number(match[2])
  const commentId = Number(match[3])
  if (!Number.isSafeInteger(issueNumber) || !Number.isSafeInteger(commentId))
    return null
  return {
    action: match[1] as ButtonAction,
    issueNumber,
    commentId,
    signature: match[4],
  }
}

export function verifyButton(
  button: AssignmentButton,
  request: DiscordAssignmentRequest,
  secret: string,
): boolean {
  const expected = signature(button.action, request, secret)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(button.signature))
}

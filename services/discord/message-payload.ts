import { createButtonId } from './button-protocol'
import type { DiscordAssignmentRequest } from './assignment-notification'

export function assignmentMessage(
  request: DiscordAssignmentRequest,
  secret?: string,
): Record<string, unknown> {
  const buttons = secret ? { secret } : undefined
  return {
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
}

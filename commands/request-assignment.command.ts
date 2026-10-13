import * as core from '@actions/core'
import { sendDiscordAssignmentRequest } from '../services/discord/assignment-notification'
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandServices,
} from './types'

export class RequestAssignmentCommand implements Command {
  async execute(
    context: CommandContext,
    services: CommandServices,
  ): Promise<CommandResult> {
    const { issue, comment } = context
    const username = comment?.user?.login

    if (
      !issue ||
      !comment ||
      !username ||
      issue.pull_request ||
      comment.user?.type === 'Bot'
    ) {
      return { success: false, message: 'Not an issue assignment request' }
    }

    const validation = await services.validator.validateAssignment(
      {
        number: Number(issue.number),
        state: issue.state,
        assignee: issue.assignee,
        assignees: issue.assignees,
        user: issue.user,
        labels: issue.labels,
      },
      username,
    )

    if (!validation.valid) {
      core.info(`Skipping assignment request: ${validation.reason}`)
      return { success: false, message: validation.reason }
    }

    core.setOutput('requester', username)
    core.setOutput('issue_number', issue.number)
    core.setOutput('comment_url', comment.html_url)
    core.setOutput('comment_id', comment.id)
    core.setOutput('assignment_requested', 'yes')
    core.info(`Assignment requested by @${username} for issue #${issue.number}`)

    if (
      context.config.discordButtonsEnabled ||
      context.config.discordWebhookUrl
    ) {
      const delivery = await sendDiscordAssignmentRequest(
        context.config.discordWebhookUrl,
        {
          repository: `${context.repoOwner}/${context.repoName}`,
          issueNumber: Number(issue.number),
          issueTitle: issue.title ?? '',
          requester: username,
          commentUrl: comment.html_url,
          commentBody: comment.body ?? '',
          commentId: comment.id,
        },
        context.config.discordButtonsEnabled
          ? {
              botToken: context.config.discordBotToken,
              channelId: context.config.discordChannelId,
              secret: context.config.discordButtonSecret,
              handlerUrl: context.config.discordHandlerUrl,
            }
          : undefined,
      )
      core.setOutput('discord_notified', 'yes')
      core.info('Sent assignment request notification to Discord')
      if (
        context.config.discordButtonsEnabled &&
        !delivery?.completed &&
        !delivery?.receiptPosted
      ) {
        await services.commentService.createCommentOnce(
          Number(issue.number),
          `@${username}, your assignment request has been sent to the maintainers for review. We'll let you know here once it has been approved or denied.`,
          `<!-- assignment-request-received:${delivery?.commentId ?? comment.id} -->`,
        )
      }
    }

    return { success: true, message: 'Assignment requires maintainer approval' }
  }
}

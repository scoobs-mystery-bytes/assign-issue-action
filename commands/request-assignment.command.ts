import * as core from '@actions/core'
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

    return { success: true, message: 'Assignment requires maintainer approval' }
  }
}

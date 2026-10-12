import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import type { ActionConfig } from '../../core'

const outputs = new Map<string, unknown>()
const request = mock(async (route: string): Promise<{ data: unknown }> => {
  if (route === 'GET /search/issues') {
    return { data: { total_count: 0, items: [] } }
  }
  return { data: [] }
})
let config: ActionConfig
const payload = {
  issue: {
    number: 42,
    state: 'open',
    labels: [] as Array<{ name: string }>,
    user: { login: 'author' },
    assignee: null as { login: string } | null,
    assignees: [] as Array<{ login: string }>,
    pull_request: undefined as { url: string } | undefined,
  },
  comment: {
    id: 123,
    body: '/assign-me',
    html_url: 'https://github.com/owner/repo/issues/42#issuecomment-123',
    user: { login: 'contributor', type: 'User' },
  },
}

mock.module('@actions/core', () => ({
  info: mock(() => {}),
  setSecret: mock(() => {}),
  warning: mock(() => {}),
  setOutput: (name: string, value: unknown): void => {
    outputs.set(name, value)
  },
  setFailed: (message: string): never => {
    throw new Error(message)
  },
}))
mock.module('@actions/github', () => ({
  context: { payload, repo: { owner: 'owner', repo: 'repo' } },
}))
mock.module('../../core', () => ({
  getConfig: (): ActionConfig => config,
  createOctokitClient: () => ({ request }),
}))

const { default: CommentHandler } = await import('../comment-handler')

function expectNoWrites(): void {
  expect(request.mock.calls.every(([route]) => route.startsWith('GET '))).toBe(
    true,
  )
}

describe('CommentHandler approval mode', () => {
  afterEach(() => {
    mock.restore()
  })
  beforeEach(() => {
    outputs.clear()
    request.mockClear()
    config = {
      requireApproval: true,
      discordWebhookUrl: '',
      discordButtonsEnabled: false,
      discordBotToken: '',
      discordChannelId: '',
      discordButtonSecret: '',
      enableAutoSuggestion: true,
      selfAssignCmd: '/assign-me',
      selfUnassignCmd: '/unassign-me',
      assignUserCmd: '/assign',
      unassignUserCmd: '/unassign',
      maintainers: ['maintainer'],
      requiredLabel: '',
      allowSelfAssignAuthor: true,
      ignoredUsers: [],
      blockAssignment: false,
      maxAssignments: 3,
      maxOverallAssignmentLabels: [],
      maxOverallAssignmentCount: 0,
      assignedLabel: 'assigned',
      daysUntilUnassign: 14,
      assignedText: 'Assigned to {{handle}}',
      assignedNewcomerText: 'Assigned to {{handle}}',
      assignmentSuggestionText: 'Use /assign-me',
    } as ActionConfig
    payload.issue.state = 'open'
    payload.issue.labels = []
    payload.issue.assignee = null
    payload.issue.assignees = []
    payload.issue.pull_request = undefined
    payload.comment.body = '/assign-me'
    payload.comment.user = { login: 'contributor', type: 'User' }
  })

  for (const body of ['/assign-me', 'I would like to work on this issue']) {
    it(`emits request details without writes for: ${body}`, async () => {
      payload.comment.body = body
      await new CommentHandler().handle_issue_comment()
      expect(outputs.get('assignment_requested')).toBe('yes')
      expect(outputs.get('requester')).toBe('contributor')
      expect(outputs.get('issue_number')).toBe(42)
      expect(outputs.get('comment_url')).toBe(payload.comment.html_url)
      expect(outputs.get('comment_id')).toBe(123)
      expect(outputs.get('assigned')).toBe('no')
      expectNoWrites()
    })
  }

  const excluded: Array<[string, () => void]> = [
    [
      'unrelated comment',
      () => {
        payload.comment.body = 'Thanks!'
      },
    ],
    [
      'quoted request',
      () => {
        payload.comment.body = '> /assign-me'
      },
    ],
    [
      'disabled phrase detection',
      () => {
        config.enableAutoSuggestion = false
        payload.comment.body = 'I would like to work on this issue'
      },
    ],
    [
      'closed issue',
      () => {
        payload.issue.state = 'closed'
      },
    ],
    [
      'assigned issue',
      () => {
        payload.issue.assignees = [{ login: 'other' }]
      },
    ],
    [
      'missing required label',
      () => {
        config.requiredLabel = 'ready'
      },
    ],
    [
      'ignored user',
      () => {
        config.ignoredUsers = ['contributor']
      },
    ],
    [
      'issue author',
      () => {
        config.allowSelfAssignAuthor = false
        payload.comment.user.login = 'author'
      },
    ],
    [
      'assignment limit',
      () => {
        config.maxAssignments = 0
      },
    ],
    [
      'pull request',
      () => {
        payload.issue.pull_request = { url: 'pull-url' }
      },
    ],
    [
      'bot',
      () => {
        payload.comment.user.type = 'Bot'
      },
    ],
  ]
  for (const [name, setup] of excluded) {
    it(`does not emit a request or write for ${name}`, async () => {
      const send = spyOn(globalThis, 'fetch')
      config.discordWebhookUrl =
        'https://discord.com/api/webhooks/123/test-token'
      setup()
      await new CommentHandler().handle_issue_comment()
      expect(outputs.get('assignment_requested')).toBe('no')
      for (const key of [
        'requester',
        'issue_number',
        'comment_url',
        'comment_id',
      ]) {
        expect(outputs.get(key)).toBe('')
      }
      expectNoWrites()
      expect(send).not.toHaveBeenCalled()
      expect(outputs.get('discord_notified')).toBe('no')
    })
  }

  it('accepts requests with the required label', async () => {
    config.requiredLabel = 'ready'
    payload.issue.labels = [{ name: 'ready' }]
    await new CommentHandler().handle_issue_comment()
    expect(outputs.get('assignment_requested')).toBe('yes')
    expectNoWrites()
  })

  it('uses button mode instead of the webhook when enabled', async () => {
    const send = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}'),
    )
    config.discordButtonsEnabled = true
    config.discordWebhookUrl = 'invalid-webhook-must-not-be-used'
    config.discordBotToken = 'bot-token'
    config.discordChannelId = '456'
    config.discordButtonSecret = 'secret'.repeat(8)
    await new CommentHandler().handle_issue_comment()
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0][0])).toBe(
      'https://discord.com/api/v10/channels/456/messages',
    )
    const options = send.mock.calls[0][1]
    expect(options?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bot bot-token',
    })
    const body = JSON.parse(String(options?.body))
    expect(
      body.components[0].components.map(
        (item: { label: string }) => item.label,
      ),
    ).toEqual(['Assign', 'Dismiss', 'View request'])
    expect(outputs.get('discord_notified')).toBe('yes')
    expect(outputs.get('assigned')).toBe('no')
    expectNoWrites()
  })

  it('fails button mode with missing credentials without falling back to the webhook', async () => {
    const send = spyOn(globalThis, 'fetch')
    config.discordButtonsEnabled = true
    config.discordWebhookUrl = 'https://discord.com/api/webhooks/123/token'
    await expect(new CommentHandler().handle_issue_comment()).rejects.toThrow(
      'Button mode requires',
    )
    expect(send).not.toHaveBeenCalled()
    expect(outputs.get('discord_notified')).toBe('no')
  })

  it('sends an eligible request to Discord when configured', async () => {
    const send = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}'),
    )
    config.discordWebhookUrl = 'https://discord.com/api/webhooks/123/test-token'
    await new CommentHandler().handle_issue_comment()
    expect(send).toHaveBeenCalledTimes(1)
    expect(outputs.get('discord_notified')).toBe('yes')
    expect(outputs.get('assignment_requested')).toBe('yes')
    expect(outputs.get('assigned')).toBe('no')
    const body = JSON.parse(String(send.mock.calls[0][1]?.body))
    expect(body.embeds[0].fields[0].value).toBe('@contributor')
    expect(body.embeds[0].url).toBe(payload.comment.html_url)
    expectNoWrites()
  })

  it('retains request outputs and fails when Discord rejects delivery', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 429 }),
    )
    config.discordWebhookUrl = 'https://discord.com/api/webhooks/123/test-token'
    await expect(new CommentHandler().handle_issue_comment()).rejects.toThrow(
      'HTTP 429',
    )
    expect(outputs.get('assignment_requested')).toBe('yes')
    expect(outputs.get('requester')).toBe('contributor')
    expect(outputs.get('discord_notified')).toBe('no')
    expectNoWrites()
  })

  it('does not send when the webhook is empty', async () => {
    const send = spyOn(globalThis, 'fetch')
    await new CommentHandler().handle_issue_comment()
    expect(send).not.toHaveBeenCalled()
    expect(outputs.get('discord_notified')).toBe('no')
  })

  it('still assigns when approval mode is disabled', async () => {
    const send = spyOn(globalThis, 'fetch')
    config.discordWebhookUrl = 'https://discord.com/api/webhooks/123/test-token'
    config.requireApproval = false
    await new CommentHandler().handle_issue_comment()
    expect(send).not.toHaveBeenCalled()
    expect(outputs.get('assigned')).toBe('yes')
    expect(outputs.get('assignment_requested')).toBe('no')
    expect(
      request.mock.calls.some(([route]) => route.endsWith('/assignees')),
    ).toBe(true)
  })

  it('preserves authorized maintainer assignments', async () => {
    const send = spyOn(globalThis, 'fetch')
    config.discordWebhookUrl = 'https://discord.com/api/webhooks/123/test-token'
    payload.comment.user.login = 'maintainer'
    payload.comment.body = '/assign @contributor'
    await new CommentHandler().handle_issue_comment()
    expect(send).not.toHaveBeenCalled()
    expect(outputs.get('assigned')).toBe('yes')
    expect(outputs.get('assignment_requested')).toBe('no')
  })

  it('rejects unauthorized maintainer assignments', async () => {
    payload.comment.body = '/assign @other'
    await new CommentHandler().handle_issue_comment()
    expect(outputs.get('assigned')).toBe('no')
    expectNoWrites()
  })
})

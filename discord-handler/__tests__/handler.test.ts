import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createButtonId } from '../../services/discord/button-protocol'
import {
  handleInteraction,
  resolveAssignment,
  type HandlerConfig,
  type Interaction,
  type Resolution,
} from '../handler'
import { AssignmentApprovals } from '../worker'

const keys = generateKeyPairSync('ed25519')
const config: HandlerConfig = {
  DISCORD_PUBLIC_KEY: keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex'),
  DISCORD_APPLICATION_ID: '111',
  DISCORD_GUILD_ID: '222',
  DISCORD_CHANNEL_ID: '333',
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_BUTTON_SECRET: 'secret'.repeat(8),
  DISCORD_APPROVER_USER_IDS: '444',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_TOKEN: 'github-token',
}
const request = {
  repository: 'owner/repo',
  issueNumber: 42,
  issueTitle: 'Issue title',
  commentId: 123,
  commentBody: '/assign-me',
  requester: 'contributor',
  commentUrl: 'https://github.com/owner/repo/issues/42#issuecomment-123',
}
function interaction(action: 'assign' | 'dismiss' = 'assign'): Interaction {
  return {
    type: 3,
    application_id: '111',
    guild_id: '222',
    channel_id: '333',
    token: 'interaction-token',
    data: {
      custom_id: createButtonId(action, request, config.DISCORD_BUTTON_SECRET),
    },
    member: { user: { id: '444' }, roles: [] },
    message: { id: '555' },
  }
}
function signedRequest(
  body: unknown,
  timestamp = String(Math.floor(Date.now() / 1000)),
): Request {
  const text = JSON.stringify(body)
  const signature = sign(
    null,
    Buffer.from(timestamp + text),
    keys.privateKey,
  ).toString('hex')
  return new Request('https://worker.example/interactions', {
    method: 'POST',
    body: text,
    headers: {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
  })
}

afterEach(() => {
  mock.restore()
})

describe('Discord interaction verification', () => {
  it('responds to a signed Discord ping', async () => {
    const enqueue = mock(() => {})
    const response = await handleInteraction(
      signedRequest({ type: 1 }),
      config,
      enqueue,
    )
    expect(await response.json()).toEqual({ type: 1 })
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('rejects unsigned, invalid, and expired signatures', async () => {
    const enqueue = mock(() => {})
    for (const req of [
      new Request('https://worker.example/interactions', {
        method: 'POST',
        body: '{}',
      }),
      signedRequest(interaction(), '1'),
      signedRequest(interaction()),
    ]) {
      if (
        req.headers.get('x-signature-timestamp') !== '1' &&
        req.headers.has('x-signature-ed25519')
      )
        req.headers.set('x-signature-ed25519', '0'.repeat(128))
      expect((await handleInteraction(req, config, enqueue)).status).toBe(401)
    }
    expect(enqueue).not.toHaveBeenCalled()
  })
  it('defers authorized clicks before external calls', async () => {
    const enqueue = mock(() => {})
    const response = await handleInteraction(
      signedRequest(interaction()),
      config,
      enqueue,
    )
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
  it('allows configured role members', async () => {
    const body = interaction()
    body.member = { user: { id: 'other' }, roles: ['777'] }
    const response = await handleInteraction(
      signedRequest(body),
      { ...config, DISCORD_APPROVER_ROLE_IDS: '777' },
      () => {},
    )
    expect(((await response.json()) as { type: number }).type).toBe(5)
  })
  for (const field of ['application_id', 'guild_id', 'channel_id'] as const) {
    it(`rejects an unexpected ${field}`, async () => {
      const body = interaction()
      body[field] = 'other'
      const enqueue = mock(() => {})
      const response = await handleInteraction(
        signedRequest(body),
        config,
        enqueue,
      )
      expect(((await response.json()) as { type: number }).type).toBe(4)
      expect(enqueue).not.toHaveBeenCalled()
    })
  }
  it('rejects unauthorized users and missing approver configuration', async () => {
    const body = interaction()
    body.member = { user: { id: 'other' }, roles: [] }
    const enqueue = mock(() => {})
    await handleInteraction(signedRequest(body), config, enqueue)
    await handleInteraction(
      signedRequest(interaction()),
      { ...config, DISCORD_APPROVER_USER_IDS: '' },
      enqueue,
    )
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('Assignment resolution', () => {
  let records: Map<string, Resolution>
  let githubIssue: {
    state: string
    title: string
    labels: Array<{ name: string }>
    assignees: Array<{ login: string }>
  }
  let commentBody: string
  let writes: number
  let patches: Array<Record<string, unknown>>
  let failure: number
  let comments: Array<{ body: string }>
  let commentFailure: boolean
  const storage = {
    get: async (key: string): Promise<Resolution | undefined> =>
      records.get(key),
    put: async (key: string, value: Resolution): Promise<void> => {
      records.set(key, value)
    },
  }
  beforeEach(() => {
    records = new Map()
    commentBody = request.commentBody
    writes = 0
    patches = []
    failure = 0
    comments = []
    commentFailure = false
    githubIssue = {
      state: 'open',
      title: 'Issue title',
      labels: [],
      assignees: [],
    }
    spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input)
      if (failure) return new Response('{}', { status: failure })
      if (url.includes('/issues/42/comments')) {
        if (options?.method === 'POST') {
          comments.push(JSON.parse(String(options.body)))
          if (commentFailure) throw new TypeError('Simulated lost response')
          return Response.json(comments[comments.length - 1])
        }
        return Response.json(comments)
      }
      if (url.includes('/issues/comments/'))
        return Response.json({
          id: 123,
          body: commentBody,
          html_url: request.commentUrl,
          issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
          user: { login: 'contributor', type: 'User' },
        })
      if (url.endsWith('/assignees')) {
        writes++
        githubIssue.assignees = [{ login: 'contributor' }]
        return Response.json(githubIssue)
      }
      if (url.includes('api.github.com')) return Response.json(githubIssue)
      if (options?.method === 'PATCH') {
        patches.push(JSON.parse(String(options.body)))
        return Response.json({})
      }
      return Response.json({
        embeds: [{ fields: [{ name: 'Status', value: 'Awaiting approval' }] }],
        components: [
          { components: [interaction().data, interaction('dismiss').data] },
        ],
      })
    })
  })
  it('assigns the commenter, persists the decision, and removes buttons', async () => {
    expect(await resolveAssignment(config, interaction(), storage)).toBe(
      'Assigned to @contributor',
    )
    expect(writes).toBe(1)
    expect(comments[0].body).toContain(
      '@contributor, your assignment request was approved.',
    )
    expect(records.get('123')?.status).toBe('assigned')
    expect(patches[0].components).toEqual([])
  })
  it('dismisses without assigning and cannot later be approved', async () => {
    await resolveAssignment(config, interaction('dismiss'), storage)
    expect(records.get('123')?.status).toBe('dismissed')
    expect(await resolveAssignment(config, interaction(), storage)).toContain(
      'dismissed',
    )
    expect(writes).toBe(0)
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain(
      '@contributor, your assignment request was denied.',
    )
  })
  it('does not assign twice on repeat approval', async () => {
    await resolveAssignment(config, interaction(), storage)
    await resolveAssignment(config, interaction(), storage)
    expect(writes).toBe(1)
    expect(comments).toHaveLength(1)
  })
  it('recovers a lost comment response without posting twice or assigning again', async () => {
    commentFailure = true
    await expect(
      resolveAssignment(config, interaction(), storage),
    ).rejects.toThrow('failed')
    expect(records.get('123')?.status).toBe('assigned')
    expect(records.get('123')?.notified).not.toBe(true)
    commentFailure = false
    await resolveAssignment(config, interaction(), storage)
    expect(comments).toHaveLength(1)
    expect(writes).toBe(1)
    expect(records.get('123')?.notified).toBe(true)
  })
  it('rejects changed comments and forged buttons', async () => {
    commentBody = 'I no longer want to work on this'
    await expect(
      resolveAssignment(config, interaction(), storage),
    ).rejects.toThrow('request changed')
    commentBody = request.commentBody
    const body = interaction()
    body.data!.custom_id = body.data!.custom_id!.replace(/.$/, 'x')
    await expect(resolveAssignment(config, body, storage)).rejects.toThrow(
      'request changed',
    )
    expect(writes).toBe(0)
  })
  it('rechecks closed issues, existing assignees, and required labels', async () => {
    githubIssue.state = 'closed'
    await expect(
      resolveAssignment(config, interaction(), storage),
    ).rejects.toThrow('no longer open')
    githubIssue.state = 'open'
    githubIssue.assignees = [{ login: 'someone-else' }]
    await expect(
      resolveAssignment(config, interaction(), storage),
    ).rejects.toThrow('already assigned')
    githubIssue.assignees = []
    await expect(
      resolveAssignment(
        { ...config, GITHUB_REQUIRED_LABEL: 'ready' },
        interaction(),
        storage,
      ),
    ).rejects.toThrow('required approval label')
    expect(writes).toBe(0)
  })
  it('keeps requests pending when GitHub or Discord fails', async () => {
    failure = 403
    await expect(
      resolveAssignment(config, interaction(), storage),
    ).rejects.toThrow('HTTP 403')
    expect(records.size).toBe(0)
    expect(writes).toBe(0)
  })
  it('serializes simultaneous clicks through the Durable Object', async () => {
    let previous: Promise<unknown> = Promise.resolve()
    const state = {
      storage: {
        ...storage,
        list: async () => new Map(),
        setAlarm: async () => {},
        delete: async () => {},
        deleteAlarm: async () => {},
      },
      blockConcurrencyWhile: (
        callback: () => Promise<unknown>,
      ): Promise<unknown> => {
        const next = previous.then(callback)
        previous = next
        return next
      },
    }
    const object = new AssignmentApprovals(
      state as unknown as DurableObjectState,
      config as never,
    )
    await Promise.all([
      object.fetch(
        new Request('https://internal/resolve', {
          method: 'POST',
          body: JSON.stringify(interaction()),
        }),
      ),
      object.fetch(
        new Request('https://internal/resolve', {
          method: 'POST',
          body: JSON.stringify(interaction()),
        }),
      ),
    ])
    expect(writes).toBe(1)
  })
})

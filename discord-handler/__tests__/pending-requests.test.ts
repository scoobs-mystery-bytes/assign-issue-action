import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { createButtonId } from '../../services/discord/button-protocol'
import { requestSignature } from '../../services/discord/request-protocol'
import type { DiscordAssignmentRequest } from '../../services/discord/assignment-notification'
import type { HandlerConfig } from '../handler'
import worker, { AssignmentApprovals } from '../worker'

const config: HandlerConfig = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_TOKEN: 'github-token',
  DISCORD_APPLICATION_ID: '111',
  DISCORD_GUILD_ID: '222',
  DISCORD_CHANNEL_ID: '333',
  DISCORD_PUBLIC_KEY: '',
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_BUTTON_SECRET: 'secret'.repeat(8),
}
function request(id: number, requester: string): DiscordAssignmentRequest {
  return {
    repository: 'owner/repo',
    issueNumber: 42,
    issueTitle: 'Example',
    commentId: id,
    requester,
    commentBody: '/assign-me',
    commentUrl: `https://github.com/owner/repo/issues/42#issuecomment-${id}`,
  }
}
let object: AssignmentApprovals
let values: Map<string, unknown>
let comments: Array<{ body: string }>
let inputs: Map<number, DiscordAssignmentRequest>
let messages: Map<string, Record<string, any>>
let assignments: number
let assignees: Array<{ login: string }>
let failPatch: string | undefined
let alarm: number | undefined
let state: DurableObjectState
let lostReceipt: boolean

async function register(input: DiscordAssignmentRequest) {
  inputs.set(input.commentId, input)
  return object.fetch(
    new Request('https://internal/requests', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}
async function click(
  input: DiscordAssignmentRequest,
  action: 'assign' | 'dismiss' = 'assign',
) {
  const entry = values.get(`pending:${input.commentId}`) as {
    messageId: string
  }
  return object.fetch(
    new Request('https://internal/resolve', {
      method: 'POST',
      body: JSON.stringify({
        type: 3,
        application_id: '111',
        guild_id: '222',
        channel_id: '333',
        token: 'interaction-token',
        member: { user: { id: '444' }, roles: [] },
        message: { id: entry.messageId },
        data: {
          custom_id: createButtonId(
            action,
            input,
            config.DISCORD_BUTTON_SECRET,
          ),
        },
      }),
    }),
  )
}

afterEach(() => mock.restore())
beforeEach(() => {
  values = new Map()
  comments = []
  inputs = new Map()
  messages = new Map()
  assignments = 0
  assignees = []
  failPatch = undefined
  alarm = undefined
  lostReceipt = false
  state = {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value))
      },
      list: async ({ prefix }: { prefix: string }) =>
        new Map(
          [...values]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key, structuredClone(value)]),
        ),
      delete: async (key: string) => values.delete(key),
      setAlarm: async (time: number) => {
        alarm = time
      },
      deleteAlarm: async () => {
        alarm = undefined
      },
    },
  } as unknown as DurableObjectState
  object = new AssignmentApprovals(state, config as never)
  spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.hostname === 'api.github.com') {
      const id = /issues\/comments\/(\d+)/.exec(url.pathname)?.[1]
      if (id) {
        const source = inputs.get(Number(id))
        if (!source) return new Response('{}', { status: 404 })
        return Response.json({
          id: Number(id),
          body: source.commentBody,
          user: { login: source.requester, type: 'User' },
          html_url: source.commentUrl,
          issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
        })
      }
      if (url.pathname.endsWith('/comments')) {
        if (init?.method === 'POST') {
          comments.push(body)
          if (lostReceipt) {
            lostReceipt = false
            throw new TypeError('Simulated lost response')
          }
        }
        return Response.json(init?.method === 'POST' ? body : comments)
      }
      if (url.pathname.endsWith('/assignees')) {
        assignments++
        assignees = body.assignees.map((login: string) => ({ login }))
      }
      return Response.json({
        state: 'open',
        title: 'Example',
        assignees,
        labels: [],
      })
    }
    if (url.pathname.includes('/webhooks/')) return Response.json({})
    if (init?.method === 'POST') {
      const id = String(1000 + messages.size)
      messages.set(id, body)
      return Response.json({ id })
    }
    const id = url.pathname.split('/').pop()!
    if (!messages.has(id)) return new Response('{}', { status: 404 })
    if (init?.method === 'PATCH') {
      if (id === failPatch) return new Response('{}', { status: 503 })
      messages.set(id, { ...messages.get(id), ...body })
    }
    return Response.json(messages.get(id))
  })
})

describe('Pending requests per issue', () => {
  it('serializes simultaneous repeat requests into one message and one receipt', async () => {
    const first = request(10, 'alice')
    const repeat = request(11, 'alice')
    const results = await Promise.all([register(first), register(repeat)])
    expect(await results[0].json()).toEqual({
      commentId: 10,
      receiptPosted: true,
    })
    expect(await results[1].json()).toEqual({
      commentId: 10,
      receiptPosted: true,
    })
    expect(messages.size).toBe(1)
    expect(comments).toHaveLength(1)
  })
  it('replaces a stale pending request when its original comment was deleted', async () => {
    await register(request(10, 'alice'))
    inputs.delete(10)
    const result = await register(request(11, 'alice'))
    expect((await result.json()).commentId).toBe(11)
    expect(values.get('pending:10')).toMatchObject({ complete: true })
    expect(messages.get('1000')?.components).toEqual([])
    expect(messages.size).toBe(2)
  })

  it('approves one person and closes all competing requests with a different explanation', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    await click(bob)
    expect(assignments).toBe(1)
    expect(assignees).toEqual([{ login: 'bob' }])
    expect(values.get('10')).toMatchObject({
      status: 'unavailable',
      requester: 'alice',
      selectedRequester: 'bob',
    })
    expect(values.get('11')).toMatchObject({
      status: 'assigned',
      requester: 'bob',
    })
    expect(
      comments.some((item) =>
        item.body.includes(
          '@alice, this issue has been assigned to another contributor.',
        ),
      ),
    ).toBe(true)
    expect(
      comments.some((item) =>
        item.body.includes('@bob, your assignment request was approved.'),
      ),
    ).toBe(true)
    for (const message of messages.values())
      expect(message.components).toEqual([])
    await click(alice)
    expect(assignments).toBe(1)
    expect(comments).toHaveLength(4)
  })
  it('dismisses just that request and lets the person request reconsideration with a new comment', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    await click(alice, 'dismiss')
    expect(values.get('11')).toBeUndefined()
    const retry = await register(request(12, 'alice'))
    expect((await retry.json()).commentId).toBe(12)
    expect(messages.size).toBe(3)
    expect(assignments).toBe(0)
  })
  it('retains failed cleanup and retries it after a restart without duplicate comments or assignment', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    failPatch = (values.get('pending:11') as { messageId: string }).messageId
    await click(alice)
    expect(alarm).toBeDefined()
    expect(values.get('selection')).toBeDefined()
    expect(values.get('11')).toMatchObject({
      status: 'unavailable',
      notified: true,
    })
    failPatch = undefined
    object = new AssignmentApprovals(state, config as never)
    await object.alarm()
    expect(alarm).toBeUndefined()
    expect(values.get('selection')).toBeUndefined()
    expect(assignments).toBe(1)
    expect(comments).toHaveLength(4)
    for (const message of messages.values())
      expect(message.components).toEqual([])
  })
  it('finishes GitHub notifications even if a competing Discord message was deleted', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    messages.delete(
      (values.get('pending:11') as { messageId: string }).messageId,
    )
    await click(alice)
    expect(
      comments.some((item) =>
        item.body.includes(
          '@bob, this issue has been assigned to another contributor.',
        ),
      ),
    ).toBe(true)
    expect(alarm).toBeUndefined()
  })
  it('recovers an uncertain receipt write without another Discord message or receipt', async () => {
    const alice = request(10, 'alice')
    lostReceipt = true
    expect((await register(alice)).status).toBe(502)
    expect((await register(alice)).status).toBe(200)
    expect(messages.size).toBe(1)
    expect(comments).toHaveLength(1)
  })
  it('does not let an old approval close a new round of requests', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    await click(alice)
    assignees = []
    await register(request(12, 'charlie'))
    await click(alice)
    expect(values.get('12')).toBeUndefined()
    const fresh = values.get('pending:12') as {
      complete?: boolean
      messageId: string
    }
    expect(fresh.complete).not.toBe(true)
    expect(messages.get(fresh.messageId)?.components.length).toBeGreaterThan(0)
    expect(assignments).toBe(1)
  })

  it('serializes competing clicks and never assigns two people', async () => {
    const alice = request(10, 'alice')
    const bob = request(11, 'bob')
    await register(alice)
    await register(bob)
    await Promise.all([click(alice), click(bob)])
    expect(assignments).toBe(1)
    expect(assignees).toEqual([{ login: 'alice' }])
  })
})

describe('Signed request ingress', () => {
  it('rejects missing, forged, expired signatures and a different repository before storage access', async () => {
    const fetch = mock(async () => Response.json({ commentId: 10 }))
    const env = {
      ...config,
      APPROVALS: { idFromName: () => 'object', get: () => ({ fetch }) },
    }
    const payload = request(10, 'alice')
    for (const variant of [
      'unsigned',
      'forged',
      'expired',
      'wrong-repository',
    ]) {
      const body = JSON.stringify(
        variant === 'wrong-repository'
          ? { ...payload, repository: 'other/repo' }
          : payload,
      )
      const timestamp =
        variant === 'expired' ? '1' : String(Math.floor(Date.now() / 1000))
      const signature =
        variant === 'forged'
          ? '0'.repeat(64)
          : requestSignature(body, timestamp, config.DISCORD_BUTTON_SECRET)
      const response = await worker.fetch!(
        new Request('https://worker.example/requests', {
          method: 'POST',
          body,
          headers:
            variant === 'unsigned'
              ? {}
              : {
                  'X-Assignment-Timestamp': timestamp,
                  'X-Assignment-Signature': signature,
                },
        }),
        env as never,
        {} as ExecutionContext,
      )
      expect(response.status).toBe(variant === 'wrong-repository' ? 400 : 401)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('routes a valid signed request to the same per-issue Durable Object as approval clicks', async () => {
    const fetch = mock(async () => Response.json({ commentId: 10 }))
    const idFromName = mock(() => 'object')
    const body = JSON.stringify(request(10, 'alice'))
    const timestamp = String(Math.floor(Date.now() / 1000))
    const response = await worker.fetch!(
      new Request('https://worker.example/requests', {
        method: 'POST',
        body,
        headers: {
          'X-Assignment-Timestamp': timestamp,
          'X-Assignment-Signature': requestSignature(
            body,
            timestamp,
            config.DISCORD_BUTTON_SECRET,
          ),
        },
      }),
      { ...config, APPROVALS: { idFromName, get: () => ({ fetch }) } } as never,
      {} as ExecutionContext,
    )
    expect(response.status).toBe(200)
    expect(idFromName).toHaveBeenCalledWith('owner/repo:42')
  })
})

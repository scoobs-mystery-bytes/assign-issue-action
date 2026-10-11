import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as core from '@actions/core'
import {
  sendDiscordAssignmentRequest,
  type DiscordAssignmentRequest,
} from '../assignment-notification'

const webhook = 'https://discord.com/api/webhooks/123/test-token'
const request: DiscordAssignmentRequest = {
  repository: 'owner/repo',
  issueNumber: 42,
  issueTitle: 'Fix invoice totals',
  requester: 'contributor',
  commentUrl: 'https://github.com/owner/repo/issues/42#issuecomment-123',
  commentBody: 'Can I take this issue? @everyone',
  commentId: 123,
}

afterEach(() => {
  mockRestore()
})
function mockRestore(): void {
  fetchSpy?.mockRestore()
  secretSpy?.mockRestore()
}
let fetchSpy: ReturnType<typeof spyOn>
let secretSpy: ReturnType<typeof spyOn>

function setup(): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  secretSpy = spyOn(core, 'setSecret').mockImplementation(() => {})
}

describe('Discord assignment notification', () => {
  it('posts a pending request with context and mentions disabled', async () => {
    setup()
    await sendDiscordAssignmentRequest(webhook, request)
    expect(secretSpy).toHaveBeenCalledWith(webhook)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${webhook}?wait=true`)
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(options.redirect).toBe('error')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(options.body)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.content).toBe(
      'Assignment requested — awaiting maintainer approval.',
    )
    expect(body.embeds[0].title).toBe('#42: Fix invoice totals')
    expect(body.embeds[0].description).toBe(request.commentBody)
    expect(body.embeds[0].url).toBe(request.commentUrl)
    expect(body.embeds[0].footer.text).toBe('Comment ID: 123')
  })

  it('retains a thread target and enables delivery confirmation', async () => {
    setup()
    await sendDiscordAssignmentRequest(
      `${webhook}?thread_id=456&wait=false`,
      request,
    )
    const url = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(url.searchParams.get('thread_id')).toBe('456')
    expect(url.searchParams.get('wait')).toBe('true')
  })

  it('truncates long issue titles and comments within embed limits', async () => {
    setup()
    await sendDiscordAssignmentRequest(webhook, {
      ...request,
      issueTitle: 'x'.repeat(1000),
      commentBody: 'x'.repeat(10000),
    })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.embeds[0].title.length).toBe(256)
    expect(body.embeds[0].description.length).toBe(3500)
  })

  for (const invalid of [
    'invalid',
    'http://discord.com/api/webhooks/123/token',
    'https://example.com/api/webhooks/123/token',
    'https://discord.com/api/webhooks/123',
    'https://discord.com@evil.example/api/webhooks/123/token',
  ]) {
    it('rejects an invalid webhook without making a request', async () => {
      setup()
      await expect(
        sendDiscordAssignmentRequest(invalid, request),
      ).rejects.toThrow('Invalid discord_webhook_url')
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  }

  for (const status of [400, 429, 500]) {
    it(`reports HTTP ${status} without echoing Discord's response or the secret`, async () => {
      setup()
      fetchSpy.mockResolvedValue(new Response(webhook, { status }))
      await expect(
        sendDiscordAssignmentRequest(webhook, request),
      ).rejects.toThrow(
        `Discord assignment notification failed (HTTP ${status})`,
      )
    })
  }

  it('sanitizes network errors that may contain the webhook secret', async () => {
    setup()
    fetchSpy.mockRejectedValue(new Error(`Unable to fetch ${webhook}`))
    await expect(
      sendDiscordAssignmentRequest(webhook, request),
    ).rejects.toThrow(
      'Discord assignment notification failed: network error or timeout',
    )
  })
})

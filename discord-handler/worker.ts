import {
  registerRequest,
  completeOtherRequests,
  type TrackedRequest,
  type Selection,
} from './pending-requests'
import { verifyRequestSignature } from '../services/discord/request-protocol'
import type { DiscordAssignmentRequest } from '../services/discord/assignment-notification'
import { parseButtonId } from '../services/discord/button-protocol'
import {
  finishInteraction,
  handleInteraction,
  resolveAssignment,
  type HandlerConfig,
  type Interaction,
  type ResolutionStorage,
} from './handler'

export interface Env extends HandlerConfig {
  APPROVALS: DurableObjectNamespace
}

export class AssignmentApprovals {
  private running: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.running.then(work)
    this.running = next.catch(() => {})
    return next
  }

  private storage(): ResolutionStorage {
    return {
      get: (key) => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      listRequests: async () =>
        Array.from(
          (
            await this.ctx.storage.list<TrackedRequest>({ prefix: 'pending:' })
          ).values(),
        ),
      putRequest: (entry) =>
        this.ctx.storage.put(`pending:${entry.request.commentId}`, entry),
      clearSelection: async () => {
        await this.ctx.storage.delete('selection')
        await this.ctx.storage.deleteAlarm()
      },
      markSelection: async (selection) => {
        await this.ctx.storage.put('selection', selection)
        await this.ctx.storage.setAlarm(Date.now() + 60000)
      },
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/requests') {
      const payload = (await request.json()) as DiscordAssignmentRequest
      return this.serialize(async () => {
        try {
          return Response.json(
            await registerRequest(this.env, payload, this.storage()),
          )
        } catch (error) {
          console.error(
            'Assignment request registration failed',
            error instanceof Error ? error.message : 'Unknown error',
          )
          return new Response('Request registration failed', { status: 502 })
        }
      })
    }
    const interaction = (await request.json()) as Interaction
    const result = await this.serialize(async () => {
      try {
        return await resolveAssignment(this.env, interaction, this.storage())
      } catch (error) {
        console.error('Assignment resolution failed')
        return error instanceof Error
          ? error.message
          : 'Approval failed. Try again.'
      }
    })
    await finishInteraction(this.env, interaction, result)
    return new Response('OK')
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const selection = await this.ctx.storage.get<Selection>('selection')
      if (!selection) return
      try {
        await completeOtherRequests(this.env, selection, this.storage())
        await this.storage().clearSelection!()
      } catch {
        console.error('Retrying pending assignment notifications')
        await this.ctx.storage.setAlarm(Date.now() + 60000)
      }
    })
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === '/requests') {
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
        !verifyRequestSignature(
          body,
          request.headers.get('X-Assignment-Timestamp') ?? '',
          request.headers.get('X-Assignment-Signature') ?? '',
          env.DISCORD_BUTTON_SECRET,
        )
      )
        return new Response('Invalid signature', { status: 401 })
      let payload: DiscordAssignmentRequest
      try {
        payload = JSON.parse(body) as DiscordAssignmentRequest
      } catch {
        return new Response('Invalid JSON', { status: 400 })
      }
      if (
        !payload ||
        payload.repository !== env.GITHUB_REPOSITORY ||
        !Number.isSafeInteger(payload.issueNumber) ||
        payload.issueNumber < 1
      )
        return new Response('Invalid repository or issue', { status: 400 })
      const id = env.APPROVALS.idFromName(
        `${env.GITHUB_REPOSITORY}:${payload.issueNumber}`,
      )
      return env.APPROVALS.get(id).fetch(
        new Request('https://internal/requests', { method: 'POST', body }),
      )
    }
    return handleInteraction(request, env, (interaction) => {
      const button = parseButtonId(interaction.data?.custom_id ?? '')
      const id = env.APPROVALS.idFromName(
        `${env.GITHUB_REPOSITORY}:${button?.issueNumber}`,
      )
      const task = env.APPROVALS.get(id)
        .fetch(
          new Request('https://internal/resolve', {
            method: 'POST',
            body: JSON.stringify(interaction),
          }),
        )
        .then((response) => {
          if (!response.ok)
            console.error('Approval handler failed to process interaction')
        })
        .catch(() =>
          console.error('Approval handler failed to process interaction'),
        )
      ctx.waitUntil(task)
    })
  },
}

export default worker

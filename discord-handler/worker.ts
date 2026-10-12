import { parseButtonId } from '../services/discord/button-protocol'
import {
  finishInteraction,
  handleInteraction,
  resolveAssignment,
  type HandlerConfig,
  type Interaction,
} from './handler'

export interface Env extends HandlerConfig {
  APPROVALS: DurableObjectNamespace
}

export class AssignmentApprovals {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const interaction = (await request.json()) as Interaction
    let result: string
    result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return await resolveAssignment(this.env, interaction, {
          get: (key) => this.ctx.storage.get(key),
          put: (key, value) => this.ctx.storage.put(key, value),
        })
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Approval failed. Try again.'
      }
    })
    await finishInteraction(this.env, interaction, result)
    return new Response('OK')
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
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

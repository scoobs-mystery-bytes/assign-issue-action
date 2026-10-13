import mustache from 'mustache'
import type { OctokitClient } from '../../core'
import type { RepoContext } from './issue-service'

const API_VERSION = '2022-11-28'

export class CommentService {
  constructor(
    private readonly octokit: OctokitClient,
    private readonly repoContext: RepoContext,
  ) {}

  /**
   * Create a comment on an issue with optional mustache templating
   */
  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: this.repoContext.owner,
        repo: this.repoContext.repo,
        issue_number: issueNumber,
        body,
        headers: {
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
    )
  }

  async createCommentOnce(
    issueNumber: number,
    body: string,
    marker: string,
  ): Promise<void> {
    for (let page = 1; ; page++) {
      const { data } = await this.octokit.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          ...this.repoContext,
          issue_number: issueNumber,
          per_page: 100,
          page,
          headers: { 'X-GitHub-Api-Version': API_VERSION },
        },
      )
      if (
        data.some(
          (comment) =>
            comment.user?.type === 'Bot' && comment.body?.includes(marker),
        )
      )
        return
      if (data.length < 100) break
    }
    await this.createComment(issueNumber, `${body}\n\n${marker}`)
  }

  /**
   * Create a comment using a mustache template
   */
  async createTemplatedComment<T extends Record<string, unknown>>(
    issueNumber: number,
    template: string,
    data: T,
  ): Promise<void> {
    const body = mustache.render(template, data)
    await this.createComment(issueNumber, body)
  }

  /**
   * Render a mustache template without posting (useful for checking content)
   */
  renderTemplate<T extends Record<string, unknown>>(
    template: string,
    data: T,
  ): string {
    return mustache.render(template, data)
  }
}

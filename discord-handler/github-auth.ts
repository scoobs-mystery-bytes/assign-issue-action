import { createPrivateKey, sign } from 'node:crypto'

export interface GitHubAuthConfig {
  GITHUB_REPOSITORY: string
  GITHUB_TOKEN?: string
  GITHUB_APP_ID?: string
  GITHUB_APP_INSTALLATION_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
}

export function hasGitHubAuth(config: GitHubAuthConfig): boolean {
  const app = [
    config.GITHUB_APP_ID,
    config.GITHUB_APP_INSTALLATION_ID,
    config.GITHUB_APP_PRIVATE_KEY,
  ]
  if (app.some(Boolean)) {
    return (
      app.every(Boolean) &&
      /^\d+$/.test(config.GITHUB_APP_ID!) &&
      /^\d+$/.test(config.GITHUB_APP_INSTALLATION_ID!)
    )
  }
  return !!config.GITHUB_TOKEN
}

export async function getGitHubToken(
  config: GitHubAuthConfig,
): Promise<string> {
  if (!hasGitHubAuth(config))
    throw new Error('GitHub authentication is not fully configured.')
  if (!config.GITHUB_APP_ID) return config.GITHUB_TOKEN!
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: config.GITHUB_APP_ID })}`
  let signature: string
  try {
    const key = createPrivateKey(config.GITHUB_APP_PRIVATE_KEY!)
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Not an RSA key')
    signature = sign('RSA-SHA256', Buffer.from(payload), key).toString(
      'base64url',
    )
  } catch {
    throw new Error(
      'GitHub App private key is invalid. Upload the complete PEM file.',
    )
  }
  let response: Response
  try {
    response = await fetch(
      `https://api.github.com/app/installations/${config.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${payload}.${signature}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'assign-issue-action',
        },
        body: JSON.stringify({
          repositories: [config.GITHUB_REPOSITORY.split('/')[1]],
          permissions: { issues: 'write' },
        }),
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      },
    )
  } catch {
    throw new Error(
      'Could not reach GitHub to authenticate the App. Try again.',
    )
  }
  if (!response.ok)
    throw new Error(
      `GitHub App authentication received HTTP ${response.status}. Check the App installation and Issues permission.`,
    )
  const data = (await response.json()) as { token?: string }
  if (!data.token)
    throw new Error('GitHub did not return an App installation token.')
  return data.token
}

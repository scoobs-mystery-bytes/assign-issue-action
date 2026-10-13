import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { getGitHubToken, hasGitHubAuth } from '../github-auth'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_APP_ID: '123',
  GITHUB_APP_INSTALLATION_ID: '456',
  GITHUB_APP_PRIVATE_KEY: keys.privateKey
    .export({ type: 'pkcs1', format: 'pem' })
    .toString(),
  GITHUB_TOKEN: 'personal-token',
}
afterEach(() => mock.restore())

describe('GitHub App authentication', () => {
  it('preserves personal-token authentication when App settings are absent', async () => {
    const fetch = spyOn(globalThis, 'fetch')
    expect(
      await getGitHubToken({
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_TOKEN: 'personal-token',
      }),
    ).toBe('personal-token')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('signs a valid JWT and restricts the installation token to the issue repository', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ token: 'installation-token' }),
    )
    expect(await getGitHubToken(config)).toBe('installation-token')
    const [url, options] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/app/installations/456/access_tokens',
    )
    const auth = (
      options!.headers as Record<string, string>
    ).Authorization.slice(7)
    const [header, payload, signature] = auth.split('.')
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims.iss).toBe('123')
    expect(claims.exp - claims.iat).toBe(600)
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000)
    expect(JSON.parse(String(options!.body))).toEqual({
      repositories: ['repo'],
      permissions: { issues: 'write' },
    })
    expect(options!.redirect).toBe('manual')
  })
  it('does not fall back to a personal identity with incomplete App settings', async () => {
    expect(hasGitHubAuth({ ...config, GITHUB_APP_PRIVATE_KEY: '' })).toBe(false)
    await expect(
      getGitHubToken({ ...config, GITHUB_APP_PRIVATE_KEY: '' }),
    ).rejects.toThrow('not fully configured')
  })
  it('sanitizes invalid key and HTTP errors', async () => {
    await expect(
      getGitHubToken({ ...config, GITHUB_APP_PRIVATE_KEY: 'private-value' }),
    ).rejects.toThrow('private key is invalid')
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('secret response', { status: 403 }),
    )
    await expect(getGitHubToken(config)).rejects.toThrow('HTTP 403')
  })
})

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(
  url: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const service =
    new URL(url).hostname === 'api.github.com' ? 'GitHub' : 'Discord'
  const operation = url.includes('/webhooks/')
    ? 'interaction response'
    : url.includes('/messages/')
      ? 'message'
      : url.includes('/assignees')
        ? 'assignment'
        : url.includes('/issues/comments/')
          ? 'comment'
          : 'issue'
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    })
  } catch (error) {
    const errorType =
      error instanceof Error &&
      /^(Error|TypeError|AbortError|TimeoutError)$/.test(error.name)
        ? error.name
        : 'NetworkError'
    let detail = error instanceof Error ? error.message : 'Unknown fetch error'
    detail = detail.split(url).join('[API URL]')
    for (const value of Object.values(headers)) {
      if (value) detail = detail.split(value).join('[header]')
      const credential = value.replace(/^(Bot|Bearer) /, '')
      if (credential) detail = detail.split(credential).join('[credential]')
    }
    detail = detail.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)
    console.error('Approval API network failure', {
      service,
      operation,
      method,
      errorType,
      detail,
    })
    throw new Error(`${service} ${operation} failed (${errorType}). Try again.`)
  }
  if (!response.ok) {
    console.error('Approval API HTTP failure', {
      service,
      operation,
      method,
      status: response.status,
    })
    throw new ApiError(
      `${service} ${operation} received HTTP ${response.status}. Try again or contact a maintainer.`,
      response.status,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

import { createHmac, timingSafeEqual } from 'node:crypto'

export function requestSignature(
  body: string,
  timestamp: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`assignment-request:v1:${timestamp}:${body}`)
    .digest('hex')
}

export function verifyRequestSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  if (
    secret.length < 32 ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(requestSignature(body, timestamp, secret), 'hex'),
  )
}

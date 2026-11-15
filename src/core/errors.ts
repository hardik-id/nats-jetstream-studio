import { errors as natsErrors } from '@nats-io/nats-core'
import { JetStreamApiError } from '@nats-io/jetstream'
import { GatewayError, type GatewayErrorKind } from '@shared/api'

const NOT_FOUND_CODES = new Set([10014, 10037, 10059])

/** Converts anything thrown by the NATS clients into the structured error the UI understands. */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err

  // The clients often wrap the interesting error as `cause`.
  const chain: unknown[] = []
  let current: unknown = err
  while (current && chain.length < 5) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }

  for (const e of chain) {
    if (e instanceof natsErrors.PermissionViolationError) {
      const verb = e.operation === 'publish' ? 'publish to' : 'subscribe to'
      return new GatewayError({
        kind: 'permission',
        message: `Permission denied: this user may not ${verb} "${e.subject}"`,
        subject: e.subject
      })
    }
  }
  for (const e of chain) {
    if (e instanceof JetStreamApiError) {
      const api = e.apiError()
      return new GatewayError({
        kind: NOT_FOUND_CODES.has(api.err_code) ? 'not_found' : 'jetstream',
        message: `${api.description} (JetStream error ${api.err_code})`,
        natsCode: api.err_code
      })
    }
    if ((e as Error)?.name === 'JetStreamNotEnabled') {
      return new GatewayError({
        kind: 'jetstream',
        message: 'JetStream is not enabled for this account'
      })
    }
    if (e instanceof natsErrors.NoRespondersError) {
      return new GatewayError({
        kind: 'no_responders',
        message: `No responders on "${e.subject}"`,
        subject: e.subject
      })
    }
    if (e instanceof natsErrors.TimeoutError) {
      return new GatewayError({ kind: 'timeout', message: 'The server did not answer in time' })
    }
    if (
      e instanceof natsErrors.ClosedConnectionError ||
      e instanceof natsErrors.DrainingConnectionError
    ) {
      return new GatewayError({ kind: 'not_connected', message: 'The connection is closed' })
    }
    if (
      e instanceof natsErrors.InvalidSubjectError ||
      e instanceof natsErrors.InvalidArgumentError
    ) {
      return new GatewayError({ kind: 'validation', message: (e as Error).message })
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  const kind: GatewayErrorKind =
    err instanceof Error && err.constructor !== Error ? 'nats' : 'internal'
  return new GatewayError({ kind, message: message || 'Unknown error' })
}

export function gatewayError(
  kind: GatewayErrorKind,
  message: string,
  extra: { natsCode?: number; subject?: string } = {}
): GatewayError {
  return new GatewayError({ kind, message, ...extra })
}

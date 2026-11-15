import { useMemo } from 'react'
import { subjectMatches } from '@shared/subject'
import { useSetting } from './hooks'
import { decodeProto, loadProtoFiles, type ProtoFile, type ProtoRegistry } from './protobuf'

/**
 * Payload decoders (PBI-044). A decoder turns bytes into a JSON-like value for the viewer.
 * To add a format (Avro, MessagePack...): build `PayloadDecoder`s for it in `useDecoders`.
 */
export interface PayloadDecoder {
  id: string
  /** Shown as the view name, for example "Protobuf orders.Order". */
  label: string
  matches(subject: string): boolean
  /** Throws when the bytes are not valid for this format. */
  decode(bytes: Uint8Array): unknown
}

export interface ProtoMapping {
  /** NATS subject pattern, wildcards allowed. */
  pattern: string
  /** Fully qualified message type. */
  type: string
}

export interface ProtoSettings {
  files: ProtoFile[]
  mappings: ProtoMapping[]
}

export const EMPTY_PROTO: ProtoSettings = { files: [], mappings: [] }
export const protoSettingKey = (connId: string): string => `conn:${connId}:proto`

export function buildProtoDecoders(settings: ProtoSettings): {
  decoders: PayloadDecoder[]
  registry: ProtoRegistry
} {
  const registry = loadProtoFiles(settings.files)
  const decoders = settings.mappings
    .filter((m) => m.pattern && m.type)
    .map<PayloadDecoder>((m, i) => ({
      id: `proto:${i}`,
      label: `Protobuf ${m.type}`,
      matches: (subject) => subjectMatches(m.pattern, subject),
      decode: (bytes) => decodeProto(registry.root, m.type, bytes)
    }))
  return { decoders, registry }
}

/** The decoders registered for a connection. */
export function useDecoders(connId: string | undefined): PayloadDecoder[] {
  const [settings] = useSetting<ProtoSettings>(protoSettingKey(connId ?? '-'), EMPTY_PROTO)
  return useMemo(() => (connId ? buildProtoDecoders(settings).decoders : []), [connId, settings])
}

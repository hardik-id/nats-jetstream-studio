import * as protobuf from 'protobufjs'
import { toBase64 } from '@shared/encoding'

/**
 * Decodes Protobuf messages from .proto definitions (PBI-044).
 *
 * protobufjs normally builds its decoders with `new Function`, which the app's Content Security
 * Policy forbids. So only its parser and wire reader are used here, and the message is walked
 * through reflection instead.
 */

export interface ProtoFile {
  name: string
  source: string
}

export interface ProtoRegistry {
  root: protobuf.Root
  /** Fully qualified message type names, for the mapping form. */
  types: string[]
  errors: { file: string; message: string }[]
}

export function loadProtoFiles(files: ProtoFile[]): ProtoRegistry {
  const root = new protobuf.Root()
  const errors: ProtoRegistry['errors'] = []
  for (const file of files) {
    try {
      protobuf.parse(file.source, root, { keepCase: true })
    } catch (err) {
      errors.push({ file: file.name, message: (err as Error).message })
    }
  }
  try {
    root.resolveAll()
  } catch (err) {
    errors.push({ file: '(all files)', message: (err as Error).message })
  }
  const types: string[] = []
  const walk = (ns: protobuf.NamespaceBase): void => {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Type) types.push(nested.fullName.replace(/^\./, ''))
      if (nested instanceof protobuf.Namespace) walk(nested)
    }
  }
  walk(root)
  return { root, types: types.sort(), errors }
}

export function decodeProto(
  root: protobuf.Root,
  typeName: string,
  bytes: Uint8Array
): Record<string, unknown> {
  const type = root.lookupType(typeName)
  const reader = protobuf.Reader.create(bytes)
  const value = readMessage(type, reader, reader.len)
  if (reader.pos !== reader.len) throw new Error('Trailing bytes after the message')
  return value
}

const VARINT = new Set(['int32', 'uint32', 'sint32', 'int64', 'uint64', 'sint64', 'bool'])
const FIXED64 = new Set(['fixed64', 'sfixed64', 'double'])
const FIXED32 = new Set(['fixed32', 'sfixed32', 'float'])

function readMessage(
  type: protobuf.Type,
  reader: protobuf.Reader,
  end: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of type.fieldsArray) {
    if (field.map) out[field.name] = {}
    else if (field.repeated) out[field.name] = []
  }
  while (reader.pos < end) {
    const tag = reader.uint32()
    const wire = tag & 7
    const field = type.fieldsById[tag >>> 3]
    if (!field) {
      reader.skipType(wire)
      continue
    }
    if (!field.resolved) field.resolve()

    if (field instanceof protobuf.MapField) {
      const entryEnd = reader.uint32() + reader.pos
      let key: unknown = ''
      let value: unknown = null
      while (reader.pos < entryEnd) {
        const entryTag = reader.uint32()
        if (entryTag >>> 3 === 1) key = readScalar(field.keyType, reader)
        else if (entryTag >>> 3 === 2) value = readValue(field, reader)
        else reader.skipType(entryTag & 7)
      }
      ;(out[field.name] as Record<string, unknown>)[String(key)] = value
    } else if (field.repeated) {
      const list = out[field.name] as unknown[]
      const packable =
        field.resolvedType instanceof protobuf.Enum ||
        VARINT.has(field.type) ||
        FIXED64.has(field.type) ||
        FIXED32.has(field.type)
      if (wire === 2 && packable) {
        const packedEnd = reader.uint32() + reader.pos
        while (reader.pos < packedEnd) list.push(readValue(field, reader))
      } else {
        list.push(readValue(field, reader))
      }
    } else {
      out[field.name] = readValue(field, reader)
    }
  }
  if (reader.pos > end) throw new Error('Message is truncated')
  return out
}

function readValue(field: protobuf.Field, reader: protobuf.Reader): unknown {
  const resolved = field.resolvedType
  if (resolved instanceof protobuf.Type) {
    const end = reader.uint32() + reader.pos
    if (end > reader.len) throw new Error('Message is truncated')
    return readMessage(resolved, reader, end)
  }
  if (resolved instanceof protobuf.Enum) {
    const n = reader.int32()
    return resolved.valuesById[n] ?? n
  }
  return readScalar(field.type, reader)
}

function readScalar(type: string, reader: protobuf.Reader): unknown {
  switch (type) {
    case 'double':
      return reader.double()
    case 'float':
      return reader.float()
    case 'int32':
      return reader.int32()
    case 'uint32':
      return reader.uint32()
    case 'sint32':
      return reader.sint32()
    case 'fixed32':
      return reader.fixed32()
    case 'sfixed32':
      return reader.sfixed32()
    case 'bool':
      return reader.bool()
    case 'string':
      return reader.string()
    case 'bytes':
      return toBase64(reader.bytes())
    case 'int64':
      return big(BigInt.asIntN(64, varint64(reader)))
    case 'uint64':
      return big(varint64(reader))
    case 'sint64': {
      const v = varint64(reader)
      return big((v >> 1n) ^ -(v & 1n))
    }
    case 'fixed64':
      return big(fixed64(reader))
    case 'sfixed64':
      return big(BigInt.asIntN(64, fixed64(reader)))
    default:
      throw new Error(`Unsupported field type "${type}"`)
  }
}

/** 64-bit values stay exact: a number when it is safe, otherwise a string. */
function big(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString()
}

function varint64(reader: protobuf.Reader): bigint {
  let result = 0n
  let shift = 0n
  for (let i = 0; i < 10; i++) {
    if (reader.pos >= reader.len) throw new Error('Message is truncated')
    const byte = reader.buf[reader.pos++]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return BigInt.asUintN(64, result)
    shift += 7n
  }
  throw new Error('Invalid varint')
}

function fixed64(reader: protobuf.Reader): bigint {
  if (reader.pos + 8 > reader.len) throw new Error('Message is truncated')
  let result = 0n
  for (let i = 7; i >= 0; i--) result = (result << 8n) | BigInt(reader.buf[reader.pos + i])
  reader.pos += 8
  return result
}

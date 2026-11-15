import * as protobuf from 'protobufjs'
import { describe, expect, it } from 'vitest'
import { buildProtoDecoders } from '@renderer/lib/decoders'
import { decodeProto, loadProtoFiles } from '@renderer/lib/protobuf'
import { fuzzyFilter, fuzzyScore } from '@renderer/lib/fuzzy'

const ORDER_PROTO = `
syntax = "proto3";
package shop;

enum Status { UNKNOWN = 0; PAID = 1; SHIPPED = 2; }

message Item {
  string sku = 1;
  uint32 qty = 2;
  double price = 3;
}

message Order {
  string id = 1;
  int64 total_cents = 2;
  Status status = 3;
  repeated Item items = 4;
  repeated int32 scores = 5;
  map<string, string> labels = 6;
  bytes raw = 7;
  bool gift = 8;
  sint64 delta = 9;
  fixed64 big = 10;
  oneof contact { string email = 11; string phone = 12; }
  Customer customer = 13;
  repeated Status history = 14;
}
`
const CUSTOMER_PROTO = `
syntax = "proto3";
package shop;
message Customer { string name = 1; uint64 id = 2; float score = 3; }
`

describe('PBI-044 protobuf decoding', () => {
  const sample = {
    id: 'A-1',
    total_cents: 123456,
    status: 2,
    items: [
      { sku: 'x', qty: 2, price: 9.5 },
      { sku: 'y', qty: 1, price: 0.25 }
    ],
    scores: [1, -2, 300],
    labels: { region: 'eu', tier: 'gold' },
    raw: new Uint8Array([1, 2, 255]),
    gift: true,
    delta: -42,
    big: '18446744073709551615',
    email: 'jo@example.com',
    customer: { name: 'Jo', id: '9007199254740993', score: 1.5 },
    history: [1, 2]
  }

  // Encode with the library's own (eval-based) encoder, which is fine in a Node test.
  const reference = new protobuf.Root()
  protobuf.parse(ORDER_PROTO, reference, { keepCase: true })
  protobuf.parse(CUSTOMER_PROTO, reference, { keepCase: true })
  const Order = reference.lookupType('shop.Order')
  const bytes = Order.encode(Order.fromObject(sample)).finish()

  it('decodes every field kind without generating code', () => {
    const registry = loadProtoFiles([
      { name: 'order.proto', source: ORDER_PROTO },
      { name: 'customer.proto', source: CUSTOMER_PROTO }
    ])
    expect(registry.errors).toEqual([])
    expect(registry.types).toEqual(['shop.Customer', 'shop.Item', 'shop.Order'])

    // The app's Content Security Policy forbids `new Function`, so the decoder must never need it.
    const codegen = protobuf.util.codegen
    ;(protobuf.util as { codegen: unknown }).codegen = () => {
      throw new Error('codegen must not be used')
    }
    try {
      expect(decodeProto(registry.root, 'shop.Order', bytes)).toEqual({
        id: 'A-1',
        total_cents: 123456,
        status: 'SHIPPED',
        items: [
          { sku: 'x', qty: 2, price: 9.5 },
          { sku: 'y', qty: 1, price: 0.25 }
        ],
        scores: [1, -2, 300],
        labels: { region: 'eu', tier: 'gold' },
        raw: 'AQL/',
        gift: true,
        delta: -42,
        big: '18446744073709551615',
        email: 'jo@example.com',
        customer: { name: 'Jo', id: '9007199254740993', score: 1.5 },
        history: ['PAID', 'SHIPPED']
      })
    } finally {
      ;(protobuf.util as { codegen: unknown }).codegen = codegen
    }
  })

  it('skips unknown fields and reports truncated or foreign data', () => {
    const registry = loadProtoFiles([{ name: 'customer.proto', source: CUSTOMER_PROTO }])
    // An Order read as a Customer: field 1 is a string in both, the rest is unknown or mismatched.
    const small = protobuf.Writer.create().uint32(10).string('Jo').uint32(800).uint32(5).finish()
    expect(decodeProto(registry.root, 'shop.Customer', small)).toEqual({ name: 'Jo' })
    expect(() =>
      decodeProto(registry.root, 'shop.Customer', bytes.subarray(0, bytes.length - 3))
    ).toThrow()
    expect(() =>
      decodeProto(registry.root, 'shop.Customer', new TextEncoder().encode('{"json":true}'))
    ).toThrow()
    expect(() => decodeProto(registry.root, 'shop.Missing', small)).toThrow(/no such type/i)
  })

  it('reports a .proto file that does not parse without losing the others', () => {
    const registry = loadProtoFiles([
      { name: 'bad.proto', source: 'message Broken {' },
      { name: 'customer.proto', source: CUSTOMER_PROTO }
    ])
    expect(registry.errors).toHaveLength(1)
    expect(registry.errors[0].file).toBe('bad.proto')
    expect(registry.types).toEqual(['shop.Customer'])
  })

  it('maps subjects to message types', () => {
    const { decoders } = buildProtoDecoders({
      files: [
        { name: 'order.proto', source: ORDER_PROTO },
        { name: 'customer.proto', source: CUSTOMER_PROTO }
      ],
      mappings: [
        { pattern: 'orders.*.created', type: 'shop.Order' },
        { pattern: '', type: 'shop.Order' }
      ]
    })
    expect(decoders).toHaveLength(1)
    expect(decoders[0].label).toBe('Protobuf shop.Order')
    expect(decoders[0].matches('orders.eu.created')).toBe(true)
    expect(decoders[0].matches('orders.eu.shipped')).toBe(false)
    expect((decoders[0].decode(bytes) as { id: string }).id).toBe('A-1')
  })
})

describe('PBI-090 fuzzy search', () => {
  it('prefers exact and word-start matches', () => {
    const items = ['ORDERS', 'ORDERS_ARCHIVE', 'reorder-queue', 'EVENTS', 'orders.created.eu']
    expect(fuzzyFilter(items, 'orders', (s) => s)[0]).toBe('ORDERS')
    expect(fuzzyFilter(items, 'ordcre', (s) => s)).toEqual(['orders.created.eu'])
    expect(fuzzyFilter(items, 'evt', (s) => s)).toEqual(['EVENTS'])
    expect(fuzzyFilter(items, 'zzz', (s) => s)).toEqual([])
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items)
    expect(fuzzyScore('abc', 'xaxbxc')).not.toBeNull()
    expect(fuzzyScore('abc', 'acb')).toBeNull()
    // A short query must not match letters scattered across an unrelated name.
    expect(fuzzyScore('ord', 'worker JOBS Local dev')).toBeNull()
    expect(fuzzyScore('ord', 'Connect Production (viewer)')).toBeNull()
    expect(fuzzyScore('ordcre', 'orders.created.eu')).not.toBeNull()
  })

  it('searches 20,000 names well within 100 ms', () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `stream-${i}.orders.region${i % 7}`)
    const started = performance.now()
    const hits = fuzzyFilter(names, 'str19999ord', (s) => s)
    expect(performance.now() - started).toBeLessThan(100)
    expect(hits[0]).toBe('stream-19999.orders.region0')
  })
})

describe('chart axes', () => {
  it('uses round ticks from zero', async () => {
    const { niceTicks, byteTicks, byteTick, compactNumber } =
      await import('@renderer/components/LineChart')
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(19.8)).toEqual([0, 10, 20])
    expect(niceTicks(12_300)).toEqual([0, 5000, 10_000, 15_000])
    expect(niceTicks(7)).toEqual([0, 2.5, 5, 7.5])
    // Byte axes step in binary sizes, so labels are 1 MiB, 2 MiB... not 1.91 MiB.
    expect(byteTicks(3.34 * 1024 * 1024).map(byteTick)).toEqual(['0', '2 MiB', '4 MiB'])
    expect(byteTicks(700 * 1024).map(byteTick)).toEqual(['0', '250 KiB', '500 KiB', '750 KiB'])
    expect(byteTicks(0)).toEqual([0, 1024])
    expect(compactNumber(12_316)).toBe('12.3K')
    expect(compactNumber(950)).toBe('950')
  })
})

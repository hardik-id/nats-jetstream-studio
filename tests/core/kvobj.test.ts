import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { KvWatchEvent, ObjDownloadEvent } from '@shared/api'
import { fromBase64, textToBase64, toBase64, utf8Decode } from '@shared/encoding'
import { collect, createHarness, gatewayErr, uniqueName, type Harness } from '../helpers/studio'

let h: Harness
let id: string
beforeAll(async () => {
  h = await createHarness()
  id = await h.connect({ name: 'kvobj' })
})
afterAll(async () => {
  await h.dispose()
})

describe('PBI-070 key-value buckets', () => {
  it('creates, lists and deletes buckets with their settings', async () => {
    const bucket = uniqueName('kv')
    const created = await h.service.createKvBucket(id, {
      bucket,
      description: 'test bucket',
      history: 5,
      ttlMs: 60_000,
      storage: 'memory',
      maxBytes: 1024 * 1024
    })
    expect(created).toMatchObject({
      bucket,
      description: 'test bucket',
      history: 5,
      ttl: 60_000,
      storage: 'memory',
      replicas: 1,
      values: 0,
      streamName: `KV_${bucket}`
    })

    await h.service.kvPut(id, bucket, 'a', textToBase64('1'))
    await h.service.kvPut(id, bucket, 'b', textToBase64('22'))
    const listed = (await h.service.listKvBuckets(id)).find((b) => b.bucket === bucket)!
    expect(listed).toMatchObject({ values: 2, history: 5, storage: 'memory' })
    expect(listed.size).toBeGreaterThan(0)

    expect((await gatewayErr(h.service.createKvBucket(id, { bucket: 'bad name!' }))).kind).toBe(
      'validation'
    )
    await h.service.deleteKvBucket(id, bucket)
    expect((await h.service.listKvBuckets(id)).some((b) => b.bucket === bucket)).toBe(false)
  })

  it('browses keys, with a wildcard filter', async () => {
    const bucket = uniqueName('kv')
    await h.service.createKvBucket(id, { bucket })
    for (const key of ['app.db.host', 'app.db.port', 'app.cache.ttl', 'other.flag'])
      await h.service.kvPut(id, bucket, key, textToBase64(key))
    expect(await h.service.kvKeys(id, bucket)).toEqual([
      'app.cache.ttl',
      'app.db.host',
      'app.db.port',
      'other.flag'
    ])
    expect(await h.service.kvKeys(id, bucket, 'app.db.*')).toEqual(['app.db.host', 'app.db.port'])
    expect(await h.service.kvKeys(id, bucket, 'app.>')).toHaveLength(3)
    expect(await h.service.kvKeys(id, bucket, 'nothing.>')).toEqual([])
    await h.service.deleteKvBucket(id, bucket)
  })

  it('reads a value with its revision and shows the history of a key', async () => {
    const bucket = uniqueName('kv')
    await h.service.createKvBucket(id, { bucket, history: 10 })
    const r1 = await h.service.kvPut(id, bucket, 'config', textToBase64('{"v":1}'))
    const r2 = await h.service.kvPut(id, bucket, 'config', textToBase64('{"v":2}'))
    const r3 = await h.service.kvPut(id, bucket, 'config', textToBase64('{"v":3}'))
    expect([r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3])

    const entry = (await h.service.kvGet(id, bucket, 'config'))!
    expect(entry).toMatchObject({
      bucket,
      key: 'config',
      revision: 3,
      operation: 'PUT',
      size: 7,
      truncated: false
    })
    expect(utf8Decode(fromBase64(entry.value!))).toBe('{"v":3}')
    expect(Math.abs(new Date(entry.created).getTime() - Date.now())).toBeLessThan(60_000)

    const old = (await h.service.kvGet(id, bucket, 'config', 1))!
    expect(utf8Decode(fromBase64(old.value!))).toBe('{"v":1}')

    const history = await h.service.kvHistory(id, bucket, 'config')
    expect(history.map((e) => [e.revision, e.operation])).toEqual([
      [3, 'PUT'],
      [2, 'PUT'],
      [1, 'PUT']
    ])
    expect(await h.service.kvGet(id, bucket, 'missing')).toBeNull()
    await h.service.deleteKvBucket(id, bucket)
  })

  it('deletes and purges keys', async () => {
    const bucket = uniqueName('kv')
    await h.service.createKvBucket(id, { bucket, history: 10 })
    await h.service.kvPut(id, bucket, 'k', textToBase64('one'))
    await h.service.kvPut(id, bucket, 'k', textToBase64('two'))
    await h.service.kvDelete(id, bucket, 'k')
    expect(await h.service.kvKeys(id, bucket)).toEqual([])
    // Delete keeps history, with a delete marker on top.
    expect((await h.service.kvHistory(id, bucket, 'k')).map((e) => e.operation)).toEqual([
      'DEL',
      'PUT',
      'PUT'
    ])
    expect((await h.service.kvGet(id, bucket, 'k'))?.operation).toBe('DEL')

    await h.service.kvPut(id, bucket, 'k', textToBase64('three'))
    await h.service.kvPurge(id, bucket, 'k')
    // Purge removes the history and leaves only its marker.
    expect((await h.service.kvHistory(id, bucket, 'k')).map((e) => e.operation)).toEqual(['PURGE'])
    await h.service.deleteKvBucket(id, bucket)
  })

  it('stores binary values unchanged', async () => {
    const bucket = uniqueName('kv')
    await h.service.createKvBucket(id, { bucket })
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    await h.service.kvPut(id, bucket, 'bin', toBase64(bytes))
    expect(Array.from(fromBase64((await h.service.kvGet(id, bucket, 'bin'))!.value!))).toEqual(
      Array.from(bytes)
    )
    await h.service.deleteKvBucket(id, bucket)
  })

  it('watches a bucket for live changes', async () => {
    const bucket = uniqueName('kv')
    await h.service.createKvBucket(id, { bucket })
    await h.service.kvPut(id, bucket, 'before', textToBase64('old'))
    const watch = collect(h.service, 'kvWatch', { connId: id, bucket }, (e) => e.length >= 3)
    await new Promise((r) => setTimeout(r, 200))
    await h.service.kvPut(id, bucket, 'x', textToBase64('1'))
    await h.service.kvPut(id, bucket, 'y', textToBase64('22'))
    await h.service.kvDelete(id, bucket, 'x')
    const { events, close } = await watch
    close()
    const entries = (events as Extract<KvWatchEvent, { type: 'entry' }>[]).map((e) => [
      e.entry.key,
      e.entry.operation,
      e.entry.size
    ])
    // Only changes made after the watch started are reported.
    expect(entries).toEqual([
      ['x', 'PUT', 1],
      ['y', 'PUT', 2],
      ['x', 'DEL', 0]
    ])
    await h.service.deleteKvBucket(id, bucket)
  })

  it('lists 100,000 keys', async () => {
    const bucket = uniqueName('kvbig')
    await h.service.createKvBucket(id, { bucket, storage: 'memory' })
    const { nc, jsm } = await h.client()
    const TOTAL = 100_000
    // Write straight to the bucket's subjects; going through put() one by one would take minutes.
    for (let i = 0; i < TOTAL; i++) {
      nc.publish(`$KV.${bucket}.key.${String(i).padStart(6, '0')}`, 'v')
      if (i % 5000 === 0) await nc.flush()
    }
    await nc.flush()
    while ((await jsm.streams.info(`KV_${bucket}`)).state.messages < TOTAL)
      await new Promise((r) => setTimeout(r, 50))

    const started = Date.now()
    const keys = await h.service.kvKeys(id, bucket)
    expect(keys).toHaveLength(TOTAL)
    expect(keys[0]).toBe('key.000000')
    expect(keys[TOTAL - 1]).toBe('key.099999')
    expect(Date.now() - started).toBeLessThan(20_000)
    expect((await h.service.listKvBuckets(id)).find((b) => b.bucket === bucket)!.values).toBe(TOTAL)
    await h.service.deleteKvBucket(id, bucket)
  }, 120_000)
})

describe('PBI-071 object store buckets', () => {
  async function upload(
    bucket: string,
    name: string,
    data: Uint8Array,
    description?: string,
    chunk = 200_000
  ): Promise<void> {
    const { uploadId } = await h.service.objUploadStart(id, bucket, name, description)
    for (let offset = 0; offset < data.length; offset += chunk) {
      await h.service.objUploadChunk(uploadId, toBase64(data.subarray(offset, offset + chunk)))
    }
    await h.service.objUploadFinish(uploadId)
  }

  it('creates and lists buckets with size and object count', async () => {
    const bucket = uniqueName('obj')
    const created = await h.service.createObjBucket(id, {
      bucket,
      description: 'files',
      storage: 'memory'
    })
    expect(created).toMatchObject({
      bucket,
      description: 'files',
      storage: 'memory',
      replicas: 1,
      sealed: false,
      objects: 0
    })
    await upload(bucket, 'a.txt', new TextEncoder().encode('hello'))
    await upload(bucket, 'b.txt', new TextEncoder().encode('world!!'))
    const listed = (await h.service.listObjBuckets(id)).find((b) => b.bucket === bucket)!
    expect(listed.objects).toBe(2)
    expect(listed.size).toBeGreaterThan(12)
    await h.service.deleteObjBucket(id, bucket)
    expect((await h.service.listObjBuckets(id)).some((b) => b.bucket === bucket)).toBe(false)
  })

  it('uploads in chunks, lists metadata and downloads the same bytes', async () => {
    const bucket = uniqueName('obj')
    await h.service.createObjBucket(id, { bucket })
    const data = randomBytes(1_500_000)
    await upload(bucket, 'reports/big.bin', data, 'a big file')

    const objects = await h.service.objList(id, bucket)
    expect(objects).toHaveLength(1)
    const info = objects[0]
    expect(info).toMatchObject({
      bucket,
      name: 'reports/big.bin',
      description: 'a big file',
      size: 1_500_000
    })
    expect(info.chunks).toBeGreaterThan(1)
    // The server does not store a revision in the object meta, so a listing carries none
    // (never the string 'undefined' in the UI).
    expect(info.revision).toBeUndefined()
    expect(info.digest).toMatch(/^SHA-256=/)
    expect(Math.abs(new Date(info.mtime).getTime() - Date.now())).toBeLessThan(60_000)

    const { events, close } = await collect(
      h.service,
      'objDownload',
      { connId: id, bucket, name: 'reports/big.bin' },
      (e) => e.some((x) => x.type === 'done' || x.type === 'error'),
      30_000
    )
    close()
    const done = events.at(-1) as Extract<ObjDownloadEvent, { type: 'done' }>
    expect(done).toEqual({ type: 'done', bytes: 1_500_000 })
    const chunks = events.filter((e) => e.type === 'chunk') as Extract<
      ObjDownloadEvent,
      { type: 'chunk' }
    >[]
    expect(chunks.length).toBeGreaterThan(1)
    const downloaded = Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64')))
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(
      createHash('sha256').update(data).digest('hex')
    )
    await h.service.deleteObjBucket(id, bucket)
  }, 60_000)

  it('previews small objects and refuses large ones', async () => {
    const bucket = uniqueName('obj')
    await h.service.createObjBucket(id, { bucket })
    await upload(bucket, 'note.json', new TextEncoder().encode('{"ok":true}'))
    await upload(bucket, 'large.bin', new Uint8Array(5000))
    const preview = await h.service.objPreview(id, bucket, 'note.json', 1024)
    expect(utf8Decode(fromBase64(preview.data))).toBe('{"ok":true}')
    expect(preview.size).toBe(11)
    expect((await gatewayErr(h.service.objPreview(id, bucket, 'large.bin', 1024))).message).toMatch(
      /too large to preview/
    )
    expect((await gatewayErr(h.service.objPreview(id, bucket, 'nope', 1024))).kind).toBe(
      'not_found'
    )
    await h.service.deleteObjBucket(id, bucket)
  })

  it('replaces and deletes objects', async () => {
    const bucket = uniqueName('obj')
    await h.service.createObjBucket(id, { bucket })
    await upload(bucket, 'f', new TextEncoder().encode('v1'))
    await upload(bucket, 'f', new TextEncoder().encode('version two'))
    expect(await h.service.objList(id, bucket)).toHaveLength(1)
    expect(utf8Decode(fromBase64((await h.service.objPreview(id, bucket, 'f', 1024)).data))).toBe(
      'version two'
    )
    await h.service.objDelete(id, bucket, 'f')
    expect(await h.service.objList(id, bucket)).toEqual([])
    await h.service.deleteObjBucket(id, bucket)
  })

  it('cancels an upload without leaving an object behind', async () => {
    const bucket = uniqueName('obj')
    await h.service.createObjBucket(id, { bucket })
    const { uploadId } = await h.service.objUploadStart(id, bucket, 'partial.bin')
    await h.service.objUploadChunk(uploadId, toBase64(new Uint8Array(1000)))
    await h.service.objUploadAbort(uploadId)
    expect((await gatewayErr(h.service.objUploadChunk(uploadId, ''))).kind).toBe('not_found')
    await new Promise((r) => setTimeout(r, 200))
    expect(await h.service.objList(id, bucket)).toEqual([])
    await h.service.deleteObjBucket(id, bucket)
  })

  it('reports a download of a missing object', async () => {
    const bucket = uniqueName('obj')
    await h.service.createObjBucket(id, { bucket })
    const { events, close } = await collect(
      h.service,
      'objDownload',
      { connId: id, bucket, name: 'missing' },
      (e) => e.length >= 1
    )
    close()
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'not_found' } })
    await h.service.deleteObjBucket(id, bucket)
  })
})

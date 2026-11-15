import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ObjBucketTab } from '@renderer/features/objects/ObjBucketTab'
import { createFakeGateway } from '@renderer/gateway/fake'
import type { ObjectInfoDto } from '@shared/api'
import { renderWithGateway } from './render'

const base: ObjectInfoDto = {
  bucket: 'files',
  name: 'a.txt',
  size: 10,
  chunks: 1,
  digest: 'SHA-256=abc',
  mtime: '2026-01-01T00:00:00Z',
  headers: []
}

async function openDetail(info: ObjectInfoDto): Promise<void> {
  const gateway = createFakeGateway({ connections: [{ id: 'dev', name: 'Dev' }] })
  Object.assign(gateway, {
    objList: async () => [info],
    objPreview: async () => ({ data: '', size: 0 })
  })
  renderWithGateway(<ObjBucketTab tabId="t1" connId="dev" bucket="files" />, gateway)
  await userEvent.click(await screen.findByText('a.txt'))
  await screen.findByText('Digest')
}

describe('PBI-120 object detail revision', () => {
  it('hides the Revision row when the gateway gives none', async () => {
    await openDetail(base)
    expect(screen.queryByText('Revision')).toBeNull()
    expect(screen.queryByText('undefined')).toBeNull()
  })

  it('shows the revision when the gateway gives one', async () => {
    await openDetail({ ...base, revision: 7 })
    expect(screen.getByText('Revision')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
  })
})

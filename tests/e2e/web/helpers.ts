import { connect, type NatsConnection } from '@nats-io/transport-node'
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager
} from '@nats-io/jetstream'
import { expect, type Locator, type Page } from '@playwright/test'

export const studioUrl = (): string => process.env.STUDIO_URL!

export function sidebar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Connections' })
}

/** The sidebar section of one connection. */
export function connection(page: Page, name: string): Locator {
  return sidebar(page).getByRole('group', { name, exact: true })
}

/** Opens the studio and makes sure the connection is connected and expanded. */
export async function openStudio(page: Page, name = 'Local dev'): Promise<void> {
  await page.goto(studioUrl())
  const group = connection(page, name)
  await expect(group).toBeVisible()
  const streams = group.getByRole('button', { name: 'Streams', exact: true })
  if (!(await streams.isVisible())) {
    await group
      .getByRole('button', { name: new RegExp(name) })
      .first()
      .click()
    await expect(streams).toBeVisible()
  }
}

/** Opens a section (Streams, Consumers, Publish...) of a connection from the sidebar. */
export async function go(page: Page, section: string, name = 'Local dev'): Promise<void> {
  await connection(page, name).getByRole('button', { name: section, exact: true }).click()
}

export async function openStream(page: Page, stream: string, tab?: string): Promise<void> {
  await go(page, 'Streams')
  await page
    .getByRole('table', { name: 'Streams' })
    .getByRole('button', { name: stream, exact: true })
    .click()
  await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible()
  if (tab) await page.getByRole('tab', { name: tab, exact: true }).click()
}

export interface Nats {
  nc: NatsConnection
  jsm: JetStreamManager
  js: JetStreamClient
}

/** A plain NATS client for arranging data and checking what the UI did on the server. */
export async function nats(user = 'app', pass = 'app'): Promise<Nats> {
  const nc = await connect({ servers: process.env.NATS_E2E_URL!, user, pass })
  return { nc, jsm: await jetstreamManager(nc), js: jetstream(nc) }
}

export function unique(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text }).first()
}

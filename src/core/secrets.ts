import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Encrypts secrets before they are written to disk. */
export interface SecretStore {
  /** True when secrets are protected by something stronger than obfuscation (an OS keychain or a key file). */
  readonly secure: boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/**
 * AES-256-GCM with a key kept in a file readable only by the current user.
 * Used by web/server mode and by tests; the desktop app uses the OS keychain instead.
 */
export class KeyFileSecretStore implements SecretStore {
  readonly secure = true
  private readonly key: Buffer

  constructor(keyFile: string) {
    if (existsSync(keyFile)) {
      this.key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')
      if (this.key.length !== 32) throw new Error(`Secret key file ${keyFile} is not a 32-byte key`)
    } else {
      this.key = randomBytes(32)
      mkdirSync(dirname(keyFile), { recursive: true })
      writeFileSync(keyFile, this.key.toString('base64'), { mode: 0o600 })
      try {
        chmodSync(keyFile, 0o600)
      } catch {
        // Not supported on every platform.
      }
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith('v1:')) throw new Error('Unknown secret format')
    const raw = Buffer.from(cipher.slice(3), 'base64')
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }
}

/** Refuses to store anything. Used when no protection is available; secrets are then asked for on connect. */
export class NoSecretStore implements SecretStore {
  readonly secure = false
  encrypt(): string {
    throw new Error('Secret storage is not available')
  }
  decrypt(): string {
    throw new Error('Secret storage is not available')
  }
}

import { safeStorage } from 'electron'
import type { SecretStore } from '@core/secrets'

/**
 * Encrypts secrets with the operating system keychain (Keychain on macOS, DPAPI on Windows,
 * libsecret or KWallet on Linux) through Electron's safeStorage.
 */
export class SafeStorageSecretStore implements SecretStore {
  get secure(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    // On Linux without a keyring Electron falls back to a fixed password, which is only obfuscation.
    if (process.platform === 'linux')
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    return true
  }

  encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Secret storage is not available on this system')
    return `os:${safeStorage.encryptString(plain).toString('base64')}`
  }

  decrypt(cipher: string): string {
    if (!cipher.startsWith('os:')) throw new Error('Unknown secret format')
    return safeStorage.decryptString(Buffer.from(cipher.slice(3), 'base64'))
  }
}

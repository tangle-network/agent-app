import type { KeyCrypto } from './index'

/** Prove the at-rest crypto seam before a remote key is minted. */
export async function assertWorkspaceKeyCryptoUsable(crypto: KeyCrypto): Promise<void> {
  const probe = 'agent-app:key-manager:crypto-probe'
  let roundTripped: string
  try {
    roundTripped = await crypto.decrypt(await crypto.encrypt(probe))
  } catch (error) {
    throw new Error(
      'Key encryption is misconfigured: the crypto seam threw before minting. ' +
        'Validate FIELD_ENCRYPTION_KEY (64-char hex) at startup. No platform key was minted.',
      { cause: error },
    )
  }
  if (roundTripped !== probe) {
    throw new Error(
      'Key encryption is misconfigured: encrypt/decrypt round-trip did not preserve the plaintext. ' +
        'No platform key was minted.',
    )
  }
}

import * as ed from '@noble/ed25519'
import { base64UrlToBytes, hexToBytes } from './utils';

/**
 * Validates Telegram Mini App init data using Ed25519 signature verification
 *
 * @param initDataRaw - Raw init data string from Telegram.WebApp.initData
 * @param botId - Your Telegram bot ID (numeric string)
 * @param publicKeyHex - Telegram's Ed25519 public key in hex format
 * @returns Promise<boolean> - true if signature is valid
 */
export async function tgValidateInitData(
  initDataRaw: string,
  botId: string,
  publicKeyHex: string
): Promise<boolean> {
  const params = new URLSearchParams(initDataRaw);

  const signatureBase64Url = params.get('signature');
  if (!signatureBase64Url) {
    throw new Error('No signature found in init data');
  }

  // Remove signature and hash from params for validation
  params.delete('signature')
  params.delete('hash')

  // Step 1-4: Build data-check-string
  // Format: botId:WebAppData\nkey1=value1\nkey2=value2...
  const sortedParams = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const dataCheckString = `${botId}:WebAppData\n${sortedParams}`;
  const signatureBytes = base64UrlToBytes(signatureBase64Url);
  const publicKeyBytes = hexToBytes(publicKeyHex);
  const messageBytes = new TextEncoder().encode(dataCheckString);
  return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
}

/**
 * Validates that the auth_date is not too old (optional additional check)
 * @param initDataRaw - Raw init data string
 * @param maxAgeSeconds - Maximum age in seconds (default: 86400 = 24 hours)
 * @returns boolean - true if auth_date is recent enough
 */
export function tgValidateAuthDate(
  initDataRaw: string,
  maxAgeSeconds: number = 86400
): boolean {
  try {
    const params = new URLSearchParams(initDataRaw)
    const authDate = params.get('auth_date')

    if (!authDate) {
      return false
    }

    const authTimestamp = parseInt(authDate, 10)
    const currentTimestamp = Math.floor(Date.now() / 1000)
    const age = currentTimestamp - authTimestamp

    return age >= 0 && age <= maxAgeSeconds
  } catch (error) {
    console.error('Error validating auth_date:', error)
    return false
  }
}

/**
 * Simple file-based storage for PKP information
 * Allows reusing PKPs across test runs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface StoredPKP {
  tokenId: string;
  publicKey: string;
  ethAddress: string;
  createdAt: string;
}

const STORAGE_DIR = path.join(__dirname, '..', '.data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'pkp.json');

/**
 * Ensure storage directory exists
 */
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore error
  }
}

/**
 * Save PKP information to local storage
 */
export async function savePKP(pkp: Omit<StoredPKP, 'createdAt'>): Promise<void> {
  await ensureStorageDir();

  const storedPKP: StoredPKP = {
    ...pkp,
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(STORAGE_FILE, JSON.stringify(storedPKP, null, 2), 'utf-8');
  console.log('✓ PKP info saved to:', STORAGE_FILE);
}

/**
 * Load PKP information from local storage
 * Returns null if no PKP is stored
 */
export async function loadPKP(): Promise<StoredPKP | null> {
  try {
    const data = await fs.readFile(STORAGE_FILE, 'utf-8');
    const pkp = JSON.parse(data) as StoredPKP;
    console.log('✓ Loaded existing PKP:', pkp.ethAddress);
    return pkp;
  } catch (error) {
    // File doesn't exist or can't be read
    return null;
  }
}

/**
 * Clear stored PKP information
 */
export async function clearPKP(): Promise<void> {
  try {
    await fs.unlink(STORAGE_FILE);
    console.log('✓ Cleared PKP storage');
  } catch (error) {
    // File doesn't exist, ignore
  }
}

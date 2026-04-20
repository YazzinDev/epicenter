import { Ok } from 'wellcrafted/result';
import { createFileSystemBlobStore } from './file-system';
import type { BlobStore } from './types';
import { BlobError } from './types';
import { createBlobStoreWeb } from './web';

/**
 * Desktop blob store with dual-source fallback.
 *
 * Recording metadata lives in the workspace (Yjs CRDT). The blob store
 * only manages binary blobs. Reads check file system first, then
 * fall back to IndexedDB for unmigrated data.
 *
 */

export function createBlobStoreDesktop(): BlobStore {
	const fileSystemDb = createFileSystemBlobStore();
	const indexedDb = createBlobStoreWeb();

	return {
		save: async (key, blob) => {
			// SINGLE WRITE: Only to file system
			return fileSystemDb.save(key, blob);
		},

		delete: async (idOrIds) => {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			// Delete from BOTH sources to ensure complete removal
			const [fsResult, idbResult] = await Promise.all([
				fileSystemDb.delete(ids),
				indexedDb.delete(ids),
			]);

			// If both failed, return an error
			if (fsResult.error && idbResult.error) {
				return BlobError.WriteFailed({ cause: fsResult.error });
			}

			// Success if at least one succeeded
			return Ok(undefined);
		},

		getBlob: async (key) => {
			// DUAL READ: Check file system first, fallback to IndexedDB
			const fsResult = await fileSystemDb.getBlob(key);

			// If found in file system, return it
			if (fsResult.data) {
				return Ok(fsResult.data);
			}

			// Not in file system, check IndexedDB
			const idbResult = await indexedDb.getBlob(key);

			// If found in IndexedDB, return it
			if (idbResult.data) {
				return Ok(idbResult.data);
			}

			// If both failed, return an error
			if (fsResult.error && idbResult.error) {
				return BlobError.ReadFailed({ cause: fsResult.error });
			}

			// Not found in either source (but no errors)
			return BlobError.ReadFailed({
				cause: new Error(`Blob not found for key ${key}`),
			});
		},

		ensurePlaybackUrl: async (key) => {
			// DUAL READ: Check file system first, fallback to IndexedDB
			const fsResult =
				await fileSystemDb.ensurePlaybackUrl(key);

			// If found in file system, return it
			if (fsResult.data) {
				return Ok(fsResult.data);
			}

			// Not in file system, check IndexedDB
			const idbResult = await indexedDb.ensurePlaybackUrl(key);

			// If found in IndexedDB, return it
			if (idbResult.data) {
				return Ok(idbResult.data);
			}

			// If both failed, return an error
			if (fsResult.error && idbResult.error) {
				return BlobError.ReadFailed({ cause: fsResult.error });
			}

			// Not found in either source (but no errors)
			return BlobError.ReadFailed({
				cause: new Error(`Blob not found for key ${key}`),
			});
		},

		revokeUrl: (key) => {
			// Revoke from BOTH sources
			fileSystemDb.revokeUrl(key);
			indexedDb.revokeUrl(key);
		},

		clear: async () => {
			// Clear from BOTH sources
			const [fsResult, idbResult] = await Promise.all([
				fileSystemDb.clear(),
				indexedDb.clear(),
			]);

			// Return error only if both failed
			if (fsResult.error && idbResult.error) {
				return BlobError.WriteFailed({ cause: fsResult.error });
			}

			return Ok(undefined);
		},
	};
}

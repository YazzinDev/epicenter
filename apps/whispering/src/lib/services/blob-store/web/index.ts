import { tryAsync } from 'wellcrafted/result';
import { BlobError, type BlobStore } from '../types';
import { WhisperingDatabase } from './dexie-database';
import type { SerializedAudio } from './dexie-schemas';

/**
 * Convert Blob to serialized format for IndexedDB storage.
 * Returns undefined if conversion fails.
 */
async function blobToSerializedAudio(
	blob: Blob,
): Promise<SerializedAudio | undefined> {
	const arrayBuffer = await blob.arrayBuffer().catch((error) => {
		console.error('Error getting array buffer from blob', blob, error);
		return undefined;
	});

	if (!arrayBuffer) return undefined;

	return { arrayBuffer, blobType: blob.type };
}

/**
 * Convert serialized audio back to Blob for use in the application.
 */
function serializedAudioToBlob(serializedAudio: SerializedAudio): Blob {
	return new Blob([serializedAudio.arrayBuffer], {
		type: serializedAudio.blobType,
	});
}

export function createBlobStoreWeb(): BlobStore {
	const db = new WhisperingDatabase();
	/** Cache for blob object URLs to avoid recreating them. */
	const urlCache = new Map<string, string>();

	return {
		async save(key, blob) {
			const serializedAudio = await blobToSerializedAudio(blob);
			return tryAsync({
				try: async () => {
					await db.recordings.put({ id: key, serializedAudio });
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		delete: async (idOrIds) => {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: () => db.recordings.bulkDelete(ids),
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		getBlob: async (key) => {
			return tryAsync({
				try: async () => {
					const recordingWithAudio = await db.recordings.get(key);

					if (!recordingWithAudio) {
						throw new Error(`Blob ${key} not found`);
					}

					if (!recordingWithAudio.serializedAudio) {
						throw new Error(`No blob data found for ${key}`);
					}

					const blob = serializedAudioToBlob(
						recordingWithAudio.serializedAudio,
					);
					return blob;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		ensurePlaybackUrl: async (key) => {
			return tryAsync({
				try: async () => {
					// Check cache first
					const cachedUrl = urlCache.get(key);
					if (cachedUrl) {
						return cachedUrl;
					}

					// Fetch blob from IndexedDB
					const recordingWithAudio = await db.recordings.get(key);

					if (!recordingWithAudio) {
						throw new Error(`Blob ${key} not found`);
					}

					if (!recordingWithAudio.serializedAudio) {
						throw new Error(`No blob data found for ${key}`);
					}

					const blob = serializedAudioToBlob(
						recordingWithAudio.serializedAudio,
					);
					const objectUrl = URL.createObjectURL(blob);
					urlCache.set(key, objectUrl);

					return objectUrl;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl: (key) => {
			const url = urlCache.get(key);
			if (url) {
				URL.revokeObjectURL(url);
				urlCache.delete(key);
			}
		},

		clear: async () => {
			return tryAsync({
				try: () => db.recordings.clear(),
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	};
}

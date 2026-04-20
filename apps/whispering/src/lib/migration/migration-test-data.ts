import { nanoid } from 'nanoid/non-secure';
import { createBlobStoreWeb } from '$lib/services/blob-store/web';

export const MOCK_RECORDING_COUNT = 12;

export function createMigrationTestData() {
	const indexedDb = createBlobStoreWeb();

	return {
		async seedIndexedDB({
			recordingCount,
			onProgress,
		}: {
			recordingCount: number;
			onProgress: (message: string) => void;
		}): Promise<{ recordings: number }> {
			onProgress(`Seeding IndexedDB with ${recordingCount} recordings...`);

			const recordings = Array.from({ length: recordingCount }, (_, index) => {
				const id = nanoid();
				const audio = new Blob([`mock-audio-${index}`], {
					type: 'audio/webm',
				});
				return { id, audio };
			});

			for (const { id, audio } of recordings) {
				const { error } = await indexedDb.audio.save(id, audio);
				if (error) {
					throw new Error(`Failed to seed recording ${id}: ${error.message}`);
				}
			}

			onProgress(`✅ Seed complete: ${recordings.length} recordings`);
			return { recordings: recordings.length };
		},

		async clearIndexedDB({
			onProgress,
		}: {
			onProgress: (message: string) => void;
		}): Promise<void> {
			onProgress('Clearing IndexedDB audio...');
			const result = await indexedDb.audio.clear();
			if (result.error) {
				throw new Error(`Failed to clear audio: ${result.error.message}`);
			}
			onProgress('✅ IndexedDB cleared');
		},
	};
}

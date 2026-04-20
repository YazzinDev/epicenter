import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const BlobError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read from blob store: ${extractErrorMessage(cause)}`,
		cause,
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write to blob store: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BlobError = InferErrors<typeof BlobError>;

export type BlobStore = {
	save(key: string, blob: Blob): Promise<Result<void, BlobError>>;
	delete(key: string | string[]): Promise<Result<void, BlobError>>;
	clear(): Promise<Result<void, BlobError>>;

	/**
	 * Get blob by key. Fetches on-demand.
	 * - Desktop: Reads file from predictable path using services.fs.pathToBlob()
	 * - Web: Fetches from IndexedDB by ID, converts serialized data to Blob
	 */
	getBlob(key: string): Promise<Result<Blob, BlobError>>;

	/**
	 * Get playback URL for blob. Creates and caches URL.
	 * - Desktop: Uses convertFileSrc() to create asset:// URL
	 * - Web: Creates and caches object URL, manages lifecycle
	 */
	ensurePlaybackUrl(key: string): Promise<Result<string, BlobError>>;

	/**
	 * Revoke cached URL if present. Cleanup method.
	 * - Desktop: No-op (asset:// URLs managed by Tauri)
	 * - Web: Calls URL.revokeObjectURL() and removes from cache
	 */
	revokeUrl(key: string): void;
};

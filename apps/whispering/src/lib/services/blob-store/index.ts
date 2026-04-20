import { createBlobStoreDesktop } from './desktop';
import { createBlobStoreWeb } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

export const AudioBlobStoreLive = window.__TAURI_INTERNALS__
	? createBlobStoreDesktop()
	: createBlobStoreWeb();

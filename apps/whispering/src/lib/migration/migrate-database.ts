import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { workspace } from '$lib/client';

const MIGRATION_KEY = 'whispering:db-migration';
export type DbMigrationState = 'pending' | 'done';

type MigrationCounts = {
	total: number;
	migrated: number;
	skipped: number;
	failed: number;
};

export type MigrationResult = {
	recordings: MigrationCounts;
	transformations: MigrationCounts;
	steps: MigrationCounts;
};

export const MigrationError = defineErrors({
	WorkspaceNotReady: ({ cause }: { cause: unknown }) => ({
		message: `Workspace failed to initialize: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MigrationError = InferErrors<typeof MigrationError>;

export function getDatabaseMigrationState(): DbMigrationState | null {
	return window.localStorage.getItem(MIGRATION_KEY) as DbMigrationState | null;
}

export function setDatabaseMigrationState(state: DbMigrationState): void {
	window.localStorage.setItem(MIGRATION_KEY, state);
}

export async function probeForOldData(_dbService: unknown): Promise<boolean> {
	// All data (recordings, transformations, runs) is now workspace-backed.
	// No old BlobStore data remains to migrate.
	return false;
}

export async function migrateDatabaseToWorkspace({
	workspace: ws,
	onProgress,
}: {
	workspace: typeof workspace;
	onProgress: (message: string) => void;
}): Promise<Result<MigrationResult, MigrationError>> {
	const result = {
		recordings: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		transformations: { total: 0, migrated: 0, skipped: 0, failed: 0 },
		steps: { total: 0, migrated: 0, skipped: 0, failed: 0 },
	} satisfies MigrationResult;

	const { error: readyError } = await tryAsync({
		try: () => ws.whenReady,
		catch: (cause) => {
			onProgress(`Workspace not ready: ${extractErrorMessage(cause)}`);
			return MigrationError.WorkspaceNotReady({ cause });
		},
	});

	if (readyError) return Err(readyError);

	onProgress('All data is workspace-backed. No migration needed.');
	return Ok(result);
}

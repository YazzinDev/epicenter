/**
 * Shared utilities for raw Yjs benchmark scripts.
 *
 * These scripts test Yjs primitives directly (not the Workspace API).
 * For Workspace API benchmarks, see src/__benchmarks__/helpers.ts.
 */

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTime(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
	if (ms < 1000) return `${ms.toFixed(1)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

export function measureTime<T>(fn: () => T): { result: T; ms: number } {
	const start = performance.now();
	const result = fn();
	return { result, ms: performance.now() - start };
}

export function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

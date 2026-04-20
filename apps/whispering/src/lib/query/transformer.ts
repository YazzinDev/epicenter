import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import { workspace } from '$lib/client';
import { defineMutation } from '$lib/query/client';
import {
	WhisperingErr,
	type WhisperingError,
	type WhisperingResult,
} from '$lib/result';
import { services } from '$lib/services';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import {
	type TransformationRun,
	transformationRuns,
} from '$lib/state/transformation-runs.svelte';
import {
	type TransformationStep,
	transformationSteps,
} from '$lib/state/transformation-steps.svelte';
import type { Transformation } from '$lib/state/transformations.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';

type TransformationRunRunning = Extract<
	TransformationRun,
	{ status: 'running' }
>;
type TransformationRunCompleted = Extract<
	TransformationRun,
	{ status: 'completed' }
>;
type TransformationRunFailed = Extract<TransformationRun, { status: 'failed' }>;
type TransformationStepRun = ReturnType<
	typeof workspace.tables.transformationStepRuns.getAllValid
>[number];
type TransformationStepRunRunning = Extract<
	TransformationStepRun,
	{ status: 'running' }
>;
type TransformationStepRunCompleted = Extract<
	TransformationStepRun,
	{ status: 'completed' }
>;
type TransformationStepRunFailed = Extract<
	TransformationStepRun,
	{ status: 'failed' }
>;

/**
 * Config map for standard completion providers that share the same
 * `{ apiKey, model, systemPrompt, userPrompt }` call signature.
 * Custom is handled separately because it has per-step baseUrl logic.
 */
const STANDARD_PROVIDER_CONFIG = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyPath: 'apiKeys.openai',
		modelKey: 'openaiModel',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyPath: 'apiKeys.groq',
		modelKey: 'groqModel',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyPath: 'apiKeys.anthropic',
		modelKey: 'anthropicModel',
	},
	Google: {
		service: services.completions.google,
		apiKeyPath: 'apiKeys.google',
		modelKey: 'googleModel',
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyPath: 'apiKeys.openrouter',
		modelKey: 'openrouterModel',
	},
} as const satisfies Record<
	string,
	{
		service: {
			complete: (opts: {
				apiKey: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
			}) => Promise<Result<string, { message: string }>>;
		};
		apiKeyPath: Parameters<typeof deviceConfig.get>[0];
		modelKey: keyof TransformationStep;
	}
>;

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	NoSteps: ({ message }: { message: string }) => ({ message }),
	CreateRunFailed: ({ message }: { message: string }) => ({ message }),
	AddStepFailed: ({ message }: { message: string }) => ({ message }),
	FailStepFailed: ({ message }: { message: string }) => ({ message }),
	CompleteStepFailed: ({ message }: { message: string }) => ({ message }),
	CompleteRunFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

const transformerKeys = {
	transformInput: ['transformer', 'transformInput'] as const,
	transformRecording: ['transformer', 'transformRecording'] as const,
};

export const transformer = {
	transformInput: defineMutation({
		mutationKey: transformerKeys.transformInput,
		mutationFn: async ({
			input,
			transformation,
			steps,
		}: {
			input: string;
			transformation: Transformation;
			steps: TransformationStep[];
		}): Promise<WhisperingResult<string>> => {
			const getTransformationOutput = async (): Promise<
				Result<string, WhisperingError>
			> => {
				const { data: transformationRun, error: transformationRunError } =
					await runTransformation({
						input,
						transformation,
						steps,
						recordingId: null,
					});

				if (transformationRunError)
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						serviceError: transformationRunError,
					});

				if (transformationRun.status === 'failed') {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description: transformationRun.error,
						action: { type: 'more-details', error: transformationRun.error },
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
				}

				return Ok(transformationRun.output);
			};

			const transformationOutputResult = await getTransformationOutput();

			return transformationOutputResult;
		},
	}),

	transformRecording: defineMutation({
		mutationKey: transformerKeys.transformRecording,
		mutationFn: async ({
			recordingId,
			transformation,
		}: {
			recordingId: string;
			transformation: Transformation;
		}): Promise<
			Result<
				TransformationRunCompleted | TransformationRunFailed,
				WhisperingError
			>
		> => {
			const recording = recordings.get(recordingId);
			if (!recording) {
				return WhisperingErr({
					title: '⚠️ Recording not found',
					description: 'Could not find the selected recording.',
				});
			}

			const steps = transformationSteps.getByTransformationId(
				transformation.id,
			);

			const { data: transformationRun, error: transformationRunError } =
				await runTransformation({
					input: recording.transcript,
					transformation,
					steps,
					recordingId,
				});

			if (transformationRunError)
				return WhisperingErr({
					title: '⚠️ Transformation failed',
					serviceError: transformationRunError,
				});

			return Ok(transformationRun);
		},
	}),
};

async function handleStep({
	input,
	step,
}: {
	input: string;
	step: TransformationStep;
}): Promise<Result<string, string>> {
	switch (step.type) {
		case 'find_replace': {
			const { findText, replaceText, useRegex } = step;

			if (useRegex) {
				try {
					const regex = new RegExp(findText, 'g');
					return Ok(input.replace(regex, replaceText));
				} catch (error) {
					return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
				}
			}

			return Ok(input.replaceAll(findText, replaceText));
		}

		case 'prompt_transform': {
			const { inferenceProvider, systemPromptTemplate, userPromptTemplate } =
				step;
			const systemPrompt = interpolateTemplate(
				asTemplateString(systemPromptTemplate),
				{ input },
			);
			const userPrompt = interpolateTemplate(
				asTemplateString(userPromptTemplate),
				{ input },
			);

			// Handle Custom separately—it has per-step baseUrl logic.
			if (inferenceProvider === 'Custom') {
				const model = step.customModel?.trim();
				const stepBaseUrl = step.customBaseUrl?.trim();
				const defaultBaseUrl = deviceConfig
					.get('completion.custom.baseUrl')
					?.trim();
				const baseUrl = stepBaseUrl || defaultBaseUrl || '';

				const { data, error } = await services.completions.custom.complete({
					apiKey: deviceConfig.get('apiKeys.custom'),
					model,
					baseUrl,
					systemPrompt,
					userPrompt,
				});
				if (error) return Err(error.message);
				return Ok(data);
			}

			// Standard providers all share the same call signature.
			const config = STANDARD_PROVIDER_CONFIG[inferenceProvider];
			if (!config) return Err(`Unsupported provider: ${inferenceProvider}`);

			const { data, error } = await config.service.complete({
				apiKey: deviceConfig.get(config.apiKeyPath),
				model: step[config.modelKey] as string,
				systemPrompt,
				userPrompt,
			});
			if (error) return Err(error.message);
			return Ok(data);
		}

		default:
			return Err(`Unsupported step type: ${step.type}`);
	}
}

async function runTransformation({
	input,
	transformation,
	steps,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	steps: TransformationStep[];
	recordingId: string | null;
}): Promise<
	Result<TransformationRunCompleted | TransformationRunFailed, TransformError>
> {
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}

	if (steps.length === 0) {
		return TransformError.NoSteps({
			message:
				'No steps configured. Please add at least one transformation step',
		});
	}

	const now = new Date().toISOString();
	const runId = nanoid();

	const transformationRun = {
		id: runId,
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: now,
		completedAt: null,
		status: 'running',
		_v: 1,
	} satisfies TransformationRunRunning;

	transformationRuns.set(transformationRun);

	let currentInput = input;

	for (const [stepIndex, step] of steps.entries()) {
		const stepRunId = nanoid();
		const stepRun = {
			id: stepRunId,
			transformationRunId: runId,
			stepId: step.id,
			order: stepIndex,
			input: currentInput,
			startedAt: new Date().toISOString(),
			completedAt: null,
			status: 'running',
			_v: 1,
		} satisfies TransformationStepRunRunning;
		workspace.tables.transformationStepRuns.set(stepRun);

		const handleStepResult = await handleStep({
			input: currentInput,
			step,
		});

		if (isErr(handleStepResult)) {
			const failedNow = new Date().toISOString();
			const failedStepRun = {
				...stepRun,
				status: 'failed',
				completedAt: failedNow,
				error: handleStepResult.error,
			} satisfies TransformationStepRunFailed;
			workspace.tables.transformationStepRuns.set(failedStepRun);
			const failedRun = {
				...transformationRun,
				status: 'failed',
				completedAt: failedNow,
				error: handleStepResult.error,
			} satisfies TransformationRunFailed;
			transformationRuns.set(failedRun);
			return Ok(failedRun);
		}

		const handleStepOutput = handleStepResult.data;

		const completedStepRun = {
			...stepRun,
			status: 'completed',
			completedAt: new Date().toISOString(),
			output: handleStepOutput,
		} satisfies TransformationStepRunCompleted;
		workspace.tables.transformationStepRuns.set(completedStepRun);

		currentInput = handleStepOutput;
	}

	const completedRun = {
		...transformationRun,
		status: 'completed',
		completedAt: new Date().toISOString(),
		output: currentInput,
	} satisfies TransformationRunCompleted;
	transformationRuns.set(completedRun);
	return Ok(completedRun);
}

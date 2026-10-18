/**
 * Boundary parsers for runtime frames.
 *
 * Every field arriving from the bridge is dynamic JSON. Validating once here means the rest
 * of the client reads typed values instead of casting at each call site, and a malformed
 * frame degrades to "field missing" rather than a silently wrong read.
 */
import type { BtwRecord, ChatRow, ContentBlock, Frame, Message, SlashCommand, SubagentRow, UIRequest } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	// Unchecked cast (one place, documented): `typeof object` is the only check the runtime
	// JSON boundary needs before member reads, and the result is read field-by-field.
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function asContent(value: unknown): ContentBlock[] | undefined {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.content)) return undefined;
	// Unchecked cast: elements are narrowed by shape at render time.
	return record.content as ContentBlock[];
}

export function asMessage(value: unknown): Message | undefined {
	const record = asRecord(value);
	if (!record || typeof record.role !== "string") return undefined;
	return { ...(record as unknown as Message) };
}

export function asSubagent(value: unknown): SubagentRow | undefined {
	const record = asRecord(value);
	if (!record || typeof record.id !== "string") return undefined;
	return { ...(record as unknown as SubagentRow) };
}

export function asCommands(value: unknown): SlashCommand[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is SlashCommand => typeof asRecord(item)?.name === "string");
}

export function asChatRows(value: unknown): ChatRow[] {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.sessions)) return [];
	return record.sessions.filter((item): item is ChatRow => {
		const row = asRecord(item);
		return typeof row?.path === "string";
	});
}

export function asBtwRecord(value: unknown): BtwRecord | undefined {
	const record = asRecord(value);
	if (!record || typeof record.id !== "string") return undefined;
	return { ...(record as unknown as BtwRecord) };
}

/** `message_update` payload: either a whole partial message or one changed block. */
export interface AssistantEvent {
	type?: string;
	contentIndex: number;
	partial?: Message;
	toolCall?: ContentBlock;
	message?: Message;
}

export function asAssistantEvent(value: unknown): AssistantEvent | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		type: asString(record.type),
		contentIndex: asNumber(record.contentIndex) ?? 0,
		partial: asMessage(record.partial),
		toolCall: asRecord(record.toolCall) ? (record.toolCall as ContentBlock) : undefined,
		message: asMessage(record.message),
	};
}

/** Extension UI requests carry a method plus a method-specific payload. */
export function asUIRequest(frame: Frame): UIRequest | undefined {
	const method = asString(frame.method);
	const id = asString(frame.id);
	if (!method || !id) return undefined;
	const questions = Array.isArray(frame.questions)
		? frame.questions.flatMap((item) => {
				const record = asRecord(item);
				if (!record) return [];
				return [
					{
						id: asString(record.id) ?? "",
						header: asString(record.header),
						question: asString(record.question) ?? "",
						multi: record.multi === true,
						options: Array.isArray(record.options)
							? record.options.flatMap((option) => {
									const row = asRecord(option);
									if (!row) return [];
									const label = asString(row.label);
									return label ? [{ label, description: asString(row.description) }] : [];
								})
							: [],
					},
				];
			})
		: undefined;
	return {
		id,
		method,
		title: asString(frame.title),
		message: asString(frame.message),
		placeholder: asString(frame.placeholder),
		text: asString(frame.text),
		widgetKey: asString(frame.widgetKey),
		url: asString(frame.url),
		launchUrl: asString(frame.launchUrl),
		instructions: asString(frame.instructions),
		targetId: asString(frame.targetId),
		timeout: asNumber(frame.timeout),
		options: asStringArray(frame.options),
		optionDetails: Array.isArray(frame.optionDetails)
			? frame.optionDetails.flatMap((item) => {
					const record = asRecord(item);
					if (!record) return [];
					return [{ label: asString(record.label), description: asString(record.description) }];
				})
			: undefined,
		questions,
	};
}

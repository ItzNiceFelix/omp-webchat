/**
 * Wire types for the runtime's RPC dialect, as seen through the webchat bridge.
 *
 * The bridge adds `wx:*` frames of its own (hello/child/card/log/copy/file) and forwards
 * every runtime frame unchanged, so everything here mirrors `omp --mode rpc-ui` plus the
 * bridge's additions.
 */

export type Frame = Record<string, unknown> & { type?: string; id?: string };

// ---------------------------------------------------------------- session content

export interface ImageContent {
	type: "image";
	mimeType: string;
	data: string;
}

export interface TextBlock {
	type: "text";
	text?: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking?: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	partialArgs?: string;
	/** one-line human summary the runtime derives from the tool call */
	intent?: string;
}

export interface ToolResultBlock {
	type: "toolResult";
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content?: ContentBlock[];
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | ImageContent | { type: string };

export type Role = "user" | "assistant" | "toolResult" | string;

export interface Message {
	role: Role;
	content?: ContentBlock[] | string;
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** assistant messages only */
	model?: string;
	usage?: Usage;
	/** wall-clock turn duration in ms, when the runtime reports it */
	duration?: number;
	/** synthetic rows the client adds itself (notices, cards, btw answers) */
	local?: "notice" | "card" | "btw" | "error";
	/** user row rendered before the runtime echoed the prompt back */
	optimistic?: boolean;
	/** stable identity for client-created rows, so keys survive "load earlier" */
	localId?: string;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

// ---------------------------------------------------------------- runtime projections

export interface SlashCommand {
	name: string;
	description?: string;
	aliases?: string[];
	source?: string;
	subcommands?: { name: string; description?: string }[];
	input?: { hint?: string; placeholder?: string };
}

export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
}

export interface TodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface ContextUsage {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
}

export interface SessionState {
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	isSettled?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	queuedMessageCount?: number;
	contextUsage?: ContextUsage;
	todoPhases?: TodoPhase[];
	tokensPerSecond?: number | null;
	fastModeActive?: boolean;
	slowModeEnabled?: boolean;
	usageLimit?: { stage?: string; resetsAtSec?: number; allowanceLeftPercent?: number };
}

export interface ChatRow {
	path: string;
	id: string;
	name: string;
	firstUser?: string;
	titled?: boolean;
	mtime: number;
	bytes?: number;
	synthetic?: boolean;
	/** present when the list came from `scope=all`: which folder's bucket the row lives in */
	bucket?: string;
	project?: string;
	folder?: string;
}

/** A composer attachment before sending: images go to the model as vision content, every
 *  other file is uploaded and referenced by its `webchat://` URI. */
export interface DraftAttachment {
	id: string;
	name: string;
	size: number;
	mimeType: string;
	/** images only: base64 payload the runtime accepts as prompt image content */
	image?: ImageContent;
	/** non-images only: the raw file, uploaded on send */
	file?: File;
	/** upload progress for non-images */
	uploadedUri?: string;
}

export interface SubagentRow {
	id: string;
	index?: number;
	label?: string;
	status?: string;
	progress?: { phase?: string; text?: string; toolName?: string; tokens?: number; elapsedMs?: number };
	kind?: string;
	task?: string;
}

export interface LiveTurn {
	role: string;
	turn?: number;
	text?: string;
	final?: boolean;
}

export interface BtwRecord {
	id: string;
	question?: string;
	answer?: string;
	status?: string;
	followUps?: { answer?: string; status?: string; final?: boolean }[];
}

export interface HostToolInfo {
	name: string;
	label?: string;
	description?: string;
}

/** One queued extension UI request awaiting an answer. */
export interface UIRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	status?: string;
	level?: string;
	text?: string;
	lines?: string[];
	widgetKey?: string;
	url?: string;
	launchUrl?: string;
	instructions?: string;
	targetId?: string;
	timeout?: number;
	options?: string[];
	optionDetails?: { label?: string; description?: string }[];
	questions?: {
		id: string;
		header?: string;
		question: string;
		multi?: boolean;
		options?: { label: string; description?: string }[];
	}[];
}

export interface ToolEntry {
	id: string;
	name: string;
	intent?: string;
	args?: unknown;
	partialArgs?: string;
	preview?: string;
	status: "running" | "ok" | "error";
	isError?: boolean;
	start: number;
	end?: number;
	output?: string;
}

export interface Toast {
	id: number;
	text: string;
	level: "info" | "warn" | "error";
	url?: string;
}

export interface PresentedFile {
	id: string;
	name: string;
	mimeType: string;
	bytes: number;
	data: string;
}

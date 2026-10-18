import { Check, Copy, FileCode2, Terminal } from "lucide-react";
import { memo, useState } from "react";
import { asNumber, asRecord, asString } from "../frames";
import { contentText, store } from "../store";
import type { ContentBlock, Message } from "../types";
import { useStore } from "../useStore";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCard } from "./ToolCard";

/** One content block. Kept outside the row so each block memoizes on its own props. */
const BlockView = memo(function BlockView({ block, streaming }: { block: ContentBlock; streaming: boolean }) {
	const record = asRecord(block);
	switch (asString(record?.type)) {
		case "text":
			return <Markdown text={asString(record?.text) ?? ""} />;
		case "thinking":
			return <ThinkingBlock text={asString(record?.thinking) ?? ""} streaming={streaming} />;
		case "toolCall":
			return <ToolCall block={record} />;
		case "image": {
			const mime = asString(record?.mimeType) ?? "image/png";
			return <img className="block-image" alt="attachment" src={`data:${mime};base64,${asString(record?.data) ?? ""}`} />;
		}
		default:
			return null;
	}
});

function ToolCall({ block }: { block: Record<string, unknown> | undefined }) {
	const tools = useStore((select) => select.tools);
	const id = asString(block?.id) ?? asString(block?.toolCallId);
	const entry = id ? tools.get(id) : undefined;
	if (entry) return <ToolCard entry={entry} />;
	// Replayed transcripts carry the call without its execution frames.
	return (
		<div className="tool running">
			<div className="tool-head">
				<span className="tool-icon">
					<Terminal size={14} />
				</span>
				<b>{asString(block?.name) ?? "tool"}</b>
				{asString(block?.intent) && <span className="tool-intent">{asString(block?.intent)}</span>}
			</div>
		</div>
	);
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="copy"
			onClick={() => {
				void store.copy(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				});
			}}
		>
			{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : label}
		</button>
	);
}

function UsageLine({ message }: { message: Message }) {
	const parts: string[] = [];
	if (message.usage?.input) parts.push(`in ${message.usage.input}`);
	if (message.usage?.output) parts.push(`out ${message.usage.output}`);
	if (message.usage?.totalTokens) parts.push(`${message.usage.totalTokens} tok`);
	const duration = asNumber(message.duration);
	if (duration) parts.push(`${(duration / 1000).toFixed(1)}s`);
	if (!parts.length) return null;
	return <div className="usage">{parts.join(" · ")}</div>;
}

function blocksOf(message: Message): ContentBlock[] {
	return Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
}

/**
 * Memoized transcript row: a message object is replaced only when that entry changes, so a
 * stream delta re-renders exactly one row and finished rows keep their parsed markdown.
 */
export const MessageRow = memo(function MessageRow({ message, streaming = false }: { message: Message; streaming?: boolean }) {
	const blocks = blocksOf(message);
	if (message.local === "notice" || message.local === "error") {
		return <article className={`message system${message.local === "error" ? " error" : ""}`}>{contentText(message.content)}</article>;
	}
	if (message.local === "card") {
		return (
			<article className="message card">
				<h4>{message.toolName ?? "card"}</h4>
				<div className="blocks">
					{blocks.map((block, index) => (
						<BlockView key={index} block={block} streaming={false} />
					))}
				</div>
			</article>
		);
	}
	if (message.local === "btw") {
		return (
			<article className="message btw">
				<div className="who">btw side question</div>
				<div className="blocks">
					{blocks.map((block, index) => (
						<BlockView key={index} block={block} streaming={false} />
					))}
				</div>
				<div className="dim">{message.toolName}</div>
			</article>
		);
	}
	if (message.role === "user") {
		return (
			<article className={`message user${message.optimistic ? " optimistic" : ""}`}>
				<div className="user-bubble">
					<div className="blocks">
						{blocks.map((block, index) => (
							<BlockView key={index} block={block} streaming={false} />
						))}
					</div>
				</div>
			</article>
		);
	}
	if (message.role === "toolResult") return null;
	if (message.role !== "assistant") {
		// Roles such as `custom` carry runtime notices (device inventory, injected system
		// text). They are real transcript entries, but rendering them as assistant turns
		// would attribute runtime text to the model.
		return <article className="message system">{contentText(message.content)}</article>;
	}
	const markdown = blocks.map((block) => asString(asRecord(block)?.text) ?? "").filter(Boolean).join("\n\n");
	return (
		<article className="message assistant">
			<div className="who">
				omp
				<span className="turn-actions">
					<CopyButton text={contentText(message.content)} />
					<span className="copy-sep">
						<CopyButton text={markdown} label="Copy as markdown" />
					</span>
				</span>
			</div>
			<div className="blocks">
				{blocks.map((block, index) => (
					<BlockView key={index} block={block} streaming={streaming} />
				))}
			</div>
			<UsageLine message={message} />
		</article>
	);
});

export const FileIcon = ({ name }: { name: string }) => (name.endsWith(".ts") || name.endsWith(".tsx") ? <FileCode2 size={15} /> : <Terminal size={15} />);

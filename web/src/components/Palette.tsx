import { useEffect, useRef } from "react";
import type { SlashCommand } from "../types";

/**
 * Slash palette. Fed by `available_commands_update`, so it only ever lists commands this
 * session can actually dispatch — an unknown `/word` falls through as prompt text instead.
 */
export function Palette({ items, index, onPick }: { items: SlashCommand[]; index: number; onPick(command: SlashCommand): void }) {
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		box.current?.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
	}, [index]);

	if (!items.length) return null;
	return (
		<div className="palette" ref={box} role="listbox" aria-label="slash commands">
			{items.map((command, position) => (
				<button
					key={command.name}
					type="button"
					role="option"
					aria-selected={position === index}
					className={`item${position === index ? " sel" : ""}`}
					onMouseDown={(event) => {
						event.preventDefault();
						onPick(command);
					}}
				>
					<span className="n">/{command.name}</span>
					<span className="d">{command.description ?? ""}</span>
					<span className="s">{command.input?.hint ?? command.source ?? ""}</span>
				</button>
			))}
		</div>
	);
}

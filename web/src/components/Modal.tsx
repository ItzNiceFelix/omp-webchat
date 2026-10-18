import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/** Modal shell: title, body, footer, Escape/backdrop close. */
export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className="modal" role="dialog" aria-modal="true" aria-label={title}>
				<header>
					<h2>{title}</h2>
					<button type="button" className="icon sm" aria-label="close" onClick={onClose}>
						<X size={15} />
					</button>
				</header>
				<div className="modal-body">{children}</div>
				{footer && <div className="foot">{footer}</div>}
			</div>
		</div>
	);
}

/** Clickable option list used by every picker. */
export function OptionList<T>({
	items,
	onPick,
	selected,
}: {
	items: { label: string; sub?: string; hint?: string; value: T }[];
	onPick(item: { label: string; sub?: string; hint?: string; value: T }): void;
	selected?: (item: { value: T }) => boolean;
}) {
	if (!items.length) return <div className="dim">no match</div>;
	return (
		<div className="list">
			{items.map((item) => (
				<button key={`${item.label}:${item.hint ?? ""}`} type="button" className={`opt${selected?.(item) ? " sel" : ""}`} onClick={() => onPick(item)}>
					<span>{item.label}</span>
					{item.sub && <span className="sub">{item.sub}</span>}
					{item.hint && <span className="hint">{item.hint}</span>}
				</button>
			))}
		</div>
	);
}

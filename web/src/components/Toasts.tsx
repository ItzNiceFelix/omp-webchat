import { ExternalLink } from "lucide-react";
import { useStore } from "../useStore";

/** Transient notifications. Top-center on narrow screens so they never cover the composer. */
export function Toasts() {
	const toasts = useStore((select) => select.toasts);
	if (!toasts.length) return null;
	return (
		<div className="toasts" role="status" aria-live="polite">
			{toasts.map((toast) => (
				<div className={`toast ${toast.level}`} key={toast.id}>
					<span>{toast.text}</span>
					{toast.url && (
						<a href={toast.url} target="_blank" rel="noopener noreferrer">
							<ExternalLink size={13} /> open
						</a>
					)}
				</div>
			))}
		</div>
	);
}

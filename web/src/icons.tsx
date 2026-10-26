/**
 * The phase indicator glyphs. Pure SVG/CSS and `currentColor`, so the chip, the tool
 * card status and the composer all tint them from one place (`--ph` or the status colour).
 * Motion lives in styles.css under "motion and glyph layer"; none of it runs under reduced motion.
 */
export function Spark() {
	return (
		<svg className="mk-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 1c.6 5.6 5.4 10.4 11 11-5.6.6-10.4 5.4-11 11-.6-5.6-5.4-10.4-11-11C6.6 11.4 11.4 6.6 12 1z" />
		</svg>
	);
}

export function Ring() {
	return <span className="mk-ring" aria-hidden="true" />;
}

export function Wave() {
	return (
		<span className="mk-wave" aria-hidden="true">
			<i />
			<i />
			<i />
		</span>
	);
}

export function Dots() {
	return (
		<span className="mk-dots" aria-hidden="true">
			<i />
			<i />
			<i />
		</span>
	);
}

/** A 1px-bordered square: the `tool` phase. Breathes so it never reads as a static checkbox. */
export function Block() {
	return <span className="mk-block" aria-hidden="true" />;
}

/** A dashed circle: the `compact` phase. Rotates so the dashes travel. */
export function Dash() {
	return <span className="mk-dash" aria-hidden="true" />;
}

/** A 1px square dot: `idle`. Breathes, so even "ready" is visibly alive. */
export function Dot() {
	return <span className="mk-dot" aria-hidden="true" />;
}

/** Stroke-drawn tick: `pathLength=1` lets one dash animation draw it at any size. */
export function CheckDraw() {
	return (
		<svg className="mk-ck" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path pathLength={1} d="M3 8.5l3 3 7-7" />
		</svg>
	);
}

export function CrossDraw() {
	return (
		<svg className="mk-ck" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
			<path pathLength={1} d="M4 4l8 8M12 4l-8 8" />
		</svg>
	);
}

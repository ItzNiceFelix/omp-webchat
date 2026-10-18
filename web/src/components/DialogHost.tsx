import { useEffect, useState } from "react";
import { store } from "../store";
import type { UIRequest } from "../types";
import { useStore } from "../useStore";
import { Modal, OptionList } from "./Modal";

/**
 * Extension UI sub-protocol host.
 *
 * The runtime asks the browser for input through `extension_ui_request` frames: `ask`
 * (multi-question dialogs, the `ask` tool), `select` (including tool approvals), `confirm`,
 * `input` and `editor`. Requests queue up; one is presented at a time and answered with
 * `extension_ui_response`, which is what unblocks the waiting tool call.
 */
export function DialogHost() {
	const queue = useStore((select) => select.uiQueue);
	const head = queue[0];
	if (!head) return null;
	return <ExtensionDialog key={head.id} request={head} queued={queue.length} />;
}

function ExtensionDialog({ request, queued }: { request: UIRequest; queued: number }) {
	const [selected, setSelected] = useState<Record<string, { options: string[]; custom: string }>>({});
	const [value, setValue] = useState(request.method === "editor" ? request.message ?? "" : "");
	const cancel = () => store.respondUI({ cancelled: true });

	useEffect(() => {
		if (!request.timeout) return;
		const timer = setTimeout(() => store.respondUI({ cancelled: true, timedOut: true }), request.timeout);
		return () => clearTimeout(timer);
	}, [request.timeout]);

	const title = request.title ?? request.method;
	const subtitle = queued > 1 ? `${queued} requests queued` : undefined;

	if (request.method === "ask") {
		const questions = request.questions ?? [];
		return (
			<Modal
				title={title}
				onClose={cancel}
				footer={
					<>
						<button type="button" className="ghost" onClick={cancel}>
							cancel
						</button>
						<button
							type="button"
							className="primary"
							onClick={() =>
								store.respondUI({
									answers: questions.map((question) => ({
										id: question.id,
										selectedOptions: selected[question.id]?.options ?? [],
										customInput: selected[question.id]?.custom || undefined,
									})),
								})
							}
						>
							submit
						</button>
					</>
				}
			>
				{subtitle && <div className="dim">{subtitle}</div>}
				{questions.map((question) => {
					const picked = selected[question.id]?.options ?? [];
					return (
						<div className="q" key={question.id}>
							<div>
								{question.header ? `${question.header}: ` : ""}
								{question.question}
								{question.multi ? " (pick any)" : ""}
							</div>
							<div className="list">
								{(question.options ?? []).map((option) => (
									<button
										type="button"
										key={option.label}
										className={`opt${picked.includes(option.label) ? " sel" : ""}`}
										onClick={() =>
											setSelected((current) => {
												const options = question.multi
													? picked.includes(option.label)
														? picked.filter((label) => label !== option.label)
														: [...picked, option.label]
													: [option.label];
												return { ...current, [question.id]: { options, custom: current[question.id]?.custom ?? "" } };
											})
										}
									>
										<span>{option.label}</span>
										{option.description && <span className="sub">{option.description}</span>}
									</button>
								))}
							</div>
							<input
								type="text"
								placeholder="or type your own answer"
								value={selected[question.id]?.custom ?? ""}
								onChange={(event) =>
									setSelected((current) => ({
										...current,
										[question.id]: { options: current[question.id]?.options ?? [], custom: event.target.value },
									}))
								}
							/>
						</div>
					);
				})}
			</Modal>
		);
	}

	if (request.method === "select") {
		return (
			<Modal
				title={title}
				onClose={cancel}
				footer={
					<button type="button" className="ghost" onClick={cancel}>
						cancel
					</button>
				}
			>
				{request.message && <div className="pre">{request.message}</div>}
				<OptionList
					items={(request.options ?? []).map((label, index) => ({
						label,
						sub: request.optionDetails?.[index]?.description,
						value: label,
					}))}
					onPick={(item) => store.respondUI({ value: item.value })}
				/>
			</Modal>
		);
	}

	if (request.method === "confirm") {
		return (
			<Modal
				title={title}
				onClose={cancel}
				footer={
					<>
						<button type="button" className="ghost" onClick={() => store.respondUI({ confirmed: false })}>
							no
						</button>
						<button type="button" className="primary" onClick={() => store.respondUI({ confirmed: true })}>
							yes
						</button>
					</>
				}
			>
				<div className="pre">{request.message ?? ""}</div>
			</Modal>
		);
	}

	const editor = request.method === "editor";
	return (
		<Modal
			title={title}
			onClose={cancel}
			footer={
				<>
					<button type="button" className="ghost" onClick={cancel}>
						cancel
					</button>
					<button type="button" className="primary" onClick={() => store.respondUI({ value })}>
						ok
					</button>
				</>
			}
		>
			{request.message && <div className="pre">{request.message}</div>}
			{editor ? (
				<textarea autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
			) : (
				<input
					autoFocus
					type="text"
					value={value}
					placeholder={request.placeholder}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => event.key === "Enter" && store.respondUI({ value })}
				/>
			)}
		</Modal>
	);
}

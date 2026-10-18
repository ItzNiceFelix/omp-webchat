/** Shared UI state: modals, the mobile sidebar, and the agents panel. */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type ModalKind = "sessions" | "models" | "thinking" | "commands" | "btw" | null;

export interface RenameRequest {
	path: string;
	name: string;
}

export interface DeleteRequest {
	path: string;
	name: string;
}

export interface UiApi {
	modal: ModalKind;
	openModal(kind: ModalKind): void;
	closeModal(): void;
	sidebarOpen: boolean;
	setSidebarOpen(open: boolean): void;
	agentsOpen: boolean;
	setAgentsOpen(open: boolean): void;
	rename: RenameRequest | null;
	openRename(request: RenameRequest): void;
	remove: DeleteRequest | null;
	openDelete(request: DeleteRequest): void;
	closeConfirm(): void;
}

const UiContext = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
	const [modal, setModal] = useState<ModalKind>(null);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
	const [rename, setRename] = useState<RenameRequest | null>(null);
	const [remove, setRemove] = useState<DeleteRequest | null>(null);

	const api = useMemo<UiApi>(
		() => ({
			modal,
			openModal: (kind) => {
				setSidebarOpen(false);
				setModal(kind);
			},
			closeModal: () => setModal(null),
			sidebarOpen,
			setSidebarOpen,
			agentsOpen,
			setAgentsOpen,
			rename,
			openRename: setRename,
			remove,
			openDelete: setRemove,
			closeConfirm: () => {
				setRename(null);
				setRemove(null);
			},
		}),
		[modal, sidebarOpen, agentsOpen, rename, remove],
	);

	return <UiContext.Provider value={api}>{children}</UiContext.Provider>;
}

export function useUi(): UiApi {
	const api = useContext(UiContext);
	if (!api) throw new Error("useUi must be used inside UiProvider");
	return api;
}

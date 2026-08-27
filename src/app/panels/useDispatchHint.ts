// SS6: "cycle-forming edits are rejected with an inline hint."
//
// `DocumentStore.dispatch` returns `{ status: 'rejected', reason }` and emits
// NOTHING to subscribers — no patches, no `onChange`. A panel that discards
// that result therefore fails twice over: the user gets no explanation, and
// because nothing re-renders, a controlled `<select>` keeps displaying the
// option the user picked while the document still holds the old value. This
// hook is the one place both are fixed: it keeps the reason for the panel to
// render inline, and its own state update IS the re-render that snaps the
// control back to the document.

import { useCallback, useState, type CSSProperties } from "react";
import type { Command, CommandResult, DocumentStore } from "../../types";

export interface DispatchHint {
  /** Why the last dispatch was rejected, or `null` if it went through. */
  hint: string | null;
  /** `store.dispatch`, with the rejection captured. */
  dispatch: (command: Command) => CommandResult;
}

export function useDispatchHint(store: DocumentStore): DispatchHint {
  // `seq` bumps on EVERY dispatch, not just changed reasons: picking the same
  // cycle-forming output twice must still force a render, or the second
  // rejection leaves the `<select>` showing a routing the document refused.
  const [state, setState] = useState<{ reason: string | null; seq: number }>({ reason: null, seq: 0 });

  const dispatch = useCallback(
    (command: Command): CommandResult => {
      const result = store.dispatch(command);
      setState((prev) => ({
        reason: result.status === "rejected" ? result.reason : null,
        seq: prev.seq + 1,
      }));
      return result;
    },
    [store],
  );

  return { hint: state.reason, dispatch };
}

/** Shared style for the inline hint every panel renders (SS6). */
export const rejectionHintStyle: CSSProperties = {
  fontSize: 10,
  color: "#e08a5a",
  padding: "0 6px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

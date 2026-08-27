/** Registered name of `core.gate`'s worklet processor. Kept in its own module
 *  so the device (main thread) and the processor (worklet thread) can share
 *  the string without the device importing worklet-only globals. */
export const GATE_PROCESSOR_NAME = "fableton-gate";

// SS14 "Helper library `p.*`" — the descriptor factories device authors write
// their params with, re-exported under the name the playbook uses.
//
// The factories themselves live in `src/params/descriptors.ts` (the
// `param-registry` package owns the one real<->normalized taper boundary and
// the one set of `toText` / `fromText` formatters, so tapers and readouts stay
// consistent across the whole device library) — including the SS14 spellings
// `p.pct` / `p.st` / `p.time`, so there is exactly ONE `p` in the codebase
// whichever package a device author imports it from.
//
// Ids passed to these factories are DEVICE-LOCAL (`"cutoff"`); the host
// rewrites them to `chan:<id>/dev:<id>/cutoff` at registration (SS4/SS7).

export { p } from "../../params/descriptors";

export type { DescriptorOptions, DefaultOption, RangeOptions } from "../../params/descriptors";

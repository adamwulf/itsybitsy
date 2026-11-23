// The one place the spike loads the iroh addon. Check B swaps the import
// pattern here; see docs/plans/iroh-spike-findings.md for which one embeds.
export {
  Endpoint,
  EndpointAddr,
  EndpointId,
  RelayMode,
  SecretKey,
  presetMinimal,
  presetN0DisableRelay,
} from "@number0/iroh";
export type { Connection } from "@number0/iroh";

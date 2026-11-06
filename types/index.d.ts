// What probe keeps in $.state: the savings line of each main-loop probe call, one member per call
// (keyed by its tool_use_id), drawn on that call's row; '' while there is none.
export type SavingsLine = string

declare module 'claude-code' {
  interface PluginState {
    probe: { savings: SavingsLine }
  }
}

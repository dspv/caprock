/**
 * The paired machines, for a screen inside the dashboard that offers a switch
 * between them.
 *
 * Only the phone's remote page (ui/src/remote, ADR-058) knows the machines;
 * the dashboard it loads does not. With several paired, the remote page
 * hands this over and hides its own machine bar on a phone's session screen,
 * whose details sheet then lists them (components/PhoneSessionBar). Unset on
 * a computer and on a phone with one machine.
 */
export interface MachineChoice {
  id: string
  name: string
  current: boolean
  /** Paired: it has a token. A machine that does not cannot be read. */
  paired: boolean
}

export interface MachineSwitch {
  list(): MachineChoice[]
  select(id: string): void
}

let current: MachineSwitch | null = null

export function provideMachineSwitch(s: MachineSwitch | null): void {
  current = s
}

export function machineSwitch(): MachineSwitch | null {
  return current
}

import path from 'node:path'
import { startStand } from './stand'

/** Starts the stand once for the run; the returned function is the teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const { state, stop } = await startStand()
  // Workers inherit the environment global setup leaves behind.
  process.env.CAPROCK_E2E_STATE = path.join(state.dir, 'state.json')
  return stop
}

// Every walk family. A family is a folder: its walks (data), and the few
// macros, actions and page templates only it uses.
import type { Family } from '../engine/load.ts'
import { northwind } from './northwind/index.ts'
import { parcelwise } from './parcelwise/index.ts'
import { tidewater } from './tidewater/index.ts'
import { larkspur } from './larkspur/index.ts'

export const FAMILIES: Family[] = [northwind, parcelwise, tidewater, larkspur]

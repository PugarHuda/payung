// Node globals OrangeKit's Bitcoin libraries expect. Imported first so it evaluates before them.
import { Buffer } from 'buffer'
import process from 'process/browser.js'

globalThis.global ??= globalThis
globalThis.Buffer ??= Buffer
globalThis.process ??= process

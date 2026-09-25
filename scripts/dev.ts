import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { startServer } from '../server/index.ts'

const api = await startServer()
const viteBin = resolve('node_modules/vite/bin/vite.js')
const vite = spawn(process.execPath, [viteBin], { stdio: 'inherit' })

function stop(code = 0) {
  if (!vite.killed) vite.kill()
  api.close()
  process.exit(code)
}

vite.on('exit', (code) => {
  api.close()
  process.exit(code ?? 0)
})

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

export const END = '__end__'

export type Checkpoint<S> = {
  threadId: string
  node: string
  next: string
  state: S
}

/** Memory between nodes. A later resume loads the last snapshot and continues from `next`. */
export type Checkpointer<S> = {
  save(checkpoint: Checkpoint<S>): void
  load(threadId: string): Checkpoint<S> | null
  history(threadId: string): Checkpoint<S>[]
  reset(threadId: string): void
}

export function memoryCheckpointer<S>(): Checkpointer<S> {
  const threads = new Map<string, Checkpoint<S>[]>()
  return {
    save(checkpoint) {
      const list = threads.get(checkpoint.threadId) ?? []
      list.push(clone(checkpoint))
      threads.set(checkpoint.threadId, list)
    },
    load(threadId) {
      const last = threads.get(threadId)?.at(-1)
      return last ? clone(last) : null
    },
    history(threadId) {
      return (threads.get(threadId) ?? []).map((item) => clone(item))
    },
    reset(threadId) {
      threads.delete(threadId)
    },
  }
}

type NodeFn<S, D> = (state: S, deps: D) => Promise<S> | S
type EdgeFn<S> = (state: S) => string

export type GraphRun<S> = {
  state: S
  interrupted: string | null
}

export type CompiledGraph<S, D> = {
  invoke(input: S, options: { threadId: string; deps: D; interruptBefore?: readonly string[] }): Promise<GraphRun<S>>
  resume(threadId: string, options: { deps: D; interruptBefore?: readonly string[] }): Promise<GraphRun<S>>
  history(threadId: string): Checkpoint<S>[]
}

export function compileGraph<S, D>(options: {
  entry: string
  nodes: Record<string, NodeFn<S, D>>
  edges: Record<string, EdgeFn<S>>
  checkpointer: Checkpointer<S>
}): CompiledGraph<S, D> {
  const { entry, nodes, edges, checkpointer } = options
  if (!nodes[entry]) throw new Error(`Нет узла ${entry}`)
  for (const name of Object.keys(nodes)) {
    if (!edges[name]) throw new Error(`Нет ребра из ${name}`)
  }

  async function run(threadId: string, deps: D, interruptBefore: readonly string[] | undefined, start: { state: S; node: string }) {
    const interrupt = new Set(interruptBefore ?? [])
    let state = start.state
    let node = start.node
    while (node !== END) {
      if (interrupt.has(node)) {
        const saved = checkpointer.load(threadId)
        if (!saved || saved.next !== node) checkpointer.save({ threadId, node: saved?.node ?? '', next: node, state })
        const paused = checkpointer.load(threadId)
        if (!paused) throw new Error('Нет сохранённого шага')
        return { state: paused.state, interrupted: node }
      }
      const fn = nodes[node]
      if (!fn) throw new Error(`Нет узла ${node}`)
      state = await fn(state, deps)
      const edge = edges[node]
      if (!edge) throw new Error(`Нет ребра из ${node}`)
      const next = edge(state)
      if (next !== END && !nodes[next]) throw new Error(`Ребро из ${node} ведёт в неизвестный узел ${next}`)
      checkpointer.save({ threadId, node, next, state })
      node = next
    }
    return { state: clone(state), interrupted: null }
  }

  return {
    invoke(input, runOptions) {
      checkpointer.reset(runOptions.threadId)
      return run(runOptions.threadId, runOptions.deps, runOptions.interruptBefore, { state: clone(input), node: entry })
    },
    resume(threadId, runOptions) {
      const saved = checkpointer.load(threadId)
      if (!saved) throw new Error('Нет сохранённого шага')
      return run(threadId, runOptions.deps, runOptions.interruptBefore, { state: saved.state, node: saved.next })
    },
    history(threadId) {
      return checkpointer.history(threadId)
    },
  }
}

function clone<S>(value: S): S {
  return structuredClone(value)
}

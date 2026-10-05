import { openDB, type DBSchema } from 'idb'
import type { Event, Reading } from './series'

export type Source = 'device' | 'simulated'
export type SessionMeta = { id: number; name: string; start: number; end: number; source: Source }
type Chunk = { sessionId: number; readings: Reading[]; events: Event[] }

interface Schema extends DBSchema {
  sessions: { key: number; value: SessionMeta }
  chunks: { key: number; value: Chunk; indexes: { session: number } }
}

const dbp = openDB<Schema>('pulmosense', 1, {
  upgrade(d) {
    d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true })
    d.createObjectStore('chunks', { autoIncrement: true }).createIndex('session', 'sessionId')
  },
})

export async function createSession(m: Omit<SessionMeta, 'id'>): Promise<number> {
  return (await dbp).add('sessions', m as SessionMeta) // id assigned by autoIncrement
}

export async function putSession(m: SessionMeta) {
  await (await dbp).put('sessions', m)
}

/** One transaction: the chunk and the session's updated end time land together. */
export async function saveChunk(m: SessionMeta, readings: Reading[], events: Event[]) {
  const tx = (await dbp).transaction(['sessions', 'chunks'], 'readwrite')
  tx.objectStore('chunks').add({ sessionId: m.id, readings, events })
  tx.objectStore('sessions').put(m)
  await tx.done
}

export async function listSessions() {
  return (await dbp).getAll('sessions')
}

export async function loadSession(id: number) {
  const chunks = await (await dbp).getAllFromIndex('chunks', 'session', id)
  return { readings: chunks.flatMap((c) => c.readings), events: chunks.flatMap((c) => c.events) }
}

export async function deleteSession(id: number) {
  const tx = (await dbp).transaction(['sessions', 'chunks'], 'readwrite')
  tx.objectStore('sessions').delete(id)
  const chunks = tx.objectStore('chunks')
  for (let c = await chunks.index('session').openKeyCursor(id); c; c = await c.continue()) chunks.delete(c.primaryKey)
  await tx.done
}

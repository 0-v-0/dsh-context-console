import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { readSessionLogEvents } from '../src/forge/sessionlog.ts'
import { buildTrajectory } from '../src/trajectory.ts'

/**
 * A session opened from the sidebar is replayed, not live, so the trajectory
 * wall must project a persisted log. Lay the log out exactly the way the
 * persistence plugin writes it: one header row, then one row per event.
 */
function logBytes(session: Session): Buffer {
  // Persisted headers carry the marker, cwd and delegation depth the catalog
  // validates; Session.create leaves those to the store.
  const header = {
    type: 'session',
    ...session.header,
    cwd: process.cwd(),
    delegationDepth: 0,
  }
  const rows: string[] = [JSON.stringify(header)]
  for (const event of session.snapshotEvents()) rows.push(JSON.stringify(event))
  return Buffer.from(`${rows.join('\n')}\n`, 'utf8')
}

test('restores a persisted session log for a replayed, non-live session', () => {
  const session = Session.create(SessionId('session-replay-probe'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const events = readSessionLogEvents(logBytes(session))

  assert.deepEqual(
    events.map(event => event.type),
    session.snapshotEvents().map(event => event.type),
  )
  assert.deepEqual(
    events.map(event => event.seq),
    session.snapshotEvents().map(event => event.seq),
  )
})

test('projects a restored log through buildTrajectory', () => {
  const session = Session.create(SessionId('session-replay-trajectory'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const events = readSessionLogEvents(logBytes(session))
  const snapshot = buildTrajectory({
    id: 'session-replay-trajectory',
    lastSeq: events.length - 1,
    events: events as unknown as Array<Record<string, any>>,
  })

  assert.equal(snapshot.eventCount, session.snapshotEvents().length)
  assert.equal(snapshot.lastSeq, session.snapshotEvents().length - 1)
  assert.equal(snapshot.cells.length, session.snapshotEvents().length)
  assert.deepEqual(snapshot.cells.map(cell => cell.type), session.snapshotEvents().map(event => event.type))
  assert.ok(snapshot.cells.some(cell => cell.kind === 'tool-call'))
})



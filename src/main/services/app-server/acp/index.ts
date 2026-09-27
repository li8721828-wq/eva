import type { IncomingMessage, Server } from 'http'
import type { Socket } from 'net'
import { WebSocket, WebSocketServer } from 'ws'
import { RpcConnection } from '../rpc-connection'
import type { SseHub } from '../sse-hub'
import type { RpcMethod } from '../protocol'
import { createAcpConnection } from './connection'
import { recordActivity } from '../../activity-log'

/**
 * The `/acp` door: an ACP WebSocket hung off the same HTTP or HTTPS server that
 * already answers `POST /v1/rpc`. The server's transport profile decides
 * whether clients use local `ws://` or remote `wss://`.
 *
 * The client this is built for speaks JSON-RPC over one WebSocket and nothing
 * else — no stdio, no SSE. One text frame carries one complete JSON-RPC 2.0
 * object, binary frames are ignored the same way the client ignores them, and no
 * subprotocol is offered or negotiated, because answering one back would change
 * what a client that sent none has to accept.
 */

export const ACP_PATH = '/acp'

export interface AcpGatewayDeps {
  hub: SseHub
  /** Eva's own JSON-RPC handlers, so the facade runs the same code as the HTTP door. */
  callMethod: (method: RpcMethod, params?: unknown) => Promise<unknown>
  bearerToken: string
  /**
   * Off only while a client cannot send an `Authorization` header yet. While off,
   * an upgrade that carries `Origin` is refused: see `readRejection`.
   */
  requireAuth: boolean
  agentVersion: string
}

export interface AcpGateway {
  connections(): number
  close(): void
}

export function registerAcpUpgrade(server: Server, deps: AcpGatewayDeps): AcpGateway {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1_048_576 })

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const rejection = readRejection(req, deps)
    if (rejection) {
      rejectHandshake(socket, rejection.statusCode, rejection.reason)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, deps))
  }
  server.on('upgrade', onUpgrade)

  return {
    connections: () => wss.clients.size,
    close(): void {
      server.off('upgrade', onUpgrade)
      for (const client of wss.clients) client.close()
      wss.close()
    },
  }
}

/** Why this upgrade must not become a session, or `null` when it may proceed. */
function readRejection(req: IncomingMessage, deps: AcpGatewayDeps): { statusCode: number; reason: string } | null {
  const pathname = (req.url || '').split('?')[0]
  if (pathname !== ACP_PATH) return { statusCode: 421, reason: `Only ${ACP_PATH} is served over a WebSocket here.` }
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') return { statusCode: 400, reason: 'Expected a WebSocket upgrade.' }
  if (deps.requireAuth && req.headers.authorization !== `Bearer ${deps.bearerToken}`) {
    return { statusCode: 401, reason: 'Missing or wrong bearer token.' }
  }
  // A browser always sends `Origin`; a native client sends none. With the token
  // check off, that header is the only thing separating a native client from a
  // web page that can reach the endpoint, and an agent that runs terminal
  // commands is not something a random page may drive. Remote mode never turns
  // this check off because it forces bearer authentication at startup.
  if (!deps.requireAuth && req.headers.origin) {
    return { statusCode: 403, reason: 'Origin-carrying clients need the bearer token.' }
  }
  return null
}

function rejectHandshake(socket: Socket, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function accept(ws: WebSocket, deps: AcpGatewayDeps): void {
  const connection = new RpcConnection({
    write: (frame) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('The ACP socket no longer accepts writes.')
      ws.send(frame)
    },
  })
  const acp = createAcpConnection({
    connection,
    hub: deps.hub,
    callMethod: deps.callMethod,
    agentVersion: deps.agentVersion,
  })
  acp.register()

  void recordActivity({
    category: 'system',
    action: 'app_server.acp_connected',
    status: 'info',
    summary: `ACP client connected on ${ACP_PATH}.`,
  })

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    // The ACP terminal ignores binary frames; answering them would invent a
    // framing the client does not implement.
    if (isBinary) return
    connection.receive(data.toString('utf-8'))
  })
  ws.on('close', () => {
    connection.close('socket closed')
    acp.dispose('socket closed')
    void recordActivity({
      category: 'system',
      action: 'app_server.acp_disconnected',
      status: 'info',
      summary: `ACP client disconnected from ${ACP_PATH}.`,
    })
  })
  ws.on('error', () => {
    // The socket is unusable; `close` follows and does the cleanup. Nothing is
    // thrown back here because there is no caller that could act on it.
    connection.close('socket error')
  })
}

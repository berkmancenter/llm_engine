import { WebClient } from '@slack/web-api'

class SlackClientPool {
  clients: Map<string, WebClient>

  maxSize: number

  constructor(maxSize = 100) {
    this.clients = new Map()
    this.maxSize = maxSize
  }

  getClient(workspaceId, botToken): WebClient {
    if (this.clients.has(workspaceId)) {
      // Move to end (most recently used)
      const client = this.clients.get(workspaceId)
      this.clients.delete(workspaceId)
      this.clients.set(workspaceId, client!)
      return client!
    }
    const client = new WebClient(botToken)
    // Evict oldest if at capacity
    if (this.clients.size >= this.maxSize) {
      const firstKey = this.clients.keys().next().value
      this.clients.delete(firstKey)
    }
    this.clients.set(workspaceId, client)
    return client
  }

  clear() {
    this.clients.clear()
  }
}

const slackClientPool = new SlackClientPool()
export default slackClientPool

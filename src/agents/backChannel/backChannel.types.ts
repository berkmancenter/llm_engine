export type Timestamp = {
  start: number
  end: number
}
export type Comment = {
  user?: string
  text: string
  preset?: boolean
}

export type Metric = {
  name: string
  value: number
  comments: Comment[]
}

export type Insight = {
  value: string
  comments: Comment[]
  type: 'insight' | 'question'
}

export type BackChannelAgentResponse = {
  timestamp: Timestamp
  metrics?: Metric[]
  insights?: Insight[]
}

export type ParticipantMessage = {
  text: string
  preset?: boolean
}

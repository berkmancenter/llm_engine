import mongoose from 'mongoose'
import { GenerationProvenance } from '../types/index.types.js'
import { hiddenSetHash } from './messageVisibility.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const idString = (value: any): string | undefined => {
  if (value === undefined || value === null) return undefined
  return (value._id ?? value).toString()
}

/**
 * Builds the record of what a generated output was read from: the messages that reached the model (so, after
 * hidden ones were left out), their authors, and a fingerprint of the hidden set at that moment.
 *
 * `messages` must be the ones actually given to the generator. Agent messages count as sources but not as authors.
 */
export default async function buildProvenance(
  generator: string,
  conversationIds: Array<string | mongoose.Types.ObjectId>,
  messages: Array<{ _id?: any; id?: any; owner?: any; fromAgent?: boolean }>,
  extra: Partial<Pick<GenerationProvenance, 'carriedForwardFrom' | 'quoteSources'>> = {}
): Promise<GenerationProvenance> {
  const sourceMessageIds = [...new Set(messages.map((m) => idString(m._id ?? m.id)).filter((id): id is string => !!id))]
  const authorIds = [
    ...new Set(
      messages
        .filter((m) => !m.fromAgent)
        .map((m) => idString(m.owner))
        .filter((id): id is string => !!id)
    )
  ]
  return {
    sourceMessageIds,
    authorIds,
    generator,
    generatedAt: new Date(),
    hiddenSetHash: await hiddenSetHash(conversationIds),
    ...extra
  }
}

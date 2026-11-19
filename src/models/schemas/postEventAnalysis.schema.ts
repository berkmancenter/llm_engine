import mongoose from 'mongoose'
import { PostEventAnalysis } from '../../types/index.types.js'
import { toJSON } from '../plugins/index.js'
import provenanceSchema from './provenance.schema.js'

/* Everything an LLM extracts from a conversation once it stops, grouped under one field so a new
   postEvent artifact is one more key here, not another top-level field on Conversation. Needs its
   own toJSON plugin (not just the parent's) so summaryProvenance/openThreadsProvenance are still
   stripped as a single nested subdocument, the same way resourceSchema strips Resource.fileName. */
const postEventAnalysisSchema = new mongoose.Schema<PostEventAnalysis>(
  {
    summary: { type: String, default: undefined },
    summaryProvenance: { type: provenanceSchema, default: undefined, private: true },
    // Array paths default to [] unless told otherwise - must stay undefined so "never extracted"
    // and "extracted, found nothing" both read as absent, not as an empty array either way.
    openThreads: { type: [String], default: undefined },
    openThreadsProvenance: { type: provenanceSchema, default: undefined, private: true }
  },
  { _id: false }
)
postEventAnalysisSchema.plugin(toJSON)

export default postEventAnalysisSchema

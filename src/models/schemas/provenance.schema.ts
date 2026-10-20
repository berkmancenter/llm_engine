import mongoose from 'mongoose'
import { GenerationProvenance } from '../../types/index.types.js'

/* Embedded subdocument shared by every generated output that records what it was built from (see
   GenerationProvenance). No _id: it is only ever read with its parent. A parent declares it with
   `{ type: provenanceSchema, private: true, default: undefined }`, so it stays out of every toJSON
   and stays absent, not empty, where nothing was recorded. */
const provenanceSchema = new mongoose.Schema<GenerationProvenance>(
  {
    sourceMessageIds: { type: [mongoose.SchemaTypes.ObjectId], default: [] },
    authorIds: { type: [mongoose.SchemaTypes.ObjectId], default: [] },
    generator: { type: String, required: true },
    generatedAt: { type: Date, required: true },
    hiddenSetHash: { type: String },
    carriedForwardFrom: { type: mongoose.SchemaTypes.ObjectId, ref: 'ArtifactVersion' },
    quoteSources: {
      type: [
        new mongoose.Schema(
          { ref: { type: String, required: true }, messageIds: { type: [mongoose.SchemaTypes.ObjectId], default: [] } },
          { _id: false }
        )
      ],
      default: undefined
    }
  },
  { _id: false }
)

export default provenanceSchema

import mongoose, { Model } from 'mongoose'
import { toJSON, paginate } from '../plugins/index.js'
import { IPollResponse } from '../../types/index.types.js'

export interface PollResponseMethods {
  replaceObjectsWithIds(): IPollResponse
}
interface PollResponseStatics {
  replaceObjectsWithIds(pollResponse: IPollResponse): IPollResponse
}

type PollResponseModel = Model<IPollResponse, Record<string, never>, PollResponseMethods> & PollResponseStatics

const pollResponseSchema = new mongoose.Schema<IPollResponse, PollResponseModel>(
  {
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'User',
      required: true,
      private: false,
      index: true
    },
    poll: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Poll',
      required: true,
      private: false,
      index: true
    },
    choice: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'PollChoice',
      required: true,
      private: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)
// add plugin that converts mongoose to json
pollResponseSchema.plugin(toJSON)
pollResponseSchema.plugin(paginate)
pollResponseSchema.static('replaceObjectsWithIds', (pollResponse) => {
  const pollResponseData = pollResponse.toObject()
  pollResponseData.owner = pollResponseData.owner._id
  pollResponseData.poll = pollResponseData.poll._id
  pollResponseData.choice = pollResponseData.choice._id
  return pollResponseData
})
pollResponseSchema.method('replaceObjectsWithIds', function () {
  return (this.constructor as PollResponseModel).replaceObjectsWithIds(this)
})
/**
 * @typedef pollResponse
 */
const pollResponse = mongoose.model<IPollResponse, PollResponseModel>('PollResponse', pollResponseSchema)
export default pollResponse

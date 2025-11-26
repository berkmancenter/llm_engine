import mongoose, { Model } from 'mongoose'
import { toJSON, paginate } from '../plugins/index.js'
import { roles } from '../../config/roles.js'
import BaseUser from './baseUser.model.js'
import { IUser, PaginateResults } from '../../types/index.types.js'
import pseudonymSchema from './schemas/pseudonym.schema.js'

const validateEmail = (email) => {
  const re =
    // eslint-disable-next-line
    /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  return re.test(email)
}

interface UserStatics {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<IUser>>
}

type UserModel = Model<IUser, Record<string, never>> & UserStatics

const userSchema = new mongoose.Schema<IUser, UserModel>(
  {
    username: {
      type: String,
      trim: true
    },
    password: {
      type: String,
      trim: true,
      minlength: 8,
      validate(value) {
        if (!value.match(/\d/) || !value.match(/[a-zA-Z]/)) {
          throw new Error('Password must contain at least one letter and one number')
        }
      },
      private: true // used by the toJSON plugin
    },
    pseudonyms: {
      type: [pseudonymSchema],
      required: true
    },
    role: {
      type: String,
      enum: roles,
      default: 'user',
      index: true
    },
    goodReputation: {
      type: Boolean,
      index: true
    },
    email: {
      type: String,
      trim: true,
      validate: [validateEmail, 'Please fill a valid email address']
    },
    dataExportOptOut: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)
// add plugin that converts mongoose to json
userSchema.plugin(toJSON)
userSchema.plugin(paginate)
userSchema.virtual('activePseudonym').get(function () {
  return this.pseudonyms.find((x) => x.active)
})
userSchema.pre('validate', function (next) {
  this.role = 'user'
  next()
})
/**
 * @typedef User
 */
const User = BaseUser.discriminator<IUser, UserModel>('User', userSchema)
export default User

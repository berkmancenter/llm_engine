import mongoose from 'mongoose'
import { IBaseUser } from '../../types/index.types.js'

// empty base schema to subclass off/discriminate on for agents
const baseUserSchema = new mongoose.Schema<IBaseUser>({}, { timestamps: true })
const BaseUser = mongoose.model('BaseUser', baseUserSchema)
export default BaseUser

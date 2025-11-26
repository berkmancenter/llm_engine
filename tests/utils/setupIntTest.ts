import mongoose from 'mongoose'
import config from '../../src/config/config'
import agenda from '../../src/jobs'

const setupIntTest = () => {
  beforeAll(async () => {
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
  })

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
  })

  afterAll(async () => {
    await agenda.stop()
    await agenda.close()
    await mongoose.disconnect()
  })
}

export default setupIntTest

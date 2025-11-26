/* eslint-disable no-param-reassign */
/**
 * A mongoose schema plugin which applies the following in the toJSON transform call:
 *  - removes __v, createdAt, updatedAt, and any path that has private: true
 *  - replaces _id with id
 */
const deleteAtPath = (obj, path, index) => {
  if (index === path.length - 1) {
    delete obj[path[index]]
    return
  }
  deleteAtPath(obj[path[index]], path, index + 1)
}
const toJSON = (schema) => {
  let transform
  if (schema.options.toJSON && schema.options.toJSON.transform) {
    transform = schema.options.toJSON.transform
  }
  schema.options.toJSON = Object.assign(schema.options.toJSON || {}, {
    transform(doc, ret, options) {
      Object.keys(schema.paths).forEach((path) => {
        if (schema.paths[path].options && schema.paths[path].options.private) {
          deleteAtPath(ret, path.split('.'), 0)
        }
      })
      if (ret._id) {
        ret.id = ret._id.toString()
        delete ret._id
      }
      delete ret.__v
      delete ret.updatedAt
      // REMOVE SOFT-DELETES IN SUBDOCUMENTS
      // For any property that is an array, remove all items
      // with isDeleted = true
      Object.keys(ret).forEach((prop) => {
        if (Array.isArray(ret[prop])) {
          ret[prop] = ret[prop].filter((x) => !x.isDeleted)
        }
      })
      if (transform) {
        return transform(doc, ret, options)
      }
    }
  })
}
export default toJSON

/* eslint-disable no-param-reassign */
/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'

/*
 * Adds hasPdf to the serialized output of any resource schema. Apply this
 * after the toJSON plugin — by then, fileName is already stripped from ret,
 * but it's still readable on doc (the raw Mongoose document), so we derive
 * hasPdf there instead of exposing the actual path.
 */
const hasPdfPlugin = (schema: mongoose.Schema) => {
  const prev = schema.options.toJSON?.transform
  schema.options.toJSON = {
    ...schema.options.toJSON,
    transform(doc: any, ret: any, options: any) {
      if (typeof prev === 'function') prev(doc, ret, options)
      ret.hasPdf = !!doc.fileName
    }
  }
}

export default hasPdfPlugin

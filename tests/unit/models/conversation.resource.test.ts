import mongoose from 'mongoose'
import toJSON from '../../../src/models/plugins/toJSON.plugin.js'
import hasPdf from '../../../src/models/plugins/hasPdf.plugin.js'

/*
 * Tests for the hasPdf plugin. Resources have a private fileName field that
 * the toJSON plugin strips from API responses — hasPdf is derived from it so
 * clients can tell whether a PDF is attached without seeing the actual path.
 */
describe('hasPdf plugin', () => {
  let connection: mongoose.Connection

  beforeEach(() => {
    connection = mongoose.createConnection()
  })

  /* Minimal schema that matches the real resourceSchema's relevant shape:
     fileName is private, title is public. Both plugins applied in order. */
  const buildSchema = (name: string) => {
    const schema = new mongoose.Schema({
      title: { type: String, required: true },
      fileName: { type: String, private: true },
    })
    schema.plugin(toJSON)
    schema.plugin(hasPdf)
    return connection.model(name, schema)
  }

  it('keeps fileName out of the serialized output', () => {
    const Resource = buildSchema('ResourcePrivate')
    const doc = new Resource({ title: 'Test Paper', fileName: 'abc123.pdf' })

    expect(doc.toJSON()).not.toHaveProperty('fileName')
  })

  it('sets hasPdf to true when the resource has a fileName', () => {
    const Resource = buildSchema('ResourceWithFile')
    const doc = new Resource({ title: 'Test Paper', fileName: 'abc123.pdf' })

    expect(doc.toJSON()).toHaveProperty('hasPdf', true)
  })

  it('sets hasPdf to false when the resource has no fileName', () => {
    const Resource = buildSchema('ResourceNoFile')
    const doc = new Resource({ title: 'Link Only Resource' })

    expect(doc.toJSON()).toHaveProperty('hasPdf', false)
  })
})

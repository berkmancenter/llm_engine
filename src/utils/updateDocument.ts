/**
 * Update a Mongoose document with properties from a request body, for update/PUT routes.
 * It will update properties on the source document, but otherwise not change the document.
 * This allows the API to receive partial objects for update.
 * @param {Object} incomingObj
 * @param {Object} document
 * @returns {Object}
 */
const updateDocument = (incomingObj, document) => {
  Object.keys(incomingObj).forEach((prop) => {
    if (prop !== 'id') {
      // eslint-disable-next-line no-param-reassign
      document[prop] = incomingObj[prop]
    }
  })
  return document
}
export default updateDocument

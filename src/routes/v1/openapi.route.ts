import express from 'express'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerDefinition from '../../docs/swaggerDef.js'

const router = express.Router()
export const specs = swaggerJsdoc({
  swaggerDefinition,
  apis: ['src/docs/*.yml', 'src/routes/v1/**/*.ts']
})

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.send(specs)
})

export default router

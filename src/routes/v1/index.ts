import express from 'express'
import authRoute from './auth.route.js'
import userRoute from './user.route.js'
import docsRoute from './docs.route.js'
import messagesRoute from './messages.route.js'
import topicsRoute from './topics.route.js'
import conversationsRoute from './conversations.route.js'
import configRoute from './config.route.js'
import config from '../../config/config.js'
import pollsRoute from './polls.route/index.js'
import webhooksRoute from './webhooks.route.js'
import experimentsRoute from './experiments.route.js'
import healthRoute from './health.route.js'
import openApiRoute from './openapi.route.js'
// import exportRoute from './export.route.js'

const router = express.Router()
const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute
  },
  {
    path: '/users',
    route: userRoute
  },
  {
    path: '/messages',
    route: messagesRoute
  },
  {
    path: '/topics',
    route: topicsRoute
  },
  {
    path: '/conversations',
    route: conversationsRoute
  },
  {
    path: '/polls',
    route: pollsRoute
  },
  {
    path: '/config',
    route: configRoute
  },
  {
    path: '/webhooks',
    route: webhooksRoute
  },
  {
    path: '/experiments',
    route: experimentsRoute
  },
  {
    path: '/health',
    route: healthRoute
  },
  {
    path: '/openapi.json',
    route: openApiRoute
  }
  // {
  //   path: '/export',
  //   route: exportRoute
  // }
]
const devRoutes = [
  // routes available only in development mode
  {
    path: '/docs',
    route: docsRoute
  }
]
defaultRoutes.forEach((route) => {
  router.use(route.path, route.route)
})
/* istanbul ignore next */
if (config.env === 'development') {
  devRoutes.forEach((route) => {
    router.use(route.path, route.route)
  })
}
export default router

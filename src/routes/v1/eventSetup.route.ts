import express from 'express'
import validate from '../../middlewares/validate.js'
import handoffAuth from '../../middlewares/handoffAuth.js'
import eventSetupController from '../../controllers/eventSetup.controller.js'
import eventSetupValidation from '../../validations/eventSetup.validation.js'

const router = express.Router()

router.post('/plan', handoffAuth, validate(eventSetupValidation.plan), eventSetupController.plan)

export default router

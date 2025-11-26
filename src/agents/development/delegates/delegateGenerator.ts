import mongoose from 'mongoose'
import Papa from 'papaparse'
import fs from 'fs'
import { getSinglePromptResponse } from '../../helpers/llmChain.js'
import logger from '../../../config/logger.js'
import { defaultLLMTemplates } from './prompts.js'
import { getModelChat } from '../../helpers/getModelChat.js'
import Agent from '../../../models/user.model/agent.model/index.js'
import { Delegate } from './delegates.types.js'

/**
 * Standalone program to read survey responses and update agent config with delegate information and
 * number of participants per round (in lieu or passing agent config as an argument when invoking activateAgent)
 *
 * Important: CSV file headers must be manually modified to match the names in the surveyHeaders array.
 * Extra columns will be ignored.
 *
 * USAGE:
 * NODE_ENV=... MONGODB_URL=... node --loader ts-node/esm delegateGenerator.ts [csv file name] [optional agentID]
 * Specifying the NODE_ENV and MONGODB_URL
 *
 * If no agentID is specified, the resulting config will be logged
 */
const surveyHeaders = [
  'interest',
  'communicationDescription',
  'disagreementPhrase',
  'agreementPhrase',
  'mythOrLogic',
  'labyrinthOrHighway',
  'blueprintsOrSketchpads',
  'marathonOrSprint',
  'pseudonym',
  'question'
]

const participantsPerRound = 8

const llm = getModelChat('openai', 'gpt-40-mini', { temperature: 1.2 })

function getSurveyResponses(file, columnsToInclude) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      transform(value, field) {
        if (['mythOrLogic', 'labyrinthOrHighway', 'blueprintsOrSketchpads', 'marathonOrSprint'].includes(field)) {
          return value.toLowerCase()
        }
        return value
      },
      complete(results) {
        try {
          // Filter the parsed data during the parsing process
          const filteredData = results.data.map((row) => {
            const filteredRow = {}
            columnsToInclude.forEach((column) => {
              // Safer approach: Use Object.prototype.hasOwnProperty.call()
              if (Object.prototype.hasOwnProperty.call(row, column)) {
                filteredRow[column] = row[column]
              }
            })
            return filteredRow
          })

          resolve(filteredData)
        } catch (error) {
          reject(error)
        }
      }
    })
  })
}

async function generatePersonality(surveyResponse) {
  const {
    communicationDescription,
    disagreementPhrase,
    agreementPhrase,
    mythOrLogic,
    labryinthOrHighway,
    blueprintsOrSketchpads,
    marathonOrSprint
  } = surveyResponse

  return (await getSinglePromptResponse(llm, defaultLLMTemplates.personality, {
    communicationDescription,
    agreementPhrase,
    disagreementPhrase,
    mythOrLogic,
    labryinthOrHighway,
    blueprintsOrSketchpads,
    marathonOrSprint
  })) as string
}

async function generateDelegateConfig(fileName, agentId) {
  /* eslint-disable security/detect-non-literal-fs-filename */
  const csvFile = fs.readFileSync(fileName, 'utf8')
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const surveyResponses: any = await getSurveyResponses(csvFile, surveyHeaders)

    const delegates: Array<Delegate> = []
    for (const surveyResponse of surveyResponses) {
      if (surveyResponse.pseudonym) {
        logger.info(`Processing survey response from: ${surveyResponse.pseudonym}`)
        const personality = await generatePersonality(surveyResponse)
        const { interest, pseudonym, question } = surveyResponse
        delegates.push({ personality, interest, pseudonym, question })
      }
    }
    if (agentId) {
      mongoose.set('strict', true)
      await mongoose.connect(process.env.MONGODB_URL as string)
      const agent = await Agent.findOne({ _id: new mongoose.Types.ObjectId(agentId) }).exec()

      if (!agent) {
        logger.error(`Could not find agent ${agentId}`)
        return
      }
      logger.debug('Saving delegates to agent config.')

      agent.deepPatch({ agentConfig: { delegates, participantsPerRound } })
      await agent.save()
      logger.debug('Agent config saved')
    } else {
      logger.debug(JSON.stringify({ delegates, participantsPerRound }))
    }
  } catch (err) {
    logger.error('Error occurred:', err)
  } finally {
    await mongoose.connection.close()
    logger.info('Connection closed, exiting...')
    process.exit(0)
  }
}

const args = process.argv.slice(2)
generateDelegateConfig(args[0], args[1])

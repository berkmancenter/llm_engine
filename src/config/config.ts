import dotenv from 'dotenv'
import Joi from 'joi'
import { availableParallelism } from 'node:os'

const env = '.env'
dotenv.config({ path: `${process.cwd()}/${env}` })

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').allow('').optional(),
    PORT: Joi.number().default(3000),
    WEBSOCKET_BASE_PORT: Joi.number().default(5555),
    WEBSOCKET_MAX_PARALLELISM: Joi.number().default(availableParallelism()).description('Max parallelism for websocket use'),
    MONGODB_URL: Joi.string().required().description('Mongo DB url'),
    MONGODB_DEBUG: Joi.boolean().description('Enable mongoose debugging'),
    ENABLE_DEVELOPMENT_AGENTS: Joi.boolean().default(false).description('Enable development agent support'),
    ENABLE_DEVELOPMENT_ADAPTERS: Joi.boolean().default(false).description('Enable development adapter support'),
    ENABLE_PUBLIC_CHANNEL_CREATION: Joi.boolean().default(false).description('Enable channel creation'),
    ENABLE_AUTO_DELETION: Joi.boolean().default(true).description('Enable automatic deletion of inactive topics'),
    ENABLE_EXPORT_OPT_OUT: Joi.boolean().default(true).description('Enable export opt-out functionality'),
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(120)
      .description('minutes after which a password reset token expires'),
    AUTH_TOKEN_SECRET: Joi.string().description('secret used to encrypt generated passwords'),
    SMTP_HOST: Joi.string().description('server that will send the emails'),
    SMTP_PORT: Joi.number().description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string().description('username for email server'),
    SMTP_PASSWORD: Joi.string().description('password for email server'),
    EMAIL_FROM: Joi.string().description('the from field in the emails sent by the app'),
    APP_HOST: Joi.string().description('the host url for the frontend app'),
    TRULY_RANDOM_PSEUDONYMS: Joi.string()
      .default('false')
      .description('true/false if pseudonyms are made truly random with UID'),
    MAX_MESSAGE_LENGTH: Joi.number().min(50).max(100000).default(2000).description('The maximum length of a message'),
    DAYS_FOR_GOOD_REPUTATION: Joi.number().default(1).description('the number of days it takes to get a good reputation'),
    CHROMA_DB_URL: Joi.string().default('http://0.0.0.0:8000'),
    EMBEDDINGS_COLLECTION_PREFIX: Joi.string().default('llm-engine'),
    DEFAULT_EMBEDDINGS_API_URL: Joi.string().description('The URL of an OpenAI-compatible server used for embeddings'),
    DEFAULT_EMBEDDINGS_API_KEY: Joi.string().description(
      'The API key to access the OpenAI-compatible server used for embeddings'
    ),
    EMBEDDINGS_DOCUMENT_MODEL: Joi.string()
      .description('The model name to use for document embeddings')
      .default('text-embedding-3-large'),
    EMBEDDINGS_REALTIME_MODEL: Joi.string()
      .description('The model name to use for realtime embeddings')
      .default('text-embedding-3-small'),
    DEFAULT_OPENAI_API_KEY: Joi.string().description('Default OpenAI key'),
    DEFAULT_OPENAI_PROJECT_ID: Joi.string().description('Default optional project ID to pass with OpenAI headers'),
    DEFAULT_OPENAI_BASE_URL: Joi.string().description('Default OpenAI API base url'),
    OLLAMA_BASE_URL: Joi.string().description('Ollama API base url').default('http://0.0.0.0:11434'),
    PERSPECTIVE_API_KEY: Joi.string().description('Perspective API key'),
    RECALL_API_KEY: Joi.string().description('API Key for Recall.ai'),
    RECALL_TOKEN: Joi.string().description('Token for Recall.ai incoming webhook verification'),
    RECALL_BASE_URL: Joi.string().description('Base URL of Recall.ai server'),
    RECALL_ENDPOINT_BASE_URL: Joi.string().description('Base URL on this server, used by Recall.ai to invoke webhooks'),
    ZOOM_SECRET_TOKEN: Joi.string().description('Secret token from LLM Engine Zoom app'),
    ZOOM_WEBINAR_USER_EMAIL: Joi.string().description(
      'Email address to support adding agents to Zoom webinars as additional panelists'
    ),
    SLACK_SIGNING_SECRET: Joi.string().description('Signing secret from LLM Engine Slack app'),
    LANGSMITH_TRACING_V2: Joi.boolean().description('Enables Langsmith Tracing'),
    LANGSMITH_API_KEY: Joi.string().description('API Key for Langsmith'),
    TRANSCRIPT_RETENTION_PERIOD: Joi.string()
      .default('3 months')
      .description('The amount of time to retain conversation transcripts'),
    VLLM_API_URL: Joi.string().description('The URL of a VLLM OpenAI-compatible server used for inference'),
    VLLM_API_KEY: Joi.string().description('The API key to access the VLLM OpenAI-compatible server used for inference'),
    INFINITY_API_URL: Joi.string().description('The URL of an Infinity OpenAI-compatible server used for inference'),
    INFINITY_API_KEY: Joi.string().description(
      'The API key to access the Infinity OpenAI-compatible server used for inference'
    )
  })
  .unknown()

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env)

if (error) {
  throw new Error(`Config validation error: ${error.message}`)
}

const config = {
  env: envVars.NODE_ENV,
  envFile: env,
  port: envVars.PORT,
  websocketBasePort: envVars.WEBSOCKET_BASE_PORT,
  websocketMaxParallelism: Math.min(envVars.WEBSOCKET_MAX_PARALLELISM, availableParallelism()),
  logLevel: envVars.LOG_LEVEL,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    debug: envVars.MONGODB_DEBUG,
    options: {}
  },
  chroma: {
    url: envVars.CHROMA_DB_URL,
    embeddingsCollectionPrefix: envVars.EMBEDDINGS_COLLECTION_PREFIX
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: undefined
  },
  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: false
      }
    },
    from: envVars.EMAIL_FROM
  },
  auth: {
    authTokenSecret: envVars.AUTH_TOKEN_SECRET
  },
  maxMessageLength: envVars.MAX_MESSAGE_LENGTH,
  enableDevelopmentAgents: envVars.ENABLE_DEVELOPMENT_AGENTS,
  enableDevelopmentAdapters: envVars.ENABLE_DEVELOPMENT_ADAPTERS,
  enablePublicChannelCreation: envVars.ENABLE_PUBLIC_CHANNEL_CREATION,
  enableAutoDeletion: envVars.ENABLE_AUTO_DELETION,
  enableExportOptOut: envVars.ENABLE_EXPORT_OPT_OUT,
  langsmith: {
    key: envVars.LANGSMITH_API_KEY
  },
  llms: {
    openAI: {
      key: envVars.DEFAULT_OPENAI_API_KEY,
      project: envVars.DEFAULT_OPENAI_PROJECT_ID,
      baseUrl: envVars.DEFAULT_OPENAI_BASE_URL
    },
    ollama: {
      baseUrl: envVars.OLLAMA_BASE_URL
    },
    perspectiveAPI: {
      key: envVars.PERSPECTIVE_API_KEY
    },
    bedrock: {
      key: envVars.BEDROCK_API_KEY,
      secret: envVars.BEDROCK_SECRET_ACCESS_KEY ?? 'dummy',
      baseUrl: envVars.BEDROCK_BASE_URL,
      region: envVars.BEDROCK_REGION ?? 'us-east-1'
    }
  },
  embeddings: {
    openAI: {
      key: envVars.DEFAULT_EMBEDDINGS_API_KEY || envVars.DEFAULT_OPENAI_API_KEY,
      baseUrl: envVars.DEFAULT_EMBEDDINGS_API_URL || envVars.DEFAULT_OPENAI_BASE_URL,
      documentModel: envVars.EMBEDDINGS_DOCUMENT_MODEL,
      realtimeModel: envVars.EMBEDDINGS_REALTIME_MODEL
    }
  },
  vllm: {
    baseUrl: envVars.VLLM_API_URL,
    key: envVars.VLLM_API_KEY
  },
  infinity: {
    key: envVars.INFINITY_API_KEY,
    baseUrl: envVars.INFINITY_API_KEY_API_URL
  },
  recall: {
    key: envVars.RECALL_API_KEY,
    token: envVars.RECALL_TOKEN,
    baseUrl: envVars.RECALL_BASE_URL,
    endpointBaseUrl: envVars.RECALL_ENDPOINT_BASE_URL
  },
  zoom: {
    secretToken: envVars.ZOOM_SECRET_TOKEN,
    webinarUserEmail: envVars.ZOOM_WEBINAR_USER_EMAIL
  },
  slack: {
    signingSecret: envVars.SLACK_SIGNING_SECRET
  },
  transcriptRetentionPeriod: envVars.TRANSCRIPT_RETENTION_PERIOD,
  appHost: envVars.APP_HOST,
  trulyRandomPseudonyms: envVars.TRULY_RANDOM_PSEUDONYMS,
  DAYS_FOR_GOOD_REPUTATION: envVars.DAYS_FOR_GOOD_REPUTATION
}
export default config

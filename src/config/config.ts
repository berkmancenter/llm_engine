import path from 'path'
import dotenv from 'dotenv'
import Joi from 'joi'
import { availableParallelism } from 'node:os'

const env = '.env'
dotenv.config({ path: `${process.cwd()}/${env}` })

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').allow('').optional(),
    SENTRY_DSN: Joi.string().allow('').optional(),
    PORT: Joi.number().default(3000),
    WEBSOCKET_BASE_PORT: Joi.number().default(5555),
    WEBSOCKET_MAX_PARALLELISM: Joi.number().default(availableParallelism()).description('Max parallelism for websocket use'),
    MONGODB_URL: Joi.string().required().description('Mongo DB url'),
    MONGODB_DEBUG: Joi.boolean().description('Enable mongoose debugging'),
    MONGODB_MAX_POOL_SIZE: Joi.number()
      .default(10)
      .description(
        'Max sockets per Mongoose connection. The driver defaults to 100, which is far more than one process needs — ' +
          'and this process count multiplies fast: each websocket cluster worker (see WEBSOCKET_MAX_PARALLELISM) opens ' +
          'its own independent connection, so at the default 100 a single n2d-standard-2 instance (1 primary + 2 ' +
          'workers) could open up to 300 sockets, before any horizontal scaling. Keep this deliberately small.'
      ),
    MONGODB_MIN_POOL_SIZE: Joi.number()
      .default(0)
      .description(
        'Sockets Mongoose keeps warm per connection even when idle. 0 (the driver default) is fine unless cold-start latency matters more than idle connection count.'
      ),
    ENABLE_GCP_CONNECTION_METRICS: Joi.boolean()
      .default(false)
      .description(
        'Publish a custom.googleapis.com/app/concurrent_connections Cloud Monitoring metric — the primary signal ' +
          "infra/modules/webserver-mig/autoscaler.tf's autoscaler is built around. Opt-in and off by default: only " +
          'meaningful when actually running on GCE, and even there this is only worth turning on once you intend for ' +
          'the autoscaler to use it.'
      ),
    ENABLE_DEVELOPMENT_AGENTS: Joi.boolean().default(false).description('Enable development agent support'),
    ENABLE_DEVELOPMENT_ADAPTERS: Joi.boolean().default(false).description('Enable development adapter support'),
    ENABLE_PUBLIC_CHANNEL_CREATION: Joi.boolean().default(false).description('Enable channel creation'),
    ENABLE_AUTO_DELETION: Joi.boolean().default(true).description('Enable automatic deletion of inactive topics'),
    ENABLE_EXPORT_OPT_OUT: Joi.boolean().default(true).description('Enable export opt-out functionality'),
    ENABLE_AGENT_PERSONALITY: Joi.boolean().default(false).description('Enable agent personality in prompts'),
    ENABLE_CONVERSATION_COST_TRACKING: Joi.boolean()
      .default(true)
      .description('Track and persist estimated LLM cost for every conversation on stop, independent of Number Cruncher'),
    DISABLE_POST_EVENT_ANALYSIS: Joi.boolean()
      .default(false)
      .description(
        'Skip the LLM work a conversation stop triggers (the summary call in doStopConversation and the ' +
          'conversationStopped dispatch that drives Vibes Analyst). Stop still runs normally otherwise - agents/' +
          'adapters/schedules are torn down as usual. For load-test environments, where auto-stop fires on its ' +
          'own idle timer with no one watching, independent of whether the test itself is meant to cost inference.'
      ),
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(120)
      .description('minutes after which a password reset token expires'),
    HANDOFF_TOKEN_EXPIRATION_MINUTES: Joi.number()
      .default(60)
      .description('minutes after which a Slack-to-Nextspace event-setup handoff token expires'),
    AUTH_TOKEN_SECRET: Joi.string().description('secret used to encrypt generated passwords'),
    SMTP_HOST: Joi.string().description('server that will send the emails'),
    SMTP_PORT: Joi.number().description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string().description('username for email server'),
    SMTP_PASSWORD: Joi.string().description('password for email server'),
    POSTMARK_WEBHOOK_AUTH_USER: Joi.string().description(
      'Username set on the inbound email webhook Basic Auth; the handler checks it to confirm a request came from the configured provider'
    ),
    POSTMARK_WEBHOOK_AUTH_SECRET: Joi.string().description(
      'Random secret set as the password on the inbound email webhook Basic Auth (not a human password); rotate periodically'
    ),
    EMAIL_FROM: Joi.string().description('the from field in the emails sent by the app'),
    APP_HOST: Joi.string().description('the host url for the frontend app'),
    NEXTSPACE_URL: Joi.string().description(
      'Base URL of the NextSpace frontend, used to generate links in external adapters'
    ),
    EVENT_PARTICIPANT_PATH: Joi.string()
      .default('/assistant/')
      .description("Path on APP_HOST for a participant's view of an event; override for a frontend that routes differently"),
    EVENT_MODERATOR_PATH: Joi.string()
      .default('/moderator/')
      .description("Path on APP_HOST for a moderator's view of an event; override for a frontend that routes differently"),
    TRULY_RANDOM_PSEUDONYMS: Joi.string()
      .default('false')
      .description('true/false if pseudonyms are made truly random with UID'),
    MAX_MESSAGE_LENGTH: Joi.number().min(50).max(100000).default(2000).description('The maximum length of a message'),
    DAYS_FOR_GOOD_REPUTATION: Joi.number().default(1).description('the number of days it takes to get a good reputation'),
    RAG_DOCUMENTS_PATH: Joi.string()
      .default(path.join(process.cwd(), 'rag_documents'))
      .description('Base path for RAG document storage'),
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
    GOOGLE_API_KEY: Joi.string().description('Google GenAI API key'),
    GOOGLE_BASE_URL: Joi.string().description('Google GenAI base url'),
    BEDROCK_API_KEY: Joi.string().description('Bedrock API key'),
    BEDROCK_BASE_URL: Joi.string().description('Bedrock base url'),
    RECALL_API_KEY: Joi.string().description('API Key for Recall.ai'),
    RECALL_TOKEN: Joi.string().description('Token for Recall.ai incoming webhook verification (deprecated, use secrets)'),
    RECALL_REALTIME_SECRET: Joi.string().description(
      'Verification secret for real-time endpoints (chat, join, transcript) - from API keys dashboard'
    ),
    RECALL_SVIX_SECRET: Joi.string().description(
      'Verification secret for Svix webhooks (bot.status_change) - from webhooks dashboard (legacy accounts only)'
    ),
    RECALL_BASE_URL: Joi.string().description('Base URL of Recall.ai server'),
    RECALL_ENDPOINT_BASE_URL: Joi.string().description('Base URL on this server, used by Recall.ai to invoke webhooks'),
    ZOOM_SECRET_TOKEN: Joi.string().description('Secret token from LLM Engine Zoom app'),
    ZOOM_WEBINAR_USER_EMAIL: Joi.string().description(
      'Email address to support adding agents to Zoom webinars as additional panelists'
    ),
    SLACK_SIGNING_SECRET: Joi.string().description('Signing secret from LLM Engine Slack app'),
    MATOMO_BASE_URL: Joi.string().description('Base URL of the Matomo instance, e.g. https://analytics.example.org'),
    MATOMO_TOKEN: Joi.string().description('Matomo API auth token (token_auth) used to read the Reporting API'),
    MATOMO_SITE_ID: Joi.string().description('Matomo site id whose visits hold the tracked-session data'),
    LANGSMITH_TRACING_V2: Joi.boolean().description('Enables Langsmith Tracing'),
    LANGSMITH_API_KEY: Joi.string().description('API Key for Langsmith'),
    LANGSMITH_PROJECT: Joi.string().description('LangSmith project (session) name that traces are written to and read from'),
    TRANSCRIPT_RETENTION_PERIOD: Joi.string()
      .default('3 months')
      .description('The amount of time to retain conversation transcripts'),
    VLLM_API_URL: Joi.string().description('The URL of a VLLM OpenAI-compatible server used for inference'),
    VLLM_API_KEY: Joi.string().description('The API key to access the VLLM OpenAI-compatible server used for inference'),
    INFINITY_API_URL: Joi.string().description('The URL of an Infinity OpenAI-compatible server used for inference'),
    INFINITY_API_KEY: Joi.string().description(
      'The API key to access the Infinity OpenAI-compatible server used for inference'
    ),
    CONVERSATION_BOT_NAME: Joi.string().default('Berkie').description('Default bot name for conversations'),
    CLASSIFICATION_LLM_PLATFORM: Joi.string()
      .default('bedrock')
      .description('Platform to use for classification tasks (e.g., bedrock, openai, google)'),
    CLASSIFICATION_LLM_MODEL: Joi.string().default('sonnet').description('Model to use for classification tasks'),
    CORE_LLM_PLATFORM: Joi.string()
      .default('bedrock')
      .description('Platform to use for core system LLM tasks (e.g., bedrock, openai, google)'),
    CORE_LLM_MODEL: Joi.string()
      .default('us.anthropic.claude-haiku-4-5-20251001-v1:0')
      .description('Model to use for core system LLM tasks (summaries, fun facts, etc.)'),
    IMAGE_GENERATION_LLM_MODEL: Joi.string()
      .default('gemini-3-pro-image')
      .description('Model to use for image generation tasks'),
    SEMANTIC_SCHOLAR_API_KEY: Joi.string().description('Semantic Scholar API key for agent tools'),
    TAVILY_API_KEY: Joi.string().description('Tavily API key for web search tool'),
    WEB_SEARCH_PROVIDER: Joi.string()
      .default('tavily')
      .description('Web search provider to use (e.g. tavily, brave, serpapi)'),
    BKC_ARCHIVE_API_URL: Joi.string().description('Base URL of the BKC archive-wiki API (e.g. http://localhost:4000).'),
    BKC_ARCHIVE_API_TOKEN: Joi.string().description('Bearer token for the BKC archive-wiki API'),
    CONVERSATION_AUTO_START_LEAD_TIME_MINUTES: Joi.number()
      .default(5)
      .description('Minutes before scheduledTime to auto-start a conversation'),
    CONVERSATION_AUTO_STOP_DELAY_MINUTES: Joi.number()
      .default(30)
      .description('Minutes after scheduledEndTime to auto-stop a conversation'),
    SYSTEM_USERS: Joi.string()
      .default('event-setup-bot:serviceAccount')
      .description('Comma-separated list of system accounts to create on startup, in username:role format'),
    ALLOWED_ORGANIZER_EMAIL_DOMAINS: Joi.string().description(
      'Comma-separated email domains whose senders, if they have no account yet, get a "please sign up" reply to an inbound email, calendar invite or plain on-demand email alike. A message from any other domain is rejected: no event, no reply. Unset means none, so every inbound email is silently dropped on both paths.'
    ),
    ON_DEMAND_EVENT_DURATION_MINUTES: Joi.number()
      .default(120)
      .description('Default length of an event created from a plain emailed Zoom link, when the email states no duration')
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
  sentryDsn: envVars.SENTRY_DSN,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    debug: envVars.MONGODB_DEBUG,
    options: {
      maxPoolSize: envVars.MONGODB_MAX_POOL_SIZE,
      minPoolSize: envVars.MONGODB_MIN_POOL_SIZE
    }
  },
  ragDocumentsPath: envVars.RAG_DOCUMENTS_PATH,
  chroma: {
    url: envVars.CHROMA_DB_URL,
    embeddingsCollectionPrefix: envVars.EMBEDDINGS_COLLECTION_PREFIX
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: undefined,
    handoffExpirationMinutes: envVars.HANDOFF_TOKEN_EXPIRATION_MINUTES
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
  enableGcpConnectionMetrics: envVars.ENABLE_GCP_CONNECTION_METRICS,
  enableDevelopmentAgents: envVars.ENABLE_DEVELOPMENT_AGENTS,
  enableDevelopmentAdapters: envVars.ENABLE_DEVELOPMENT_ADAPTERS,
  enablePublicChannelCreation: envVars.ENABLE_PUBLIC_CHANNEL_CREATION,
  enableAutoDeletion: envVars.ENABLE_AUTO_DELETION,
  enableExportOptOut: envVars.ENABLE_EXPORT_OPT_OUT,
  enableAgentPersonality: envVars.ENABLE_AGENT_PERSONALITY,
  enableConversationCostTracking: envVars.ENABLE_CONVERSATION_COST_TRACKING,
  disablePostEventAnalysis: envVars.DISABLE_POST_EVENT_ANALYSIS,
  langsmith: {
    tracingEnabled: Boolean(envVars.LANGSMITH_TRACING_V2),
    key: envVars.LANGSMITH_API_KEY,
    project: envVars.LANGSMITH_PROJECT
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
    },
    google: {
      key: envVars.GOOGLE_API_KEY,
      baseUrl: envVars.GOOGLE_BASE_URL
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
    realtimeSecret: envVars.RECALL_REALTIME_SECRET,
    svixSecret: envVars.RECALL_SVIX_SECRET,
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
  emailWebhook: {
    authUser: envVars.POSTMARK_WEBHOOK_AUTH_USER,
    authSecret: envVars.POSTMARK_WEBHOOK_AUTH_SECRET
  },
  matomo: {
    baseUrl: envVars.MATOMO_BASE_URL,
    token: envVars.MATOMO_TOKEN,
    siteId: envVars.MATOMO_SITE_ID
  },
  transcriptRetentionPeriod: envVars.TRANSCRIPT_RETENTION_PERIOD,
  appHost: envVars.APP_HOST,
  nextspaceUrl: envVars.NEXTSPACE_URL,
  /* Paths appended to appHost when building an event's participant and moderator links.
     The query string is llm_engine's own convention, so these two paths are the only
     part of those URLs a different frontend needs to change. */
  eventUrlPaths: {
    participant: envVars.EVENT_PARTICIPANT_PATH,
    moderator: envVars.EVENT_MODERATOR_PATH
  },
  trulyRandomPseudonyms: envVars.TRULY_RANDOM_PSEUDONYMS,
  DAYS_FOR_GOOD_REPUTATION: envVars.DAYS_FOR_GOOD_REPUTATION,
  conversationBotName: envVars.CONVERSATION_BOT_NAME,
  classificationLLMPlatform: envVars.CLASSIFICATION_LLM_PLATFORM,
  classificationLLMModel: envVars.CLASSIFICATION_LLM_MODEL,
  coreLLMPlatform: envVars.CORE_LLM_PLATFORM,
  coreLLMModel: envVars.CORE_LLM_MODEL,
  imageGenerationLLMModel: envVars.IMAGE_GENERATION_LLM_MODEL,
  semanticScholar: {
    apiKey: envVars.SEMANTIC_SCHOLAR_API_KEY
  },
  tavily: {
    apiKey: envVars.TAVILY_API_KEY
  },
  bkcArchive: {
    apiUrl: envVars.BKC_ARCHIVE_API_URL,
    apiToken: envVars.BKC_ARCHIVE_API_TOKEN
  },
  webSearchProvider: envVars.WEB_SEARCH_PROVIDER,
  conversation: {
    autoStartLeadTimeMs: envVars.CONVERSATION_AUTO_START_LEAD_TIME_MINUTES * 60 * 1000,
    autoStopDelayMs: envVars.CONVERSATION_AUTO_STOP_DELAY_MINUTES * 60 * 1000
  },
  systemUsers: envVars.SYSTEM_USERS.split(',').map((entry: string) => {
    const [username, role] = entry.trim().split(':')
    return { username, role }
  }),
  allowedOrganizerEmailDomains: (envVars.ALLOWED_ORGANIZER_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain: string) => domain.trim().toLowerCase())
    .filter((domain: string) => domain.length > 0),
  onDemandEventDurationMinutes: envVars.ON_DEMAND_EVENT_DURATION_MINUTES
}
export default config

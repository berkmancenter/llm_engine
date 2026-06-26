# Installing LLM Engine

## Configuration

Configuration is done with an environment variables file. Copy `.env.example` to create your `.env` file.

## Running locally

1. Start by copying `.env.example` to `.env`.
2. Install `mongodb` ([ubuntu 24 server](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/))
3. Run MongoDB with `mongod`
   > 💡 **Note:** Mac users who have used Homebrew to install MongoDB should use the command `brew services start mongodb-community` to run the MongoDB service instead.
4. Install `node.js` and set to a version specified in `package.json` file (Consider using [nvm](https://github.com/nvm-sh/nvm))
5. Install [yarn](https://classic.yarnpkg.com/lang/en/docs/install)
6. Install all dependencies with `yarn install`.
7. Run `yarn run dev` to serve the API locally.

## LLM Model selection

LLM Engine supports a range of LLM platforms.

### OpenAI

1. Configure `DEFAULT_OPENAI_API_KEY` and `DEFAULT_OPENAI_BASE_URL` in your `.env` file.
2. When creating a Conversation with an Agent, specify `llmPlatform` to be `openai` and `llmModel` to be an available OpenAI model.

Note that this will work for any OpenAI compatible LLM provider.

### AWS Bedrock (including Claude)

1. Configure `BEDROCK_API_KEY` and `BEDROCK_BASE_URL` in your `.env` file.
2. When creating a Conversation with an Agent, specify `llmPlatform` to be `bedrock` and `llmModel` to be an available Bedrock model.

Set `BEDROCK_BASE_URL` to the endpoint up to (but not including) the `/model` path segment. LLM Engine appends the standard Amazon Bedrock InvokeModel path, so each request goes to `{BEDROCK_BASE_URL}/model/{llmModel}/invoke`. Point it at the Amazon Bedrock runtime host or any gateway that fronts it.

Authentication sends `BEDROCK_API_KEY` as an `x-api-key` header, which assumes a gateway that signs the upstream AWS request for you. To call Amazon Bedrock directly (AWS requires SigV4-signed requests), replace the transport in `src/agents/helpers/bedrockGateway.ts`, or use LangChain's BedrockChat with AWS credentials instead.

### Google Generative AI (including Gemini)

1. Configure `GOOGLE_API_KEY` and `GOOGLE_BASE_URL` in your `.env` file.
2. When creating a Conversation with an Agent, specify `llmPlatform` to be `google` and `llmModel` to be an available Google generative AI model.

### Open Source Models via vLLM

Open source models are available through [vLLM](https://docs.vllm.ai/en/latest/) running locally or on one of two hosted serverless providers:

- [Runpod](https://runpod.io) - See detailed instruction for setup in our [runpod guide](runpod.md).
- [Modal](https://modal.com) - See detailed instructions for setup in our [modal guide](modal.md).
- [Local vLLM](https://docs.vllm.ai/en/stable/getting_started/installation/index.html) - Follow their setup guide.

1. Configure `VLLM_API_KEY` and `VLLM_BASE_URL` in your `.env` file.
2. When creating a Conversation with an Agent, specify `llmPlatform` to be `vllm` and `llmModel` to be an available [open source model supported by vllm](https://docs.vllm.ai/en/stable/models/supported_models.html).

### Open Source Models via Ollama

Open source models are also available through [Ollama](https://ollama.com) running locally.

1. [Install Ollama](https://docs.ollama.com/) locally.
2. Configure `OLLAMA_BASE_URL`
3. When creating a Conversation with an Agent, specify `llmPlatform` to be `ollama` and `llmModel` to be an available [open source model supported by ollama](https://ollama.com/search).

## System accounts

LLM Engine creates system accounts for bots and services on startup, driven by the `SYSTEM_USERS` env var. Each entry is a `username:role` pair, comma-separated:

```
SYSTEM_USERS=event-setup-bot:serviceAccount,another-bot:serviceAccount
```

Out of the box this creates `event-setup-bot` with the `serviceAccount` role, which the event setup agent uses to list and create topics. To add another account, append an entry and restart. The server skips accounts that already exist.

Available roles: `user`, `admin`, `serviceAccount`.

## Optional: Retrieval Augmented Generation

If you would like to make use of Retrieval Augmented Generation (RAG) see our [rag guide](rag.md).

## Optional: Nextspace integration

If you would like to use LLM Engine with the Nextspace client, see our [nextspace guide](../platforms/nextspace.md).

## Optional: Zoom integration

If you would like to use LLM Engine with Zoom, see our [zoom guide](../platforms/zoom.md).

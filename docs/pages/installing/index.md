# Installing LLM Engine

## Configuration

Configuration is done with an environment variables file. Copy `.env.example` to create your `.env` file.

## Using Docker

- Create file `.env` and copy contents of `.env.example`. Feel free to change the port number in the file but make sure to make changes on fronend env file to reflect the correct port number. Also, if you change the port number, make sure to change the port numbers in `docker-compose.yml` as well. Certain optional app functionality, like polls and LLM agents can be enabled or disabled with environment variables.
- Edit `docker-compose.dev.yml` file to add the following block to the `node-app` service

```
    env_file:
      - .env
```

the full block should then look like this:

```
services:
  node-app:
    env_file:
      - .env

```

- Run below docker compose command to start the server

```
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

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

## Optional: Retrieval Augmented Generation

If you would like to make use of Retrieval Augmented Generation (RAG) see our [rag guide](rag.md).

## Optional: Nextspace integration

If you would like to use LLM Engine with the Nextspace client, see our [nextspace guide](../platforms/nextspace.md).

## Optional: Zoom integration

If you would like to use LLM Engine with Zoom, see our [zoom guide](../platforms/zoom.md).

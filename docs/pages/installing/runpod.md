# Runpod model serving

## Overview

We support usng Runpod.io to host open source models on a [vLLM](https://docs.vllm.ai/en/latest/) container. In particular, we host a [serverless endpoint](https://www.runpod.io/product/serverless) running a [vLLM](https://docs.vllm.ai/en/latest/) container provided by a standard [template](https://docs.runpod.io/serverless/vllm/get-started).

vLLM is attractive because it provides an OpenAI compatible API for all models it supports. That allows us to use the standard OpenAI classes of LangChain.

## Prerequisites

1. A runpod.io account
2. A credit card attached to the account
3. Also create a [HuggingFace](https://huggingface.co) account
4. Accept license terms for an open model you plan to use on HuggingFace
5. Generate an API token on HuggingFace, which will be used to pull models

## Billing

You attach a credit card and pre-pay for a certain value of credits. You can enable or disable automatic renewals when the balance drops below a certain level, but be careful of this to avoid surprise bills!

## Serverless Configuration

### Models and Endpoints

Right now, each different model you want to use will require configuring a different endpoint. THe vLLM templates provided by Runpod support only one model at a time. vLLM itself can support multiple models, but to use that functionality you would need to setup your own template.

### Setup steps

1. Create a new [serverless endpoint](https://console.runpod.io/serverless) and select the latest vLLM template.
2. Specify a model from those [supported](https://docs.vllm.ai/en/stable/models/supported_models.html) and set your HuggingFace token. (Make sure you have acceepted the model terms first!)
3. Select a data center that has a good supply of the GPUs you prefer to use. Look for "PRO" GPUs which will be more reliable. Select only that data center.
4. Create a [network volume](https://docs.runpod.io/serverless/storage/network-volumes) in that data of sufficient size to hold the model and other vLLM files.
5. Ensure the vLLM environment variables have `BASE_PATH=/runpod-volume` set so that the volume is used for storing the models.
6. Attach that network volume to your endpoint, so that once the model is download, it does not need to be downloaded again. This will reduce cold start times.
7. Generate a runpod API token
8. Configure the vLLM variables in our .env file accordingly

```
VLLM_API_URL=https://api.runpod.ai/v2/{endpointId}/openai/v1
VLLM_API_KEY={token}
```

### Cold starts and Scaling

A serverless endpoint allows us to set up scale up and scale down efficiently and cost effectively. We scale down to 0 when not in use. THe endpoint queues requests automatically.

When an endpoint is "idle" it will need to cold start. This seems to take about 2 minutes. As a result you may want to send a "wake up" request when first starting an agent conversation to get an endpoint worker ready. Our code can do this (see the `llmPlatforms` configuration data in the `getModelChat` file, specifically the `useKeepAlive` value). We also issue a wake up ping before starting test runs against runpod.

Once the worker is running, then requests will be queued and processed immediately.

Runpod also has a "FastBoot" option which can bring most cold start requests down to a couple seconds. But this depends on competition for FastBoot caching on runpod and may be higher at times.

Our initial scaling configuration:
* Max workers: 5
* Active workers: 0
* GPU count: 1
* Idle timeout: 120 sec
* Execution timeout (of one request): 600 sec
* Enable Flashboot: YES! Makes cold starts much faster
* Model: mistralai/Mistral-7B-Instruct-v0.3
* Queue delay: 15 secs (A new worker will be created if allowed when a request is in queue longer than this)

Environment variables:
* MAX_CONCURRENCY=8
* GPU_MEMORY_UTILIZATION=0.90

Note: This may be insufficient for large events or events with frequent LLM calls. In that case, add workers.

Note: If you update the endpoint, delete "outdated" workers using the Runpod.io console.

## Sanity Testing

You can use curl to test your endpoint's OpenAI compatible API. Adjust the `ENDPOINT_ID` and `VLLM_API_KEY` and model accordingly. Just remember the first request may take a while while the endpoint is brought online.

```
curl -X POST https://api.runpod.ai/v2/ENDPOINT_ID/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer VLLM_API_KEY' \
  -d '{
    "model": "mistralai/Mistral-7B-Instruct-v0.3",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'

```

## Keep Alive?

We have not yet implemented keep alive pings during the duration of a conversation. That would be an alternative to setting a long idle timeout. Managing the pings to run only when any conversation is running could be done, but would take a little work. With FastBoot and a reasonable idle timeout, hopefully that is not needed.

## Embeddings

You can use Runpod to host embeddings as well using the official [Infinity Embeddings](https://github.com/runpod-workers/worker-infinity-embedding) serverless template.

A 16 GB GPU should be sufficient. As with vllm hosting, you will improve latency if you attach network storage.

We have used:
* Max workers: 1 (or 2)
* Idle timeout: 120 sec
* Enable Flashboot
* Execution timeout (of one request): 600 sec
* Model: `AAI/bge-small-en-v1.5`

With environment variables:
```
RUNPOD_MAX_CONCURRENCY = 50
```




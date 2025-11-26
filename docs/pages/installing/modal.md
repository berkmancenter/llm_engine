# Modal model serving

## Overview

We support usng [Modal](http://modal.com) to host open source models on a [vLLM](https://docs.vllm.ai/en/latest/) container, served as a web endpoint.

vLLM is attractive because it provides an OpenAI compatible API for all models it supports. That allows us to use the standard OpenAI classes of LangChain.

## Prerequisites

1. A Modal.com account
2. Modal CLI installed (`pip install modal`)
3. Modal CLI authenticated (`modal setup` or `python -m modal setup` to generate a token)

## Billing

You sign up for a plan that gives you a certain dollar amount of included credits per month. You can (and should!) set a maximum monthly budget for pay-as-you-go once you exceed the allowable credits in a month.

## Serverless Configuration

Modal is a cloud function platform that provides full serverless execution by allowing you to serve functions as web endpoints. Everything is defined and configured in code and deployed via command line. Therefore, you will need code to select a container image, download a model, and configure, build and serve vLLM. We use a sample Python script provided by Modal for this in the setup steps below.

### Models and Endpoints

Right now, each different model you want to use will require configuring a different Modal function (and possibly App).

### Setup steps

To get up and running quickly, we will follow [this example](https://modal.com/docs/examples/vllm_inference) from Modal to deploy an OpenAI-compatible LLM service with vLLM and the RedHatAI/Meta-Llama-3.1-8B-Instruct-FP8 model. Please consult the example page for details.

1. Clone the modal examples repository and deploy the vLLM server (NOTE: this creates an unsecure endpoint by default. See Modal documentation for details on how to modify the script to secure the endpoint)

```
$ git clone https://github.com/modal-labs/modal-examples
$ cd modal-examples/06_gpu_and_ml/llm-serving/
$ modal deploy vllm_inference.py
```

2. Navigate to the Modal URL provided by the script and verify your function is up.
3. Configure the vLLM variables in our .env file accordingly to connect

```
VLLM_API_URL=https://{prefix}--example-vllm-inference-serve.modal.run/v1
# if using the default function with no security
VLLM_API_KEY='dummy'
```

### Cold starts and Scaling

Modal performs auto-scaling of functions. They scale down to 0 when not in use (default idle timeout is 15 minutes).

When an endpoint is "idle" it will need to cold start. This seems to take about 90 seconds with the example vLLM server. As a result you may want to send a "wake up" request when first starting an agent conversation to get the endpoint ready. Our code can do this (see the `llmPlatforms` configuration data in the `getModelChat` file, specifically the `useKeepAlive` value). We also issue a wake up ping before starting test runs against a vLLM platform.

See [Modal documentation](https://modal.com/docs/guide/cold-start) for additional tips on optimizing cold start time.

## Sanity Testing

You can use curl to test your endpoint's OpenAI compatible API. Adjust the `PREFIX` and `VLLM_API_KEY` and model accordingly. Just remember the first request may take a while while the endpoint is brought online.

```

curl -X POST https://{PREFIX}--example-vllm-inference-serve.modal.run/v1/chat/completions \
 -H 'Content-Type: application/json' \
 -H 'Authorization: Bearer VLLM_API_KEY' \
 -d '{
"model": "RedHatAI/Meta-Llama-3.1-8B-Instruct-FP8",
"messages": [
{"role": "user", "content": "Hello, how are you?"}
]
}'

```

## Keep Alive?

We have not yet implemented keep alive pings during the duration of a conversation. That would be an alternative to setting a long idle timeout. Managing the pings to run only when any conversation is running could be done, but would take a little work.

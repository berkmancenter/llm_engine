## Optional: Set up Chroma to use RAG

We use Chroma as the vector store. If you are using RAG, you can start Chroma using a Docker Container. _NOTE_ We are currently compatible only with Chroma 0.6.3. You must use that version.

```
docker pull chromadb/chroma
docker run -p 8000:8000 chromadb/chroma:0.6.3
```

If you wish to investigate running Chroma in the cloud, see [Chroma documentation](https://docs.trychroma.com/production/deployment) for further details.

### Setting an embeddings provider

You may specify an OpenAI compatible embeddings provider using these environment variables:
```
EMBEDDINGS_API_URL=
EMBEDDINGS_API_KEY=
EMBEDDINGS_DOCUMENT_MODEL=
EMBEDDINGS_REALTIME_MODEL=
```

If you don't provide them, a standard OpenAI embeddings model will be used.

You can use these settings to set up a private, open source embeddings model if you wish.

We have tested this with the `AAI/bge-small-en-v1.5` embeddings model using [Infinity](https://github.com/michaelfeil/infinity) hosted on Runpod.io.

Please see [Runpod instruction](./runpod.md) for more information.

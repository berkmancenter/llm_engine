/* eslint-disable no-console */
import dotenv from 'dotenv'
import axios from 'axios'
// relative imports do not work as expected in this file

dotenv.config({ path: `${process.cwd()}/.env` })

async function pingVllm() {
  const { TEST_LLM_PLATFORM, TEST_LLM_MODEL, VLLM_API_URL, VLLM_API_KEY } = process.env

  if (TEST_LLM_PLATFORM === 'vllm') {
    if (!TEST_LLM_PLATFORM || !TEST_LLM_MODEL || !VLLM_API_URL || !VLLM_API_KEY)
      throw new Error('Missing required vLLM environment variables')

    console.log(`Waiting for vLLM server endpoint ${VLLM_API_URL} to be ready. This may take a couple minutes...`)

    const url = `${VLLM_API_URL}/chat/completions`

    try {
      await axios.post(
        url,
        {
          model: TEST_LLM_MODEL,
          messages: [{ role: 'user', content: 'Respond "OK"' }]
        },
        {
          headers: {
            Authorization: `Bearer ${VLLM_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      )
    } catch (error) {
      console.error('Error calling vLLM:', error.response ? error.response.data : error.message)
      throw error
    }

    console.log('vLLM Server is ready for tests. Continuing...')
  }
}

async function pingEmbeddings() {
  const { EMBEDDINGS_API_KEY, EMBEDDINGS_API_URL, EMBEDDINGS_REALTIME_MODEL } = process.env

  // skip if not set
  if (!EMBEDDINGS_API_URL) return

  console.log(`Waiting for embeddings server endpoint ${EMBEDDINGS_API_URL} to be ready. This may take a couple minutes...`)

  const url = `${EMBEDDINGS_API_URL}/embeddings`

  try {
    await axios.post(
      url,
      {
        model: EMBEDDINGS_REALTIME_MODEL,
        input: ['Hello, world!', 'How are you?']
      },
      {
        headers: {
          Authorization: `Bearer ${EMBEDDINGS_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    )
  } catch (error) {
    console.error('Error calling embeddings server:', error.response ? error.response.data : error.message)
    throw error
  }

  console.log('Embeddings server is ready for tests. Continuing...')
}

export default async () => {
  await Promise.all([pingVllm(), pingEmbeddings()])
}

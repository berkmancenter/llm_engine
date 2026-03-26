import logger from '../../config/logger.js'
import { getGoogleImageModel, imageGenerationLLMModel } from '../helpers/getModelChat.js'

export interface ImageGenerationResult {
  success: boolean
  imageData?: string // Base64-encoded image data
  mimeType?: string // MIME type of the image (e.g., 'image/png', 'image/jpeg')
  error?: string
}

function buildImagePrompt(textContent: string, context?: string): string {
  let prompt = `You are creating a visual aid to help someone understand information from a live event.

Create a clear, informative diagram or illustration that visually represents this answer:

${textContent}`

  if (context) {
    prompt += `\n\nContext from the event:
${context.substring(0, 500)}` // Limit context to avoid overwhelming the prompt
  }

  prompt += `\n\nGuidelines for the visual:
- Create a diagram, illustration, chart, or infographic that makes the concept clear
- If the answer describes a process, show it as a flow or timeline
- If the answer includes comparisons, show them side-by-side or in a chart
- Keep it simple and minimal - avoid elaborate designs
- Use clean, basic shapes and limited colors
- Focus only on the most essential information
- Use minimal text with clear labels
- Prioritize clarity over visual complexity
- Professional and easy to read at a glance`

  return prompt
}

/**
 * Generate an image representation of text content using Gemini 3 Pro Image Preview model.
 * @param textContent - The text content to visualize
 * @param context - Optional context for better image generation
 * @returns ImageGenerationResult with base64 image data or error
 */
export async function generateVisualResponse(
  textContent: string,
  context?: string,
  modelName?: string
): Promise<ImageGenerationResult> {
  try {
    const prompt = buildImagePrompt(textContent, context)

    const model = getGoogleImageModel(modelName || imageGenerationLLMModel)

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: prompt
            }
          ]
        }
      ]
    })

    // Iterate over parts to find the inline image data
    const parts = result.response.candidates?.[0]?.content?.parts ?? []
    let base64ImageData: string | undefined
    let mimeType: string | undefined

    for (const part of parts) {
      if (part.text) {
        logger.debug('Image generation included text response:', part.text)
      } else if (part.inlineData?.data) {
        base64ImageData = part.inlineData.data
        mimeType = part.inlineData.mimeType
        logger.debug(`Image generation successful - received ${mimeType || 'unknown type'} data`)
      }
    }

    if (!base64ImageData) {
      return {
        success: false,
        error: 'No image data returned from model'
      }
    }

    return {
      success: true,
      imageData: base64ImageData,
      mimeType
    }
  } catch (error) {
    logger.error(`Image generation failed: ${error.message}`, { error })
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Helper function to generate an image response for a message
 * @param userMessage - The message to generate an image for
 *   Expects structured body: { sourceMessage, answer, responseChannels }
 * @param conversation - The conversation context
 * @param llmModel - The LLM model to use for image generation
 * @returns AgentResponse with the generated image
 */
export default async function generateImageResponse(userMessage, conversation, llmModel?: string) {
  // Extract ID of original question, text answer, and response channels
  const { sourceMessage, answer, responseChannels: channelNames, parent } = userMessage.body

  // Generate the image using the configured model
  const imageResult = await generateVisualResponse(answer, undefined, llmModel || imageGenerationLLMModel)

  if (!imageResult.success) {
    logger.error(`Image generation failed: ${imageResult.error}`)
    return null
  }

  // Use the channel names from the message body (original userMessage channels)
  const responseChannels = conversation.channels.filter((channel) => channelNames?.includes(channel.name))

  return {
    visible: true,
    message: {
      media: [
        {
          type: 'image',
          data: imageResult.imageData,
          mimeType: imageResult.mimeType || 'image/png'
        }
      ],
      sourceMessage
    },
    messageType: 'multimodal',
    channels: responseChannels,
    parent
  }
}

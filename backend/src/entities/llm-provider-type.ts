/**
 * The inference vendors almyty can call.
 *
 * Lives in its own module rather than on the entity so that
 * `modules/llm-providers/provider-profile.ts` can describe a vendor
 * without importing the entity, which would be a runtime import cycle:
 * the entity reads the profile registry, and a partially initialised
 * enum would leave every profile keyed by undefined.
 *
 * Re-exported from `llm-provider.entity` so existing imports keep working.
 */
export enum LlmProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  MISTRAL = 'mistral',
  XAI = 'xai',
  DEEPSEEK = 'deepseek',
  GROQ = 'groq',
  TOGETHER = 'together',
  OPENROUTER = 'openrouter',
  AZURE_OPENAI = 'azure_openai',
  AWS_BEDROCK = 'aws_bedrock',
  COHERE = 'cohere',
  HUGGINGFACE = 'huggingface',
  OLLAMA = 'ollama',
  // OpenAI-compatible inference hosts (chat, streaming and tool calling
  // ride the OpenAI dispatch path). Details per vendor in
  // docs/design/call-only-vendors.md.
  FIREWORKS = 'fireworks',
  CEREBRAS = 'cerebras',
  DEEPINFRA = 'deepinfra',
  NOVITA = 'novita',
  PERPLEXITY = 'perplexity',
  ZAI = 'zai',
  BASETEN = 'baseten',
  NEBIUS = 'nebius',
  SAMBANOVA = 'sambanova',
  // First-party model families a customer names by brand. Both are
  // OpenAI-compatible and both run separate international and mainland
  // China endpoints whose API keys are NOT interchangeable; the default is
  // the international one and the other is reachable via apiUrl.
  MOONSHOT = 'moonshot',
  QWEN = 'qwen',
  MINIMAX = 'minimax',
  UPSTAGE = 'upstage',
  // Writer is OpenAI-shaped in body but not in path: chat is POST /v1/chat,
  // and its model list is {models:[{id,name}]} where name is a display
  // label. It gets its own dispatch for both reasons.
  WRITER = 'writer',
  // Chinese vendors, on the plain-bearer OpenAI-compatible surface each now
  // publishes alongside its signed legacy API. None needs a request
  // signature on the surface we call. Verified 2026-09-10.
  QIANFAN = 'qianfan',
  HUNYUAN = 'hunyuan',
  VOLCENGINE = 'volcengine',
  // iFlytek Spark. Its model generations sit on different bases and the
  // current two share the model id `spark-x`, so the generation is a
  // required field driving the base rather than something to guess.
  SPARK = 'spark',
  // The customer's own cloud, as a CALL target rather than a deployment
  // target. Each is a distinct product from the neighbouring type it is
  // easily confused with: vertex_ai is not the Gemini Developer API
  // (`google`), and azure_ai_foundry is not Azure OpenAI.
  VERTEX_AI = 'vertex_ai',
  AZURE_AI_FOUNDRY = 'azure_ai_foundry',
  // Vendor serverless inference we can call without deploying anything.
  DIGITALOCEAN = 'digitalocean',
  RUNPOD = 'runpod',
  MODAL = 'modal',
  CUSTOM = 'custom',
}

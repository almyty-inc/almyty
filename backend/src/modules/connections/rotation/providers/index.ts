import { ConnectorRotation, RotationHttp } from '../rotation.interface';
import { AnthropicRotation } from './anthropic.rotation';
import { AwsRotation } from './aws.rotation';
import { AzureRotation } from './azure.rotation';
import { BasetenRotation } from './baseten.rotation';
import { FireworksRotation } from './fireworks.rotation';
import { GcpRotation } from './gcp.rotation';
import { HuggingFaceRotation } from './huggingface.rotation';
import { MistralRotation } from './mistral.rotation';
import { OpenAiRotation } from './openai.rotation';
import { OpenRouterRotation } from './openrouter.rotation';
import { PerplexityRotation } from './perplexity.rotation';
import { XaiRotation } from './xai.rotation';

/**
 * Every built-in rotation provider, one per connector key that has a
 * verified key-management API. Connectors missing here (Google Gemini,
 * Groq, Together, DeepSeek, Cohere, Cerebras, DeepInfra, Novita, Z.ai,
 * Nebius, SambaNova, Ollama, Modal, RunPod, DigitalOcean, the S3
 * registry) rotate manually: docs/design/connections-rotation.md.
 */
export function builtInRotations(http: RotationHttp): ConnectorRotation[] {
  return [
    new OpenRouterRotation(http),
    new OpenAiRotation(http),
    new AnthropicRotation(http),
    new HuggingFaceRotation(http, 'huggingface'),
    new HuggingFaceRotation(http, 'registry-huggingface'),
    new AwsRotation(http),
    new GcpRotation(http),
    new AzureRotation(http),
    new XaiRotation(http),
    new MistralRotation(http),
    new FireworksRotation(http),
    new PerplexityRotation(http),
    new BasetenRotation(http),
  ];
}

export {
  AnthropicRotation, AwsRotation, AzureRotation, BasetenRotation, FireworksRotation, GcpRotation,
  HuggingFaceRotation, MistralRotation, OpenAiRotation, OpenRouterRotation, PerplexityRotation, XaiRotation,
};
